// Every gauntlet model builds ITS OWN Habit Grid from the on-chain blueprint (agent #46).
// Fuel-gated; results stream to apps-results.json; each app lands in apps/<slug>/habit-grid.html
import { agentTurn, vaultBootKey, readMemory, BASE } from "../../../src/tui/api.mjs";
import { mkdirSync, writeFileSync, existsSync, cpSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const ROSTER = [
  { id: "gemma-4-31b@cerebras", label: "Gemma 4 31B", done: "student/habit-grid.html" }, // already built
  { id: "openai/gpt-oss-20b", label: "gpt-oss-20b" },
  { id: "qwen/qwen3-32b", label: "Qwen3 32B" },
  { id: "z-ai/glm-4.7@cerebras", label: "GLM-4.7" },
  { id: "openai/gpt-oss-120b@cerebras", label: "gpt-oss-120b" },
];
const key = await vaultBootKey();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const balance = async () => (await (await fetch(`${BASE}/api/keys/info`, { headers: { "x-api-key": key } })).json()).balance ?? 0;
let bal = await balance();
if (bal < 300_000) {
  console.log(`FUEL GATE: ${Math.round(bal).toLocaleString()} $HERO, need ~300k. Polling 30s up to 3h…`);
  const t0 = Date.now();
  while (bal < 300_000 && Date.now() - t0 < 3 * 3600_000) { await sleep(30_000); bal = await balance(); }
  if (bal < 300_000) { console.log("no fuel"); process.exit(1); }
  console.log(`fuel: ${Math.round(bal).toLocaleString()}. building.`);
}
const entries = await readMemory("46", { limit: 40 });
const trace = entries.map((e) => e.text).filter((t) => /^(task|reasoning)::/.test(t)).join("\n");
const results = [];
for (const m of ROSTER) {
  const slug = m.id.replace(/[^a-z0-9]/gi, "-");
  const dir = `${here}apps/${slug}/`;
  mkdirSync(dir, { recursive: true });
  if (m.done) { cpSync(here + m.done, dir + "habit-grid.html"); results.push({ ...m, secs: 4, cost: 46562, ok: true, note: "original run" }); writeFileSync(here + "apps-results.json", JSON.stringify(results, null, 2)); continue; }
  console.log(`── ${m.label}`);
  const t0 = Date.now();
  let ok = true, cost = 0, err = null;
  try {
    const out = await agentTurn({
      key, model: m.id, cwd: dir, maxTokens: 6500, maxSteps: 4,
      messages: [
        { role: "system", content: `You are a coding agent with tools: shell, read_file, write_file. Working directory: ${dir}. Recreate the described website from the senior engineer's reasoning trace: write ONE complete self-contained HTML file to habit-grid.html via write_file (the FULL file in one call, inline CSS+JS, no dependencies). Follow every reasoning step and the final CHECKLIST.` },
        { role: "user", content: `The on-chain reasoning trace. Build it now.\n\n${trace}` },
      ],
      onTool: (n, a) => console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] · ${n}(${String(a.path || a.cmd || "").slice(0, 40)})`),
      approve: async () => true,
    });
    cost = Math.round(out.costHero || 0);
  } catch (e) { ok = false; err = e.message.slice(0, 140); }
  if (!existsSync(dir + "habit-grid.html")) { ok = false; err = err || "no file written"; }
  const secs = +((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   ${ok ? "✓ built" : "✗ " + err} · ${secs}s · ${cost} $HERO`);
  results.push({ ...m, secs, cost, ok, err });
  writeFileSync(here + "apps-results.json", JSON.stringify(results, null, 2));
  await sleep(12_000);
}
console.log("ALL DONE — run: node app-gallery.mjs");
