#!/usr/bin/env node
// hero-agent CLI. Requires HERO_RUN_KEY (mint at https://herorunai.com/keys).
//   hero-agent chat                 interactive REPL (remembers across sessions, compacts on-chain/disk)
//   hero-agent run "task"           one-shot task, prints the answer
//   hero-agent remember "fact"      write a memory without a chat turn
//   hero-agent recall               print the ROOT index + memory stats
//   hero-agent compact              force a compaction now
//   hero-agent prove "<statement>"  prove a theorem in Lean 4 in an E2B sandbox (loops until it verifies)
//   hero-agent replay <path-to-diff> replay a contributed train.py diff in a sandbox, measure val_bpb, verdict
// Flags: --memory local|onchain  --file <path>  --agent <id>  --mcp <name:command>  --fff (fast file search)
//        prove: --full-mathlib  --timeout <seconds>  --model auto|cheapest  (needs E2B_API_KEY, ARISTOTLE_API_KEY)
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHeroAgent } from "../src/agent.mjs";
import { LocalMemory } from "../src/memory/local.mjs";
import { fffServer } from "../src/tools/mcp.mjs";

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
  const servers = [];
  const spec = flag("mcp");           // e.g. --mcp "fs:npx -y @modelcontextprotocol/server-filesystem ."
  if (spec) {
    const parts = spec.split(":"); const nm = parts.shift(); const c = parts.join(":").trim().split(/\s+/);
    servers.push({ name: nm, command: c[0], args: c.slice(1) });
  }
  // --fff: attach fff's fast file-search MCP server (github.com/dmtrKovalenko/fff). Optional and never a
  // dependency: if fff-mcp is not installed we print how to get it and keep running without it.
  if (argv.includes("--fff")) {
    const s = fffServer();
    if (s) { console.error(`  · fast file search on (fff-mcp: ${s.command})`); servers.push(s); }
    else console.error("  · --fff requested but fff-mcp not found. Install: curl -L https://dmtrkovalenko.dev/install-fff-mcp.sh | bash  (or brew install dmtrKovalenko/fff/fff-mcp). Continuing without file search.");
  }
  return servers;
}

const onEvent = (type, data) => {
  if (type === "tool") process.stderr.write(`  · ${data.name}(${JSON.stringify(data.args).slice(0, 80)})\n`);
  if (type === "compact") process.stderr.write(`  · compacting ${data.entries} memories → ROOT\n`);
};

// Commands that never call the Hero Run brain (they run entirely in a sandbox) do not need a
// HERO_RUN_KEY. replay is the val_bpb oracle: it only needs E2B_API_KEY.
const NO_BRAIN = new Set(["replay", "autoresearch", "cascade-bench"]);

async function main() {
  if (NO_BRAIN.has(cmd)) {
    // Cascade eval: measure cost/quality of a FrugalGPT-style cascade vs cheap/frontier/auto baselines.
    // Needs HERO_RUN_KEY for a real run; --dry stubs the model calls (no key, no cost) to check the eval.
    if (cmd === "cascade-bench") {
      const dry = argv.includes("--dry");
      if (!dry && !process.env.HERO_RUN_KEY) { console.error("Set HERO_RUN_KEY (or pass --dry to stub the model calls)."); process.exit(1); }
      const { runCascadeBench, makeStubChat, heroUsd } = await import("../src/bench/cascade-bench.mjs");
      const arms = (flag("arms", "cheap,frontier,auto,cascade")).split(",").map((s) => s.trim()).filter(Boolean);
      const opts = { arms, cheap: flag("cheap", "cheapest"), frontier: flag("frontier", "anthropic/claude-sonnet-5"), judge: flag("judge", "openai/gpt-oss-20b"), threshold: Number(flag("threshold", 6)) };
      let chat, usd;
      if (dry) { chat = makeStubChat({ cheap: opts.cheap, frontier: opts.frontier }); usd = 0.0002; }
      else { const { heroRun } = await import("../src/provider.mjs"); chat = heroRun({ apiKey: process.env.HERO_RUN_KEY }).chat; usd = await heroUsd(); }
      console.error(`cascade-bench · arms=${arms.join(",")} · cheap=${opts.cheap} · frontier=${opts.frontier} · judge=${opts.judge} · τ=${opts.threshold}${dry ? " · DRY" : ""}\n`);
      const out = await runCascadeBench({ ...opts, chat, usd, onEvent: (t, d) => { if (t === "cell" && d.arm === "cascade") process.stderr.write(`  · ${d.task.padEnd(11)} ${d.ok ? "✓" : "✗"}${d.escalated ? " ↑esc (" + (d.why || "") + ")" : ""}\n`); } });
      const pct = (x) => x == null ? "—" : (x * 100).toFixed(0) + "%";
      const h = (x) => x.toFixed(4);
      console.log("\narm        acc    $HERO/run   ~USD/run   escal");
      console.log("-".repeat(52));
      for (const a of arms) { const A = out.arms[a]; console.log(`${a.padEnd(10)} ${pct(A.accuracy).padStart(4)}   ${h(A.costHero).padStart(9)}   ${("$" + (A.costUsd).toFixed(5)).padStart(8)}   ${A.escalationRate == null ? "—" : pct(A.escalationRate)}`); }
      if (out.summary.qualityRetained != null) console.log(`\ncascade retains ${pct(out.summary.qualityRetained)} of frontier quality at ${pct(out.summary.costFraction)} of frontier cost.`);
      if (out.summary.vsAuto) console.log(`vs auto: ${out.summary.vsAuto.costDeltaHero <= 0 ? "cheaper" : "pricier"} by ${h(Math.abs(out.summary.vsAuto.costDeltaHero))} $HERO/run, accuracy ${out.summary.vsAuto.accDelta >= 0 ? "+" : ""}${(out.summary.vsAuto.accDelta * 100).toFixed(0)}pts.`);
      console.log(`\n(${out.tasks} tasks · ${dry ? "DRY stub" : "live"}. Decide ship on the cascade-vs-auto line.)`);
      return;
    }
    // Durable autoresearch: run a candidate diff through the val_bpb replay as durable, on-chain-
    // checkpointed steps, then post the verdict to the web app's ground-truth ingest seam. Each step
    // is checkpointed to Robinhood Chain, so a crash resumes from the last completed step. Inert
    // unless AUTORESEARCH_ENABLED=1. The web app stays the ingestion point (we only POST verdicts).
    if (cmd === "autoresearch") {
      if (process.env.AUTORESEARCH_ENABLED !== "1") { console.error("Autoresearch is off. Set AUTORESEARCH_ENABLED=1 to run it."); process.exit(1); }
      const diffPath = rest[0], contribution = flag("contribution");
      // The diff is a POSITIONAL arg (like `replay`), so --file stays the LOCAL MEMORY path (makeMemory).
      if (!diffPath || !contribution) { console.error("Usage: hero-agent autoresearch <train.py-diff> --contribution <id> [--memory onchain|local] [--agent <id>] [--file <mem.jsonl>] [--seeds N] [--timeout secs] [--source <s>]"); process.exit(1); }
      const dryReplay = argv.includes("--dry-replay");
      if (!dryReplay && !process.env.E2B_API_KEY) { console.error("Set E2B_API_KEY for the replay sandbox (or pass --dry-replay to stub it)."); process.exit(1); }
      const { readFileSync } = await import("node:fs");
      let artifact; try { artifact = readFileSync(diffPath, "utf8"); } catch (e) { console.error(`cannot read ${diffPath}: ${e.message}`); process.exit(1); }
      const memory = await makeMemory();
      const { DurableRun } = await import("../src/autoresearch/durable.mjs");
      const { runAutoresearchOnce, makeIngest } = await import("../src/autoresearch/loop.mjs");
      // --log-json emits one structured JSON line per step event, so a run is machine-queryable and
      // exportable (mirrors Vercel AI Gateway logs). Pipe it: `... --log-json 2>run.jsonl`.
      const logJson = argv.includes("--log-json");
      const onLog = (m) => { if (!logJson) process.stderr.write(`  · ${m}\n`); };
      const onEvent = (rec) => { if (logJson) process.stderr.write(JSON.stringify(rec) + "\n"); };
      const run = new DurableRun({ memory, runId: `ar-${contribution}`, onLog, onEvent });
      await run.load();
      const ingest = makeIngest({ url: process.env.FOUNDRY_INGEST_URL, attestorKey: process.env.FOUNDRY_ATTESTOR_KEY, onLog });
      const replayOpts = dryReplay
        ? { fake: { verdict: flag("fake-verdict", "improved"), delta: Number(flag("fake-delta", "0.05")), baseline: [1.0], candidate: [0.95], err: null } }
        : { seeds: Number(flag("seeds", 3)), steps: flag("steps") ? Number(flag("steps")) : null, timeoutMs: Number(flag("timeout", 900)) * 1000 };
      if (!logJson) console.error(`autoresearch · run ar-${contribution} · memory=${memory.label()} · ${dryReplay ? "DRY replay" : "E2B replay (egress OFF)"}\n`);
      const t0 = Date.now();
      const out = await runAutoresearchOnce({ run, candidate: { contributionId: contribution, artifact, source: flag("source") || null }, ingest, replayOpts, onLog });
      // Run-summary observability record (like a Vercel gateway request row: id, outcome, duration, status).
      onEvent({ event: "run", runId: `ar-${contribution}`, contributionId: contribution, outcome: out.outcome || null, valBpbDelta: out.valBpbDelta ?? null, ingested: out.ingested?.dryRun ? "dry" : out.ingested?.skipped ? "skipped" : "posted", ms: Date.now() - t0, at: new Date().toISOString() });
      if (!logJson) {
        console.log("");
        console.log(`outcome: ${out.outcome || "(none — skipped)"}${out.valBpbDelta != null ? `  ·  Δval_bpb ${out.valBpbDelta}` : ""}`);
        console.log(`ingest: ${out.ingested?.dryRun ? "dry run (not posted)" : out.ingested?.skipped ? "skipped (" + out.ingested.reason + ")" : "posted to " + (process.env.FOUNDRY_INGEST_URL || "?")}`);
      }
      return;
    }
    if (cmd === "replay") {
      if (!process.env.E2B_API_KEY) { console.error("Set E2B_API_KEY (get one at https://e2b.dev/dashboard)."); process.exit(1); }
      const path = rest[0];
      if (!path) { console.error("Provide a path: hero-agent replay <path-to-diff-or-train.py>"); process.exit(1); }
      const { readFileSync } = await import("node:fs");
      let artifact;
      try { artifact = readFileSync(path, "utf8"); } catch (e) { console.error(`cannot read ${path}: ${e.message}`); process.exit(1); }
      const { runReplay } = await import("../src/replay.mjs");
      const seedsN = Number(flag("seeds", 3));
      const steps = flag("steps") ? Number(flag("steps")) : null;
      const timeoutMs = Number(flag("timeout", 900)) * 1000;
      console.error(`Replay · sandbox=E2B (egress OFF) · mode=cpu-tiny · seeds=${seedsN}${steps ? " · steps=" + steps : ""}\n`);
      const r = await runReplay(artifact, {
        seeds: seedsN, steps, timeoutMs,
        onEvent: (t, d) => {
          if (t === "phase") process.stderr.write(`  · ${d.message}\n`);
          if (t === "seed") process.stderr.write(`    ${d.role.padEnd(9)} seed ${d.seed}: val_bpb=${d.bpb.toFixed(5)}\n`);
        },
      });
      console.log("");
      if (r.verdict === "tampered") {
        console.log(`✗ TAMPERED (${r.tamper.where}): ${r.tamper.reasons.join("; ")}`);
        console.log("The artifact tried to fake or corrupt its own score. No bpb number is trusted.");
      } else if (r.verdict === "error") {
        console.log(`! ERROR: ${r.err}`);
      } else {
        const sym = r.verdict === "improved" ? "✓" : r.verdict === "regressed" ? "✗" : "•";
        console.log(`${sym} VERDICT: ${r.verdict}`);
        console.log(`  baseline val_bpb: ${r.baselineBpb.toFixed(5)}  [${r.baselineBpbs.map((x) => x.toFixed(5)).join(", ")}]`);
        console.log(`  candidate val_bpb: ${r.candidateBpb.toFixed(5)}  [${r.candidateBpbs.map((x) => x.toFixed(5)).join(", ")}]`);
        console.log(`  delta: ${r.delta.toFixed(5)} bpb (lower is better)   noise band (2σ): ${r.noiseBand.toFixed(5)}`);
        console.log(`  network egress blocked: ${r.networkBlocked === null ? "unknown" : r.networkBlocked}`);
      }
      console.log(`  seeds: ${r.seeds.join(", ")}`);
      console.log(`  pinned hashes: ${Object.entries(r.hashes).map(([k, v]) => `${k}=${v.slice(0, 10)}`).join("  ")}`);
    }
    return;
  }
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
  if (cmd === "terminal-bench") {
    // Run against a checked-out Terminal-Bench dataset. Needs Docker + a funded key.
    //   hero-agent terminal-bench --dataset ./terminal-bench --task hello-world --model auto
    const { runTerminalBench } = await import("../src/bench/terminal-bench.mjs");
    const dataset = flag("dataset");
    if (!dataset) { console.error("Provide --dataset <path to a terminal-bench checkout>"); process.exit(1); }
    const { heroUsd } = await import("../src/provider.mjs");
    const price = await heroUsd();
    console.error(`Terminal-Bench · dataset=${dataset}${flag("task") ? " · task~" + flag("task") : ""} · model=${flag("model", "auto")}\n`);
    const r = await runTerminalBench({
      apiKey: process.env.HERO_RUN_KEY, datasetDir: dataset, include: flag("task"),
      model: flag("model", "auto"), service: flag("service"), testsPath: flag("tests-path"),
      onEvent: (t, d) => { if (t === "task") process.stderr.write(`  ${d.solved ? "✓" : "✗"} ${d.id.padEnd(28)} ${Math.round(d.costHero)} $HERO ($${(d.costHero * price).toFixed(4)})${d.err ? " · " + d.err : ""}\n`); },
    });
    console.log(`\npass rate: ${r.solved}/${r.total} (${Math.round(r.passRate * 100)}%) · avg cost/task: $${r.avgCostUsd.toFixed(4)}`);
    return;
  }
  if (cmd === "smoke") {
    // Cheapest end-to-end check: one trivial coding task, cheapest model, capped steps. Confirms the
    // key, the agent loop, the shell tools, the sandbox, and scoring all work before a real run.
    const { runCodingBench } = await import("../src/bench/run.mjs");
    const { CODING_TASKS } = await import("../src/bench/tasks.mjs");
    const { heroUsd } = await import("../src/provider.mjs");
    const price = await heroUsd();
    const task = CODING_TASKS.find((t) => t.id === "fix-bug") || CODING_TASKS[0];
    console.error(`Smoke test: 1 task (${task.id}), model=cheapest, local sandbox\n`);
    const r = await runCodingBench({ apiKey: process.env.HERO_RUN_KEY, tasks: [task], executor: "local", model: "cheapest", maxSteps: 8,
      onEvent: (t, d) => { if (t === "task") process.stderr.write(`  ${d.solved ? "✓ solved" : "✗ not solved"} · ${Math.round(d.costHero)} $HERO ($${(d.costHero * price).toFixed(4)})${d.err ? " · " + d.err : ""}\n`); } });
    console.log(r.solved ? "\n✓ smoke passed: the full loop works. Fund the key and run bench-code / terminal-bench / swe-bench." : "\n✗ smoke did not solve the task. Check the key balance and the error above.");
    return;
  }
  if (cmd === "swe-bench") {
    // Produce SWE-bench predictions (one patch per instance), then score with SWE-bench's own harness.
    //   hero-agent swe-bench --dataset lite.jsonl [--instance django__django-11099] --out predictions.jsonl
    const { runSweBench, loadSweBench } = await import("../src/bench/swe-bench.mjs");
    const dataset = flag("dataset");
    if (!dataset) { console.error("Provide --dataset <swe-bench lite .jsonl> (export it, see docs/benchmarks.md)"); process.exit(1); }
    const { heroUsd } = await import("../src/provider.mjs");
    const price = await heroUsd();
    const instances = loadSweBench(dataset, { instance: flag("instance") });
    const outPath = flag("out", "predictions.jsonl");
    console.error(`SWE-bench: ${instances.length} instance(s) · model=${flag("model", "auto")} · out=${outPath}\n`);
    const trace = argv.includes("--trace");
    const r = await runSweBench({ apiKey: process.env.HERO_RUN_KEY, instances, out: outPath, model: flag("model", "auto"), maxSteps: Number(flag("steps", 40)), nudges: Number(flag("nudges", 2)),
      onEvent: (t, d) => {
        if (t === "tool" && trace) process.stderr.write(`    · ${d.name}(${JSON.stringify(d.args).slice(0, 90)})\n`);
        if (t === "nudge") process.stderr.write(`    ↳ no edits yet, nudging (attempt ${d.attempt})\n`);
        if (t === "instance") process.stderr.write(`  ${d.produced ? "✓ patch" : "· no patch"}  ${d.instance_id.padEnd(30)} ${Math.round(d.costHero)} $HERO ($${(d.costHero * price).toFixed(4)})${d.attempts ? " · " + d.attempts + " attempt(s)" : ""}${d.err ? " · " + d.err : ""}\n`);
      } });
    console.log(`\nwrote ${r.produced}/${r.total} patches to ${r.out}`);
    console.log("score them with SWE-bench's harness:");
    console.log(`  python -m swebench.harness.run_evaluation --predictions_path ${r.out} --dataset_name princeton-nlp/SWE-bench_Lite --run_id hero-agent`);
    return;
  }
  if (cmd === "prove") {
    // Prove a theorem in Lean 4 inside an E2B sandbox: draft Lean (or call Aristotle), compile in the
    // sandbox, read errors, iterate until the build is clean with no sorry. Needs E2B_API_KEY (and
    // ARISTOTLE_API_KEY to use the aristotle tool). Mathlib is skipped unless --full-mathlib.
    //   hero-agent prove "the sum of two even integers is even" [--full-mathlib] [--timeout 1200] [--model auto]
    if (!process.env.E2B_API_KEY) { console.error("Set E2B_API_KEY (get one at https://e2b.dev/dashboard)."); process.exit(1); }
    const statement = rest.join(" ");
    if (!statement.trim()) { console.error('Provide a statement: hero-agent prove "<statement>"'); process.exit(1); }
    const { runProve } = await import("../src/prove.mjs");
    const { heroUsd } = await import("../src/provider.mjs");
    const price = await heroUsd().catch(() => 0);
    const fullMathlib = argv.includes("--full-mathlib");
    const timeoutMs = Number(flag("timeout", 1200)) * 1000; // seconds -> ms
    console.error(`Prove · sandbox=E2B · Mathlib=${fullMathlib ? "on (heavy)" : "off"} · model=${flag("model", "auto")}\n`);
    const r = await runProve(statement, {
      apiKey: process.env.HERO_RUN_KEY, model: flag("model", "auto"), fullMathlib, timeoutMs,
      onEvent: (t, d) => {
        if (t === "phase") process.stderr.write(`  · ${d.message}\n`);
        if (t === "lean") process.stderr.write(`    ${String(d.message).split("\n")[0].slice(0, 100)}\n`);
        if (t === "tool") process.stderr.write(`    → ${d.name}(${JSON.stringify(d.args).slice(0, 80)})\n`);
      },
    });
    console.log(r.verified ? "\n✓ VERIFIED: Lean accepted the proof (clean build, no sorry).\n" : "\n✗ NOT verified. The build did not pass clean. Latest build output:\n" + (r.buildOutput || r.err || "") + "\n");
    if (r.finalLean) { console.log("--- Proof.lean ---\n" + r.finalLean + "\n------------------"); }
    console.log(`\ncost: ${Math.round(r.costHero)} $HERO ($${(r.costHero * price).toFixed(4)})`);
    console.log("trace: " + r.trace.join(" → "));
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
