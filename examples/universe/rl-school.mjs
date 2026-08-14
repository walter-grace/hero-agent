// RL school: the Hero/Universe game with Karpathy-autoresearch discipline.
//
// The first school minted every lesson the Universe wrote; live testing showed vague lessons change
// nothing. This version earns its mints:
//   1. ROLLOUTS   — N independent attempts at the task (the model's stochasticity becomes data)
//   2. REWARD     — each rollout scored: fewer steps, less time, lower cost, answer non-empty
//   3. CONTRAST   — the Universe sees the BEST and WORST traces side by side and distills the
//                   DIFFERENCE (concrete by construction, no platitudes possible)
//   4. GATE       — a validation attempt runs WITH the candidate lesson; it mints ONLY if it beats
//                   the rollout median's reward. Rejected lessons never touch the chain.
//
//   HERO_AGENT_KEY_FILE=~/.hero-agent/keys/<wallet>.key node rl-school.mjs <agentId> [rollouts]
import { agentTurn, vaultBootKey } from "../../src/tui/api.mjs";
import { universeReview, mintLesson, recallLessons, lessonsBlock, UNIVERSE_MODEL } from "../../src/tui/universe.mjs";
import { BASE } from "../../src/tui/api.mjs";

const STUDENT = process.env.STUDENT_MODEL || "gemma-4-31b@cerebras";
const TASK = process.env.TASK || "how many .mjs files are under ~/Desktop/hero-agent/src/tui and which one is largest? give exact numbers";
const N = Number(process.argv[3] || 3);
const agentId = process.argv[2];
if (!agentId) { console.error("Usage: node rl-school.mjs <agentId> [rollouts]"); process.exit(1); }
const key = await vaultBootKey();

const baseSys = `You are Hero, a terminal agent on the user's macOS machine. Working directory: ${process.env.HOME}. You have tools: shell (30s limit), read_file, write_file, web_search. LOOK instead of guessing. Be concise; never invent command output.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function attempt(label, lessons) {
  const trace = []; const t0 = Date.now();
  let out;
  for (let tries = 0; ; tries++) {
    try { out = await agentTurn({
    key, model: STUDENT, cwd: process.env.HOME,
    messages: [{ role: "system", content: lessonsBlock(lessons) + "\n\n" + baseSys }, { role: "user", content: TASK }],
    onTool: (name, args) => trace.push({ name, args }),
    approve: async () => true,
  }); break; }
    catch (e) {
      if (/429|quota|too_many/i.test(e.message) && tries < 3) { console.log(`  (rate limited — waiting 30s)`); await sleep(30_000); trace.length = 0; continue; }
      throw e;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  // Reward: solved (answer has digits = gave numbers) dominates; then fewer steps, less time, less cost.
  const solved = /\d/.test(out.text || "") && (out.text || "").length > 20 ? 1 : 0;
  const reward = solved * 100 - trace.length * 6 - secs / 10 - (out.costHero || 0) / 5000;
  console.log(`  ${label}: ${trace.length} steps · ${secs.toFixed(0)}s · ${Math.round(out.costHero)} $HERO · reward ${reward.toFixed(1)}`);
  return { trace, answer: out.text, secs, steps: trace.length, cost: out.costHero || 0, reward };
}

console.log(`ROLLOUTS — ${N} independent attempts, no lessons. Task: "${TASK}"`);
const prior = await recallLessons(agentId);
const rollouts = [];
for (let i = 0; i < N; i++) { if (i) await sleep(15_000); rollouts.push(await attempt(`rollout ${i + 1}`, prior)); }
const sorted = [...rollouts].sort((a, b) => b.reward - a.reward);
const best = sorted[0], worst = sorted[sorted.length - 1];
const median = sorted[Math.floor(sorted.length / 2)].reward;
console.log(`  best ${best.reward.toFixed(1)} · median ${median.toFixed(1)} · worst ${worst.reward.toFixed(1)}\n`);

console.log("CONTRAST — the Universe compares the best and worst attempts…");
const traceStr = (t) => t.trace.map((x) => `${x.name}(${JSON.stringify(x.args).slice(0, 120)})`).join("; ");
const { lesson, cost: reviewCost } = await universeReview({
  key,
  task: TASK,
  trace: [
    { name: "BEST_ATTEMPT", args: { steps: best.steps, secs: Math.round(best.secs), commands: traceStr(best) } },
    { name: "WORST_ATTEMPT", args: { steps: worst.steps, secs: Math.round(worst.secs), commands: traceStr(worst) } },
  ],
  answer: `Best answer: ${String(best.answer).slice(0, 400)}\nWorst answer: ${String(worst.answer).slice(0, 400)}\nDistill what the best attempt did that the worst did not.`,
});
if (!lesson) { console.log("  NO_LESSON — attempts were equivalent. Nothing mints. (That is the gate working.)"); process.exit(0); }
console.log(`  candidate lesson: "${lesson}"\n`);

console.log("GATE — validation attempt WITH the candidate lesson. Mint only if it beats the median.");
const val = await attempt("validation", [...prior, lesson]);
if (val.reward > median) {
  const tx = await mintLesson(agentId, lesson);
  console.log(`\n✓ ACCEPTED: validation reward ${val.reward.toFixed(1)} > median ${median.toFixed(1)}`);
  console.log(`  minted to agent #${agentId} · tx ${tx.slice(0, 18)}… · tuition ${Math.round(reviewCost)} $HERO`);
} else {
  console.log(`\n✗ REJECTED: validation reward ${val.reward.toFixed(1)} <= median ${median.toFixed(1)}`);
  console.log("  The lesson did not measurably help, so it does NOT touch the chain. No platitudes in the curriculum.");
}
