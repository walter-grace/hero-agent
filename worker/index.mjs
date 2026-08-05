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
import { runTwapTick } from "./twap.mjs";

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
  return async ({ model = "auto", messages, maxTokens = 600 }) => {
    const t0 = nowMs();
    const r = await fetch(`${env.HERO_BASE || "https://herorunai.com"}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.HERO_RUN_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
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
    return { content: d.choices?.[0]?.message?.content || "" };
  };
}

async function tick(env, log = console.log, traceId) {
  const trace = tracer(traceId || `tick-${Math.random().toString(36).slice(2, 10)}`);
  const t0 = nowMs();
  const ids = String(env.AGENT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { log("no AGENT_IDS configured — nothing to do"); return { agents: 0, ran: 0 }; }
  if (!env.AGENT_PRIVATE_KEY) { log("missing AGENT_PRIVATE_KEY"); return { agents: 0, ran: 0, error: "missing key" }; }
  // HERO_RUN_KEY is only needed to run scheduled LLM jobs; durable TWAP doesn't use it. Without it,
  // skip jobs and still execute TWAP — so a TWAP-only worker needs just the wallet key.
  const runJobs = !!env.HERO_RUN_KEY;
  const chat = runJobs ? makeChat(env, trace) : null;
  let ran = 0, due = 0, errors = 0;
  const per = [];
  for (const id of ids) {
    try {
      const mem = new WorkerMemory({ agentId: id, privateKey: env.AGENT_PRIVATE_KEY, memAddr: env.HERO_MEM_ADDR, rpc: env.RH_RPC });
      let out = { ran: 0, due: 0, defined: 0 };
      if (runJobs) { out = await runDue(mem, { chat, onLog: (m) => log(`[agent ${id}] ${m}`), onSpan: (s) => trace(s.name, { agent: id, ...s }) }); }
      ran += out.ran; due += out.due; per.push({ agent: id, ...out });
      if (runJobs) log(`[agent ${id}] ${out.ran}/${out.due} jobs ran (${out.defined} defined)`);
      // Durable TWAP: if this agent's memory carries a twap:: plan, execute the next due chunk.
      // Spends from the SAME key (the session/burner wallet the plan was created for).
      try {
        const tw = await runTwapTick(mem, { privateKey: env.AGENT_PRIVATE_KEY, holdMin: Number(env.HERO_TWAP_MIN ?? 1_000_000), rhRpc: env.RH_RPC, baseRpc: env.BASE_RPC, log: (m) => log(`[agent ${id}] ${m}`) });
        if (tw.acted) { trace("twap.chunk", { agent: id }); per[per.length - 1].twap = tw; }
      } catch (e) { log(`[agent ${id}] twap ERROR ${e.message}`); }
    } catch (e) { errors++; log(`[agent ${id}] ERROR ${e.message}`); per.push({ agent: id, error: e.message }); trace("agent.error", { agent: id, message: e.message }); }
  }
  trace("cron.tick", { agents: ids.length, due, ran, errors, ms: Math.round(nowMs() - t0) });
  return { agents: ids.length, ran, per };
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
