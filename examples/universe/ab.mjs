// Ablation: what is the curriculum actually worth?
// Same task, interleaved attempts (A B A B …): arm A runs BLIND (no lessons), arm B runs with the
// agent's on-chain lessons injected. Interleaving controls for provider drift and rate limits.
// Verdict = per-arm mean reward (solved, steps, time, cost), printed side by side.
//
//   HERO_AGENT_KEY_FILE=~/.hero-agent/keys/<wallet>.key node ab.mjs <agentId> [perArm]
import { agentTurn, vaultBootKey } from "../../src/tui/api.mjs";
import { recallLessons, lessonsBlock } from "../../src/tui/universe.mjs";

const STUDENT = process.env.STUDENT_MODEL || "gemma-4-31b@cerebras";
const TASK = process.env.TASK || "what are the largest files under ~/Desktop? name the top five with sizes";
const PER_ARM = Number(process.argv[3] || 3);
const agentId = process.argv[2];
if (!agentId) { console.error("Usage: node ab.mjs <agentId> [perArm]"); process.exit(1); }
const key = await vaultBootKey();

const baseSys = `You are Hero, a terminal agent on the user's macOS machine. Working directory: ${process.env.HOME}. You have tools: shell (30s limit), read_file, write_file, web_search. LOOK instead of guessing. Be concise; never invent command output.`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attempt(label, lessons) {
  const trace = []; const t0 = Date.now();
  let out;
  for (let tries = 0; ; tries++) {
    try {
      out = await agentTurn({
        key, model: STUDENT, cwd: process.env.HOME,
        messages: [{ role: "system", content: lessonsBlock(lessons) + "\n\n" + baseSys }, { role: "user", content: TASK }],
        onTool: (name, args) => trace.push({ name, args }),
        approve: async () => true,
      });
      break;
    } catch (e) {
      if (/429|quota|too_many/i.test(e.message) && tries < 3) { console.log("  (rate limited — 30s)"); await sleep(30_000); trace.length = 0; continue; }
      throw e;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  const solved = /\d/.test(out.text || "") && (out.text || "").length > 20 ? 1 : 0;
  const reward = solved * 100 - trace.length * 6 - secs / 10 - (out.costHero || 0) / 5000;
  console.log(`  ${label}: ${trace.length} steps · ${secs.toFixed(0)}s · ${Math.round(out.costHero)} $HERO · reward ${reward.toFixed(1)}`);
  return { steps: trace.length, secs, cost: out.costHero || 0, reward };
}

const lessons = await recallLessons(agentId);
console.log(`Curriculum under test: ${lessons.length} lesson(s) from agent #${agentId}`);
lessons.forEach((l) => console.log(`  - ${l.slice(0, 100)}`));
console.log(`\nTask: "${TASK}" · ${PER_ARM} attempt(s) per arm, interleaved\n`);

const A = [], B = [];
for (let i = 0; i < PER_ARM; i++) {
  if (i) await sleep(15_000);
  A.push(await attempt(`A${i + 1} (blind)  `, []));
  await sleep(15_000);
  B.push(await attempt(`B${i + 1} (lessons)`, lessons));
}

const mean = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
const row = (name, xs) => `  ${name}: reward ${mean(xs, (x) => x.reward).toFixed(1)} · ${mean(xs, (x) => x.steps).toFixed(1)} steps · ${mean(xs, (x) => x.secs).toFixed(0)}s · ${Math.round(mean(xs, (x) => x.cost))} $HERO`;
console.log("\n═══ ABLATION ═══");
console.log(row("A blind  ", A));
console.log(row("B lessons", B));
const d = mean(B, (x) => x.reward) - mean(A, (x) => x.reward);
console.log(`  Δ reward: ${d >= 0 ? "+" : ""}${d.toFixed(1)} ${Math.abs(d) < 3 ? "(within noise at this sample size)" : d > 0 ? "— the curriculum earns its place" : "— the curriculum is HURTING; prune it"}`);
if (PER_ARM < 3) console.log(`  ⚠ n=${PER_ARM} per arm is an anecdote, not statistics. Run with perArm >= 3 for a real verdict.`);
