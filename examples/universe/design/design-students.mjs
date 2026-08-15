// Design students: each model gets the minted WORKFLOW (agent #48) + the scraped BRIEF, and must
// manufacture a finished UI. The workflow is general; the brief is today's job ticket.
import { agentTurn, vaultBootKey, readMemory } from "../../../src/tui/api.mjs";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const ROSTER = ["gemma-4-31b@cerebras", "openai/gpt-oss-120b@cerebras", "qwen/qwen3-32b"];
const key = await vaultBootKey();
const wf = (await readMemory("48", { limit: 30 })).map((e) => e.text).filter((t) => /^(task|reasoning)::/.test(t)).join("\n");
const brief = JSON.parse(readFileSync(here + "briefs.json", "utf8")).briefs[0];
const briefText = `DESIGN BRIEF (scraped from ${brief.url}):\nTitle: ${brief.title}\nTags: ${brief.tags.join(", ")}\nPalette (scraped): ${brief.colors.join(" ")}\nDescription: ${brief.desc}`;
console.log(briefText + "\n");
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const model of ROSTER) {
  const slug = model.replace(/[^a-z0-9]/gi, "-");
  const dir = `${here}uis/${slug}/`;
  mkdirSync(dir, { recursive: true });
  console.log(`── ${model}`);
  const t0 = Date.now();
  let ok = true, cost = 0, err = null;
  try {
    const out = await agentTurn({
      key, model, cwd: dir, maxTokens: 7500, maxSteps: 3,
      messages: [
        { role: "system", content: `You are a design-engineering agent with tools: write_file, read_file, shell. Working directory: ${dir}. You will receive a minted design workflow and a scraped brief. Execute the workflow ON this brief: write ONE complete, beautiful, self-contained HTML page to index.html via write_file (FULL file in one call, inline CSS+JS, no dependencies, no external requests). Working interactive specimens, not pictures.` },
        { role: "user", content: `THE MINTED WORKFLOW:\n${wf}\n\n${briefText}\n\nBuild the page now.` },
      ],
      onTool: (n, a) => console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] · ${n}(${String(a.path || a.cmd || "").slice(0, 40)})`),
      approve: async () => true,
    });
    cost = Math.round(out.costHero || 0);
  } catch (e) { ok = false; err = e.message.slice(0, 120); }
  if (!existsSync(dir + "index.html")) { ok = false; err = err || "no file"; }
  const secs = +((Date.now() - t0) / 1000).toFixed(1);
  console.log(`   ${ok ? "✓" : "✗ " + err} · ${secs}s · ${cost} $HERO`);
  results.push({ model, slug, secs, cost, ok, err });
  writeFileSync(here + "ui-results.json", JSON.stringify({ brief, results }, null, 2));
  await sleep(10_000);
}
console.log("DONE");
