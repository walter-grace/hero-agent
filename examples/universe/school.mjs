// The Hero/Universe school, run live:
//   Round 1 — a fresh student (small model, zero lessons) attempts a task and stumbles through it.
//   Class    — the Universe (frontier model) reviews the trace and mints ONE lesson on-chain.
//   Round 2 — the SAME task, fresh conversation: the student boots with its earned lesson and
//              solves it right the first time.
// The scoreboard at the end is the point: steps, seconds, and $HERO, before vs after school.
//
//   HERO_AGENT_KEY_FILE=~/.hero-agent/keys/<wallet>.key node school.mjs [agentId]
import { agentTurn, vaultBootKey, writeMemory } from "../../src/tui/api.mjs";
import { universeReview, mintLesson, recallLessons, lessonsBlock } from "../../src/tui/universe.mjs";
import { mintCronAgent } from "../../src/wallet.mjs";

const STUDENT = process.env.STUDENT_MODEL || "gemma-4-31b@cerebras"; // small, fast, cheap
const TASK = process.env.TASK || "what are the largest files in my home folder? name the top few";
const keyFile = process.env.HERO_AGENT_KEY_FILE;
if (!keyFile) { console.error("Set HERO_AGENT_KEY_FILE (the wallet that owns the student agent)."); process.exit(1); }

const key = await vaultBootKey();
if (!key) { console.error("No HERO_RUN_KEY in the vault. hero-agent vault set HERO_RUN_KEY=…"); process.exit(1); }

// The student: a brand-new agent NFT unless one is passed in — so the first day of school is real.
let agentId = process.argv[2] || process.env.AGENT_ID;
if (!agentId) {
  console.log("minting a fresh student agent on Robinhood Chain…");
  const m = await mintCronAgent({ keyFile, label: "universe-school" });
  agentId = m.agentId;
  console.log(`student: agent #${agentId} (owned by ${m.address})\n`);
}

const baseSys = `You are Hero, a terminal agent on the user's macOS machine. Working directory: ${process.env.HOME}. You have tools: shell (30s limit), read_file, write_file, web_search. LOOK instead of guessing. Be concise; answer in markdown; never invent command output.`;

async function round(label, lessons) {
  const trace = [];
  const t0 = Date.now();
  const sys = lessonsBlock(lessons) + "\n\n" + baseSys;
  const out = await agentTurn({
    key, model: STUDENT, cwd: process.env.HOME,
    messages: [{ role: "system", content: sys }, { role: "user", content: TASK }],
    onTool: (name, args) => { trace.push({ name, args }); console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] · ${name}(${JSON.stringify(args).slice(0, 100)})`); },
    approve: async () => true, // the demo runs headless; the TUI keeps its y/n gates
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`  answer: ${out.text.split("\n")[0].slice(0, 120)}…`);
  console.log(`  ${label}: ${trace.length} tool step(s) · ${secs.toFixed(0)}s · ${Math.round(out.costHero)} $HERO\n`);
  return { trace, answer: out.text, secs, steps: trace.length, cost: out.costHero || 0 };
}

console.log(`ROUND 1 — no lessons. ${STUDENT} attempts: "${TASK}"`);
const r1 = await round("round 1", []);

console.log("CLASS — the Universe reviews the attempt…");
const { lesson, cost: reviewCost } = await universeReview({ key, task: TASK, trace: r1.trace, answer: r1.answer });
if (!lesson) { console.log("The Universe found no lesson (the student did fine). Try a harder TASK."); process.exit(0); }
console.log(`  the Universe teaches: "${lesson}"`);
const tx = await mintLesson(agentId, lesson);
console.log(`  minted on-chain to agent #${agentId} · tx ${tx.slice(0, 18)}…\n`);

console.log("ROUND 2 — same task, fresh conversation, lessons loaded from chain.");
const earned = await recallLessons(agentId);
console.log(`  ${earned.length} lesson(s) recalled from Robinhood Chain`);
const r2 = await round("round 2", earned);

console.log("═══ SCOREBOARD ═══");
console.log(`  round 1 (no lessons):   ${r1.steps} steps · ${r1.secs.toFixed(0)}s · ${Math.round(r1.cost)} $HERO`);
console.log(`  round 2 (after school): ${r2.steps} steps · ${r2.secs.toFixed(0)}s · ${Math.round(r2.cost)} $HERO`);
console.log(`  tuition (Universe review): ${Math.round(reviewCost)} $HERO, paid once — the lesson is on-chain forever.`);
