// Cloudflare Worker cron for scheduled agent jobs.
//
// On its Cron Trigger it becomes the always-on scheduler: for each configured agent it reads the jobs
// from that agent's on-chain memory, runs the due ones through Hero Run, and checkpoints each result
// back on-chain. Jobs you schedule from the memory graph (herorunai.com/memory-graph) or the CLI are
// exactly what this runs. Idempotent + interval-gated, so it's safe to fire as often as you like.
//
// Secrets (wrangler secret put): AGENT_PRIVATE_KEY (a funded RH wallet that owns the agents),
//   HERO_RUN_KEY (pays for the task inference), RUN_SECRET (bearer for the manual /run endpoint).
// Vars (wrangler.jsonc): AGENT_IDS ("3,6"), HERO_MEM_ADDR, RH_RPC, HERO_BASE.
import { WorkerMemory } from "./memory.mjs";
import { runDue } from "../src/jobs.mjs";
import { runTwapTick, parseTwapPlans, planComplete } from "./twap.mjs";
import { runHeroModeTick } from "./heromode.mjs";
import { runSwarmTick } from "./swarm.mjs";
import { pollKeeper } from "./keeper.mjs";

// Tracing. Structured, content-free spans (timings, counts, model, cost — never prompt or result text,
// which is encrypted). Emitted as one-line JSON so Cloudflare's Workers Observability (enabled in
// wrangler.jsonc) indexes and lets you query them; the gen_ai.* keys follow OTel's GenAI convention so
// the same events export cleanly if you later add an OTel sink. Correlated by a per-tick trace id.
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
function tracer(traceId) {
  return (name, attrs = {}) => { try { console.log(JSON.stringify({ span: name, trace_id: traceId, ...attrs })); } catch {} };
}

// The brain: one chat completion through Hero Run's OpenAI-compatible /v1, paid in $HERO. Emits an
// llm.call span with latency, token usage, resolved model, and $HERO charged when a tracer is given.
function makeChat(env, trace) {
  return async ({ model = "auto", messages, maxTokens = 600, tools = null, tool_choice = null }) => {
    const t0 = nowMs();
    const r = await fetch(`${env.HERO_BASE || "https://herorunai.com"}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.HERO_RUN_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, ...(tools?.length ? { tools, tool_choice: tool_choice || "auto" } : {}) }),
    });
    const d = await r.json().catch(() => ({}));
    const ms = Math.round(nowMs() - t0);
    if (!r.ok || d.error) {
      trace?.("llm.call", { ok: false, ms, "gen_ai.request.model": model, http: r.status });
      throw new Error(`Hero Run ${r.status}: ${d.error?.message || d.error || ""}`);
    }
    const hero = d.x_hero || d.hero || {};
    trace?.("llm.call", {
      ok: true, ms,
      "gen_ai.request.model": model,
      "gen_ai.response.model": hero.resolved_model || d.model || null,
      gateway: hero.gateway || null,
      "gen_ai.usage.input_tokens": d.usage?.prompt_tokens ?? null,
      "gen_ai.usage.output_tokens": d.usage?.completion_tokens ?? null,
      charged_hero: hero.charged_hero ?? null,
    });
    // `message` carries tool_calls; `content` is kept so every existing caller is untouched.
    const message = d.choices?.[0]?.message || {};
    return { content: message.content || "", message };
  };
}

// Service one agent: run its scheduled jobs (if a chat/HERO_RUN_KEY is available) and its durable
// TWAP chunk, spending from `privateKey`. Returns the mem so the caller can check plan completion.
async function serviceAgent(env, { agentId, privateKey, chat, trace, log }) {
  const mem = new WorkerMemory({ agentId, privateKey, memAddr: env.HERO_MEM_ADDR, rpc: env.RH_RPC });
  let jobs = { ran: 0, due: 0, defined: 0 };
  if (chat) { jobs = await runDue(mem, { chat, onLog: (m) => log(`[agent ${agentId}] ${m}`), onSpan: (s) => trace(s.name, { agent: agentId, ...s }) }); }
  try {
    const tw = await runTwapTick(mem, { privateKey, holdMin: Number(env.HERO_TWAP_MIN ?? 1_000_000), rhRpc: env.RH_RPC, baseRpc: env.BASE_RPC, log: (m) => log(`[agent ${agentId}] ${m}`) });
    if (tw.acted) trace("twap.chunk", { agent: agentId });
  } catch (e) { log(`[agent ${agentId}] twap ERROR ${e.message}`); }
  // Durable Hero Mode: drive one sealed-run step per tick, paid through this worker's HERO_RUN_KEY
  // (a no-op without one, exactly like scheduled jobs).
  let heromode = null;
  try {
    heromode = await runHeroModeTick(mem, { chat, log: (m) => log(`[agent ${agentId}] ${m}`) });
    if (heromode?.acted) trace("heromode.step", { agent: agentId });
  } catch (e) { log(`[agent ${agentId}] heromode ERROR ${e.message}`); }
  // Swarm lane: if this agent holds an unanswered task:: brief, execute it (one paid call) and
  // record the handoff:: that swarm_collect reads. Errors are logged, not rethrown — the attempt
  // marker is already on-chain, so the cap still counts a crashed try.
  try {
    const sw = await runSwarmTick(mem, { chat, log: (m) => log(`[agent ${agentId}] ${m}`) });
    if (sw?.acted) trace("swarm.step", { agent: agentId, reason: sw.reason });
  } catch (e) { log(`[agent ${agentId}] swarm ERROR ${e.message}`); }
  return { mem, jobs, heromode };
}

// Agents owned by the operator wallet, read from the chain. AGENT_IDS alone cannot serve a swarm:
// swarm_spawn mints new agents at runtime, and nobody is going to redeploy the worker with a new
// env var every time a swarm spins up. NOT via eth_getLogs — Robinhood Chain caps the range and
// returns EMPTY rather than erroring, which reads as "no agents" (that bug has bitten twice now).
// nextId() bounds the walk; ownerOf() is authoritative.
async function discoverOwnedAgents(env, address) {
  const rpc = env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
  const memAddr = env.HERO_MEM_ADDR || "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";
  const call = async (data) => {
    const r = await fetch(rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: memAddr, data }, "latest"] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };
  const total = Number(BigInt(await call("0x61b8ce8c"))) - 1; // nextId()
  const want = address.toLowerCase();
  const owned = [];
  for (let start = 1; start <= total; start += 10) {
    const batch = [];
    for (let id = start; id < Math.min(start + 10, total + 1); id++) {
      batch.push(call("0x6352211e" + BigInt(id).toString(16).padStart(64, "0")) // ownerOf(id)
        .then((r) => ("0x" + r.slice(-40) === want ? id : null)).catch(() => null));
    }
    owned.push(...(await Promise.all(batch)).filter((x) => x !== null));
  }
  return owned;
}

async function tick(env, log = console.log, traceId) {
  const trace = tracer(traceId || `tick-${Math.random().toString(36).slice(2, 10)}`);
  const t0 = nowMs();
  const selfHosted = env.AGENT_PRIVATE_KEY && String(env.AGENT_IDS || "").trim();
  const shared = env.REGISTRY_URL && env.WORKER_SECRET;
  if (!selfHosted && !shared) { log("nothing configured (need AGENT_IDS+AGENT_PRIVATE_KEY, or REGISTRY_URL+WORKER_SECRET)"); return { serviced: 0 }; }
  // HERO_RUN_KEY only powers scheduled LLM jobs; TWAP runs without it.
  const chat = env.HERO_RUN_KEY ? makeChat(env, trace) : null;
  let serviced = 0, errors = 0;
  const per = [];

  // 1) Self-hosted: agents you own, one operator key (AGENT_IDS + AGENT_PRIVATE_KEY).
  if (selfHosted) {
    let ids = String(env.AGENT_IDS).split(",").map((s) => s.trim()).filter(Boolean);
    // AGENT_DISCOVER=1 additionally services every agent the operator wallet owns on-chain — the
    // switch that makes swarms autonomous, since swarm_spawn mints agents no env var knows about.
    // OPT-IN because it changes what this worker spends money on: with it, minting an agent IS
    // enrolling it. Never replaces AGENT_IDS (a transferred-away agent should still stop, and the
    // env list is the operator's explicit floor).
    if (env.AGENT_DISCOVER === "1") {
      try {
        const { privateKeyToAccount } = await import("viem/accounts");
        const addr = privateKeyToAccount(env.AGENT_PRIVATE_KEY.startsWith("0x") ? env.AGENT_PRIVATE_KEY : "0x" + env.AGENT_PRIVATE_KEY).address;
        const found = await discoverOwnedAgents(env, addr);
        const merged = [...new Set([...ids.map(Number), ...found])].sort((a, b) => a - b);
        if (merged.length !== ids.length) log(`discovery: +${merged.length - ids.length} agent(s) beyond AGENT_IDS`);
        ids = merged.map(String);
      } catch (e) { log(`discovery ERROR ${e.message} — continuing with AGENT_IDS only`); }
    }
    for (const id of ids) {
      try { const { jobs } = await serviceAgent(env, { agentId: id, privateKey: env.AGENT_PRIVATE_KEY, chat, trace, log }); serviced++; per.push({ agent: id, mode: "self", ...jobs }); }
      catch (e) { errors++; log(`[agent ${id}] ERROR ${e.message}`); trace("agent.error", { agent: id, message: e.message }); }
    }
  }

  // 2) Shared "run it for me": fetch every registered plan and run each with ITS OWN scoped session
  //    key (never a shared key). Deregister a plan once every chunk is filled or it halted.
  if (shared) {
    let plans = [];
    try {
      const r = await fetch(`${env.REGISTRY_URL}/api/twap/active`, { headers: { Authorization: `Bearer ${env.WORKER_SECRET}` } });
      const d = await r.json().catch(() => ({}));
      plans = Array.isArray(d.plans) ? d.plans : [];
      log(`registry: ${plans.length} shared plan(s)`);
    } catch (e) { log(`registry fetch error: ${e.message}`); }
    for (const p of plans) {
      try {
        const { mem } = await serviceAgent(env, { agentId: p.agentId, privateKey: p.sessionKey, chat: null, trace, log });
        serviced++; per.push({ agent: p.agentId, mode: "shared" });
        const { plans: pl, runs } = parseTwapPlans(await mem.raw().catch(() => []));
        const plan = [...pl.values()][0];
        if (plan && planComplete(plan, runs)) {
          await fetch(`${env.REGISTRY_URL}/api/twap/done`, { method: "POST", headers: { Authorization: `Bearer ${env.WORKER_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: p.agentId }) }).catch(() => {});
          log(`[agent ${p.agentId}] plan complete → deregistered`);
        }
      } catch (e) { errors++; log(`[shared agent ${p.agentId}] ERROR ${e.message}`); }
    }

    // Shared durable Hero Mode runs: same registry pattern, but every step is a PAID inference
    // call, so each run is driven with ITS OWN registered Hero Run key (the user's — never this
    // worker's) alongside its own scoped session key. Deregister once the done marker is on-chain.
    let hmRuns = [];
    try {
      const r = await fetch(`${env.REGISTRY_URL}/api/heromode/active`, { headers: { Authorization: `Bearer ${env.WORKER_SECRET}` } });
      const d = await r.json().catch(() => ({}));
      hmRuns = Array.isArray(d.runs) ? d.runs : [];
      if (hmRuns.length) log(`registry: ${hmRuns.length} shared hero-mode run(s)`);
    } catch (e) { log(`heromode registry fetch error: ${e.message}`); }
    for (const p of hmRuns) {
      try {
        if (!p.apiKey) { log(`[hm agent ${p.agentId}] no Hero Run key registered — skipped`); continue; }
        const mem = new WorkerMemory({ agentId: p.agentId, privateKey: p.sessionKey, memAddr: env.HERO_MEM_ADDR, rpc: env.RH_RPC });
        const hm = await runHeroModeTick(mem, { chat: makeChat({ ...env, HERO_RUN_KEY: p.apiKey }, trace), log: (m) => log(`[hm agent ${p.agentId}] ${m}`) });
        serviced++;
        if (hm.acted) trace("heromode.step", { agent: p.agentId, mode: "shared" });
        if (hm.allDone) {
          await fetch(`${env.REGISTRY_URL}/api/heromode/done`, { method: "POST", headers: { Authorization: `Bearer ${env.WORKER_SECRET}`, "Content-Type": "application/json" }, body: JSON.stringify({ agentId: p.agentId }) }).catch(() => {});
          log(`[hm agent ${p.agentId}] run finished → deregistered`);
        }
      } catch (e) { errors++; log(`[shared hm agent ${p.agentId}] ERROR ${e.message}`); }
    }
  }

  // 3) Backstop keeper for the on-chain HeroTwapKeeper (tier 3): execute any due permissionless
  //    plans so they run even if no third-party bot shows up. Inert unless KEEPER_ADDRESS is set.
  let keeper;
  if (env.KEEPER_ADDRESS) {
    try { keeper = await pollKeeper(env, { log }); if (keeper.executed) trace("keeper.exec", { executed: keeper.executed }); }
    catch (e) { log(`keeper poll error: ${e.message}`); }
  }

  trace("cron.tick", { serviced, errors, ms: Math.round(nowMs() - t0) });
  return { serviced, errors, keeper, per };
}

export default {
  // Fires on the cron schedule in wrangler.jsonc.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).then((r) => console.log("cron tick:", JSON.stringify(r))));
  },
  // Manual trigger + health. POST /run with Authorization: Bearer <RUN_SECRET> to fire a tick now.
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run" && req.method === "POST") {
      const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!env.RUN_SECRET || tok !== env.RUN_SECRET) return new Response("unauthorized", { status: 401 });
      const lines = [];
      const r = await tick(env, (m) => lines.push(m));
      return Response.json({ ...r, log: lines });
    }
    return Response.json({ ok: true, service: "hero-jobs-worker", agents: String(env.AGENT_IDS || "").split(",").filter(Boolean).length });
  },
};
