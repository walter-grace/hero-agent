// Gemma rebuilds a backpropagation engine from the on-chain blueprint. Never sees teacher code or exam.
import { agentTurn, vaultBootKey, readMemory } from "../../../src/tui/api.mjs";
import { mkdirSync } from "node:fs";
const agentId = process.argv[2] || "47";
const OUT = new URL("./student/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const key = await vaultBootKey();
const entries = await readMemory(agentId, { limit: 40 });
const trace = entries.map((e) => e.text).filter((t) => /^(task|reasoning)::/.test(t)).join("\n");
console.log(`blueprint from agent #${agentId}: ${trace.split("\n").length} entries`);
const t0 = Date.now();
const out = await agentTurn({
  key, model: process.env.STUDENT_MODEL || "gemma-4-31b@cerebras", cwd: OUT, maxTokens: 7500, maxSteps: 4,
  messages: [
    { role: "system", content: `You are a coding agent with tools: shell, read_file, write_file. Working directory: ${OUT}. Recreate the described module EXACTLY per its API contract: write ONE complete ES module to herograd.mjs via write_file (the ENTIRE file in one call, no dependencies). Follow every reasoning step; the pitfalls list is there because each one fails a hidden test.` },
    { role: "user", content: `The on-chain engineering blueprint. Build it now.\n\n${trace}` },
  ],
  onTool: (n, a) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] · ${n}(${String(a.path || a.cmd || "").slice(0, 50)})`),
  approve: async () => true,
});
console.log(`student done: ${((Date.now() - t0) / 1000).toFixed(0)}s · ${Math.round(out.costHero)} $HERO`);
