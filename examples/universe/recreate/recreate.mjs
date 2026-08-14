// The recreation: a Cerebras Gemma student rebuilds the teacher's website from the ON-CHAIN
// reasoning trace alone. It never sees the teacher's code — only the minted blueprint.
//   HERO_AGENT_KEY_FILE=… node recreate.mjs <traceAgentId>
import { agentTurn, vaultBootKey, readMemory, BASE } from "../../../src/tui/api.mjs";
import { mkdirSync } from "node:fs";

const STUDENT = process.env.STUDENT_MODEL || "gemma-4-31b@cerebras";
const agentId = process.argv[2] || "46";
const OUT_DIR = new URL("./student/", import.meta.url).pathname;
mkdirSync(OUT_DIR, { recursive: true });
const key = await vaultBootKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const balance = async () => (await (await fetch(`${BASE}/api/keys/info`, { headers: { "x-api-key": key } })).json()).balance ?? 0;

// fuel gate
let bal = await balance();
if (bal < 80_000) {
  console.log(`FUEL GATE: ${Math.round(bal).toLocaleString()} $HERO, need ~80,000. Polling 30s up to 2h…`);
  const t0 = Date.now();
  while (bal < 80_000 && Date.now() - t0 < 7_200_000) { await sleep(30_000); bal = await balance(); }
  if (bal < 80_000) { console.log("no fuel — rerun later"); process.exit(1); }
  console.log(`fuel: ${Math.round(bal).toLocaleString()}. starting.`);
}

// the blueprint, straight from the chain
const entries = await readMemory(agentId, { limit: 40 });
const trace = entries.map((e) => e.text).filter((t) => /^(task|reasoning)::/.test(t)).join("\n");
console.log(`blueprint recalled from agent #${agentId}: ${trace.split("\n").length} entries\n`);

const t0 = Date.now();
const out = await agentTurn({
  key, model: STUDENT, cwd: OUT_DIR, maxTokens: 6500, maxSteps: 4,
  messages: [
    { role: "system", content: `You are a coding agent. You have tools: shell, read_file, write_file. Working directory: ${OUT_DIR}. You will receive a senior engineer's complete reasoning trace for a website they built. Recreate the website from the trace: write ONE complete, self-contained HTML file to habit-grid.html using write_file (the FULL file in one call, inline CSS and JS, no dependencies). Follow every reasoning step and satisfy the final CHECKLIST. Do not ask questions.` },
    { role: "user", content: `Here is the on-chain reasoning trace. Build it now.\n\n${trace}` },
  ],
  onTool: (n, a) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] · ${n}(${String(a.path || a.cmd || "").slice(0, 60)})`),
  approve: async () => true,
});
console.log(`\nstudent finished: ${((Date.now() - t0) / 1000).toFixed(0)}s · ${Math.round(out.costHero)} $HERO`);
console.log(out.text.slice(0, 300));
