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

// The brain: one chat completion through Hero Run's OpenAI-compatible /v1, paid in $HERO.
function makeChat(env) {
  return async ({ model = "auto", messages, maxTokens = 600 }) => {
    const r = await fetch(`${env.HERO_BASE || "https://herorunai.com"}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.HERO_RUN_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(`Hero Run ${r.status}: ${d.error?.message || d.error || ""}`);
    return { content: d.choices?.[0]?.message?.content || "" };
  };
}

async function tick(env, log = console.log) {
  const ids = String(env.AGENT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { log("no AGENT_IDS configured — nothing to do"); return { agents: 0, ran: 0 }; }
  if (!env.AGENT_PRIVATE_KEY || !env.HERO_RUN_KEY) { log("missing AGENT_PRIVATE_KEY or HERO_RUN_KEY"); return { agents: 0, ran: 0, error: "missing secrets" }; }
  const chat = makeChat(env);
  let ran = 0;
  const per = [];
  for (const id of ids) {
    try {
      const mem = new WorkerMemory({ agentId: id, privateKey: env.AGENT_PRIVATE_KEY, memAddr: env.HERO_MEM_ADDR, rpc: env.RH_RPC });
      const out = await runDue(mem, { chat, onLog: (m) => log(`[agent ${id}] ${m}`) });
      ran += out.ran; per.push({ agent: id, ...out });
      log(`[agent ${id}] ${out.ran}/${out.due} ran (${out.defined} defined)`);
    } catch (e) { log(`[agent ${id}] ERROR ${e.message}`); per.push({ agent: id, error: e.message }); }
  }
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
