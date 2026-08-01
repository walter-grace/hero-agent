#!/usr/bin/env node
// hero-agent CLI. Requires HERO_RUN_KEY (mint at https://herorunai.com/keys).
//   hero-agent chat                 interactive REPL (remembers across sessions, compacts on-chain/disk)
//   hero-agent run "task"           one-shot task, prints the answer
//   hero-agent remember "fact"      write a memory without a chat turn
//   hero-agent recall               print the ROOT index + memory stats
//   hero-agent compact              force a compaction now
// Flags: --memory local|onchain  --file <path>  --agent <id>  --mcp <name:command>
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHeroAgent } from "../src/agent.mjs";
import { LocalMemory } from "../src/memory/local.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "chat";
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const rest = argv.slice(1).filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);

async function makeMemory() {
  const kind = flag("memory", "local");
  if (kind === "onchain") {
    const { OnchainMemory } = await import("../src/memory/onchain.mjs");
    return new OnchainMemory({ agentId: flag("agent") });
  }
  return new LocalMemory({ file: flag("file", join(homedir(), ".hero-agent", "memory", "default.jsonl")) });
}
function mcpFromFlags() {
  const spec = flag("mcp");           // e.g. --mcp "fs:npx -y @modelcontextprotocol/server-filesystem ."
  if (!spec) return [];
  const [name, ...cmd] = spec.replace(/^[^:]+:/, (m) => m).split(":");
  const parts = spec.split(":"); const nm = parts.shift(); const c = parts.join(":").trim().split(/\s+/);
  return [{ name: nm, command: c[0], args: c.slice(1) }];
}

const onEvent = (type, data) => {
  if (type === "tool") process.stderr.write(`  · ${data.name}(${JSON.stringify(data.args).slice(0, 80)})\n`);
  if (type === "compact") process.stderr.write(`  · compacting ${data.entries} memories → ROOT\n`);
};

async function main() {
  if (!process.env.HERO_RUN_KEY) { console.error("Set HERO_RUN_KEY (mint at https://herorunai.com/keys)."); process.exit(1); }
  const memory = await makeMemory();
  const agent = await createHeroAgent({ memory, mcpServers: mcpFromFlags(), onEvent });
  console.error(`hero-agent · brain: Hero Run (auto) · memory: ${memory.label()}\n`);

  if (cmd === "bench") {
    // Measure REAL cost-per-task and compare with published agent-harness numbers. Uses a fresh
    // local memory per run so results are clean. Routing mode via --model auto|cheapest.
    const { heroUsd } = await import("../src/provider.mjs");
    const { createHeroAgent } = await import("../src/agent.mjs");
    const TASKS = [
      "What is 17 * 24? Reply with just the number.",
      "List three primary colors, comma-separated.",
      "In one sentence, what is a log-structured merge tree?",
      "Summarize in one line why compaction lowers an agent's token cost.",
      "Give one concrete tip for writing a good commit message.",
    ];
    const n = Math.min(Number(flag("tasks", TASKS.length)), TASKS.length);
    const mode = flag("model", "auto");
    const price = await heroUsd();
    let totalHero = 0; let ran = 0;
    console.error(`Running ${n} tasks · routing=${mode} · $HERO≈$${price.toExponential(2)}\n`);
    for (let i = 0; i < n; i++) {
      const fresh = new LocalMemory({ file: `/tmp/hero-agent-bench-${i}.jsonl` });
      const a = await createHeroAgent({ memory: fresh });
      a.model = mode;
      try { const { costHero } = await a.run(TASKS[i]); totalHero += costHero; ran++; process.stderr.write(`  ${i + 1}. ${Math.round(costHero)} $HERO  ($${(costHero * price).toFixed(4)})  ${TASKS[i].slice(0, 42)}…\n`); }
      catch (e) { process.stderr.write(`  ${i + 1}. skipped: ${e.message}\n`); }
    }
    const avgHero = ran ? totalHero / ran : 0; const avgUsd = avgHero * price;
    console.log(`\ncost per task (avg over ${ran}, model=${mode}): ${Math.round(avgHero)} $HERO  ($${avgUsd.toFixed(4)})`);
    // Published figures from other harnesses, for context only (heavier coding tasks on frontier
    // models — not a like-for-like comparison with the suite above).
    console.log("\nfor reference (published, heavier tasks):");
    for (const [name, usd] of [["Hermes Agent", 0.39], ["Pi Agent", 0.40], ["Codex", 0.47], ["OpenCode", 0.51], ["Kimi Code", 0.54], ["Claude Code", 1.47]]) console.log(`  $${usd.toFixed(2)}  ${name}`);
    return;
  }
  if (cmd === "bench-code") {
    // Real coding benchmark: the agent solves tasks in a sandbox; each is scored by running a
    // verifier (exit 0 = solved). Reports pass rate + cost. --executor local|docker, --model, --tasks.
    const { runCodingBench } = await import("../src/bench/run.mjs");
    const { CODING_TASKS } = await import("../src/bench/tasks.mjs");
    const { heroUsd } = await import("../src/provider.mjs");
    const n = Math.min(Number(flag("tasks", CODING_TASKS.length)), CODING_TASKS.length);
    const ex = flag("executor", "local");
    const mode = flag("model", "auto");
    const price = await heroUsd();
    console.error(`Coding bench · ${n} tasks · executor=${ex} · model=${mode}\n`);
    const r = await runCodingBench({ apiKey: process.env.HERO_RUN_KEY, tasks: CODING_TASKS.slice(0, n), executor: ex, model: mode,
      onEvent: (t, d) => { if (t === "task") process.stderr.write(`  ${d.solved ? "✓" : "✗"} ${d.id.padEnd(12)} ${Math.round(d.costHero)} $HERO ($${(d.costHero * price).toFixed(4)})${d.err ? " · " + d.err : ""}\n`); } });
    console.log(`\npass rate: ${r.solved}/${r.total} (${Math.round(r.passRate * 100)}%)`);
    console.log(`avg cost/task: ${Math.round(r.avgCostHero)} $HERO ($${r.avgCostUsd.toFixed(4)})`);
    if (r.costPerSolvedUsd != null) console.log(`cost/solved:   $${r.costPerSolvedUsd.toFixed(4)}`);
    console.log("\nfor reference (published harness cost/task, heavier tasks): $0.39–$1.47");
    return;
  }
  if (cmd === "recall") {
    const root = await memory.getRoot(); const raw = await memory.raw(); const since = await memory.sinceRoot();
    console.log(root?.text || "(no ROOT index yet)");
    console.error(`\n${raw.length} memories · ${since.length} since last ROOT · compacts every ${agent.compactEvery}`);
    return;
  }
  if (cmd === "compact") { const r = await agent.compact(); console.log(r ? "✓ compacted → new ROOT:\n\n" + r : "nothing new to compact"); return; }
  if (cmd === "remember") { await memory.append([{ role: "user", text: rest.join(" ") }]); console.log("✓ remembered"); return; }
  if (cmd === "run") { const { text, media } = await agent.run(rest.join(" ")); console.log(text); media.forEach((m) => console.log(`[${m.kind}] ${m.url}`)); return; }

  // chat REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you › " });
  console.log("Hero Agent ready. Type a message (Ctrl+C to exit).\n"); rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim(); if (!text) return rl.prompt();
    try { const { text: reply, media } = await agent.run(text); console.log("\nagent › " + reply + "\n"); media.forEach((m) => console.log(`  [${m.kind}] ${m.url}`)); }
    catch (e) { console.error("error: " + e.message); }
    rl.prompt();
  }).on("close", () => process.exit(0));
}
main().catch((e) => { console.error(e); process.exit(1); });
