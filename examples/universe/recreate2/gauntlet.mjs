// The gauntlet: can OTHER small/fast models rebuild backpropagation from the on-chain blueprint?
// Same trace (agent #47), same held-out exam, one student at a time. Results stream to JSON for the
// report UI. Failures are data: a model that can't tool-call or can't understand scores honestly.
//   HERO_AGENT_KEY_FILE=… node gauntlet.mjs
import { agentTurn, vaultBootKey, readMemory } from "../../../src/tui/api.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";

const ROSTER = [
  { id: "gemma-4-31b@cerebras", label: "Gemma 4 31B", size: "31B", note: "wafer speed · the original" },
  { id: "openai/gpt-oss-20b", label: "gpt-oss-20b", size: "20B", note: "smallest OpenAI open model" },
  { id: "qwen/qwen3-32b", label: "Qwen3 32B", size: "32B", note: "Alibaba open" },
  { id: "z-ai/glm-4.7@cerebras", label: "GLM-4.7", size: "355B MoE", note: "wafer speed" },
  { id: "openai/gpt-oss-120b@cerebras", label: "gpt-oss-120b", size: "120B", note: "fast reference anchor" },
  { id: "liquid/lfm-2.5-2.6b:free", label: "LFM 2.5", size: "2.6B", note: "the tiny floor test" },
];

const AGENT = "47";
const key = await vaultBootKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = new URL(".", import.meta.url).pathname;

const entries = await readMemory(AGENT, { limit: 40 });
const trace = entries.map((e) => e.text).filter((t) => /^(task|reasoning)::/.test(t)).join("\n");
console.log(`blueprint: ${trace.split("\n").length} entries from agent #${AGENT}\n`);

const exam = (file) => new Promise((res) => {
  execFile("node", [here + "exam.mjs", file], { timeout: 120_000 }, (err, stdout, stderr) => {
    const tests = [...String(stdout).matchAll(/([✓✗]) ([^\n←]+)/g)].map((m) => ({ ok: m[1] === "✓", name: m[2].trim() }));
    const m = String(stdout).match(/(\d+)\/(\d+) passed/);
    res({ passed: m ? +m[1] : 0, total: m ? +m[2] : 12, tests, crashed: !!err && !m, err: (stderr || "").slice(0, 200) });
  });
});

const results = [];
for (const model of ROSTER) {
  const slug = model.id.replace(/[^a-z0-9]/gi, "-");
  const dir = `${here}students/${slug}/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`── ${model.label} (${model.id})`);
  const t0 = Date.now();
  let build = { costHero: 0 };
  let buildError = null;
  try {
    build = await agentTurn({
      key, model: model.id, cwd: dir, maxTokens: 7500, maxSteps: 4,
      messages: [
        { role: "system", content: `You are a coding agent with tools: shell, read_file, write_file. Working directory: ${dir}. Recreate the described module EXACTLY per its API contract: write ONE complete ES module to herograd.mjs via write_file (the ENTIRE file in one call, no dependencies). Follow every reasoning step; the pitfalls list is there because each one fails a hidden test.` },
        { role: "user", content: `The on-chain engineering blueprint. Build it now.\n\n${trace}` },
      ],
      onTool: (n, a) => console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] · ${n}(${String(a.path || a.cmd || "").slice(0, 45)})`),
      approve: async () => true,
    });
  } catch (e) { buildError = e.message.slice(0, 160); }
  const secs = +((Date.now() - t0) / 1000).toFixed(1);
  const verdict = buildError ? { passed: 0, total: 12, tests: [], crashed: true, err: buildError } : await exam(dir + "herograd.mjs");
  console.log(`   ${verdict.passed}/${verdict.total} · ${secs}s · ${Math.round(build.costHero)} $HERO${buildError ? " · BUILD FAILED: " + buildError : verdict.crashed ? " · exam crashed" : ""}\n`);
  results.push({ ...model, secs, cost: Math.round(build.costHero || 0), ...verdict, buildError });
  writeFileSync(here + "gauntlet-results.json", JSON.stringify({ agent: AGENT, when: new Date().toISOString(), results }, null, 2));
  await sleep(12_000);
}
console.log("═══ GAUNTLET COMPLETE ═══");
for (const r of results) console.log(`  ${String(r.passed).padStart(2)}/12 · ${String(r.secs).padStart(5)}s · ${String(r.cost).padStart(6)} $HERO · ${r.label}`);
