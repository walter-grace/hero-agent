// The 20-task curriculum benchmark: compare-and-contrast at scale.
// For each task: one BLIND attempt (A) and one WITH-LESSONS attempt (B), interleaved. Per-task
// deltas, category rollups, aggregate verdict, and a JSON results file for later analysis.
//
// Fuel gate: waits for the key to hold enough $HERO before starting (poll every 30s, up to 2h),
// so it can be launched before the top-up lands and start itself.
//
//   HERO_AGENT_KEY_FILE=~/.hero-agent/keys/<wallet>.key node bench20.mjs <agentId>
import { writeFileSync } from "node:fs";
import { agentTurn, vaultBootKey, BASE } from "../../src/tui/api.mjs";
import { recallLessons, lessonsBlock } from "../../src/tui/universe.mjs";

const STUDENT = process.env.STUDENT_MODEL || "gemma-4-31b@cerebras";
const agentId = process.argv[2] || "16";
const NEED = 450_000; // ~40 attempts × ~11k avg, with headroom
const key = await vaultBootKey();

// 6 categories, 20 tasks. Kept cheap-ish (most are 1-3 tool steps) and varied enough that the
// curriculum should matter on some and be irrelevant on others — that contrast IS the experiment.
const TASKS = [
  { cat: "disk", q: "what are the three largest files under ~/Desktop? sizes please" },
  { cat: "disk", q: "which directory directly under ~/Desktop uses the most space?" },
  { cat: "disk", q: "how much free space does my main disk have?" },
  { cat: "disk", q: "find any files over 100MB in ~/Downloads and list them" },
  { cat: "git", q: "which repo under ~/Desktop had the most recent git commit? give repo and message" },
  { cat: "git", q: "how many commits does ~/Desktop/hero-agent have?" },
  { cat: "git", q: "what changed in the last commit of ~/Desktop/hero-agent? one line summary" },
  { cat: "code", q: "how many .mjs files are under ~/Desktop/hero-agent/src and which is largest?" },
  { cat: "code", q: "what does ~/Desktop/hero-agent/examples/secretless/bot.mjs do? two sentences" },
  { cat: "code", q: "which file in ~/Desktop/hero-agent/src/tui has the most lines?" },
  { cat: "sys", q: "what macOS version is this machine running and how much RAM does it have?" },
  { cat: "sys", q: "how many processes is node running right now?" },
  { cat: "sys", q: "what is my local IP address?" },
  { cat: "text", q: "count the words in ~/Desktop/hero-agent/README.md" },
  { cat: "text", q: "what is the first heading in ~/Desktop/hero-agent/examples/universe/README.md?" },
  { cat: "text", q: "list the slash commands mentioned in ~/Desktop/hero-agent/README.md" },
  { cat: "web", q: "what is the current price of ethereum roughly?" },
  { cat: "web", q: "what is the latest stable Node.js version?" },
  { cat: "mixed", q: "how many folders are on my Desktop and which was modified most recently?" },
  { cat: "mixed", q: "is port 3007 in use on this machine and by what?" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const balance = async () => {
  const r = await fetch(`${BASE}/api/keys/info`, { headers: { "x-api-key": key } });
  return (await r.json()).balance ?? 0;
};

// ---- fuel gate ----
let bal = await balance();
if (bal < NEED) {
  console.log(`FUEL GATE: key holds ${Math.round(bal).toLocaleString()} $HERO, need ~${NEED.toLocaleString()}.`);
  console.log(`Top up at ${BASE}/keys (load the hr_live_eb30… key). Polling every 30s, up to 2h…`);
  const t0 = Date.now();
  while (bal < NEED && Date.now() - t0 < 2 * 3600_000) { await sleep(30_000); bal = await balance(); }
  if (bal < NEED) { console.log("Timed out waiting for fuel. Re-run when topped up."); process.exit(1); }
  console.log(`Fuel arrived: ${Math.round(bal).toLocaleString()} $HERO. Starting.\n`);
}

const baseSys = `You are Hero, a terminal agent on the user's macOS machine. Working directory: ${process.env.HOME}. You have tools: shell (30s limit), read_file, write_file, web_search. LOOK instead of guessing. Be concise; never invent command output.`;

async function attempt(lessons, q) {
  const trace = []; const t0 = Date.now();
  let out;
  for (let tries = 0; ; tries++) {
    try {
      out = await agentTurn({
        key, model: STUDENT, cwd: process.env.HOME,
        messages: [{ role: "system", content: lessonsBlock(lessons) + "\n\n" + baseSys }, { role: "user", content: q }],
        onTool: (name, args) => trace.push({ name, args: JSON.stringify(args).slice(0, 120) }),
        approve: async () => true,
      });
      break;
    } catch (e) {
      if (/429|quota|too_many/i.test(e.message) && tries < 4) { await sleep(30_000); trace.length = 0; continue; }
      throw e;
    }
  }
  const secs = (Date.now() - t0) / 1000;
  const solved = /\d|`|\//.test(out.text || "") && (out.text || "").length > 20 ? 1 : 0;
  const reward = solved * 100 - trace.length * 6 - secs / 10 - (out.costHero || 0) / 5000;
  return { steps: trace.length, secs: +secs.toFixed(1), cost: Math.round(out.costHero || 0), reward: +reward.toFixed(1), solved, answer: String(out.text || "").slice(0, 300), trace };
}

const lessons = await recallLessons(agentId);
console.log(`Curriculum: ${lessons.length} lesson(s) from agent #${agentId} · student ${STUDENT} · 20 tasks × 2 arms\n`);

const results = [];
for (let i = 0; i < TASKS.length; i++) {
  const t = TASKS[i];
  process.stdout.write(`[${i + 1}/20] (${t.cat}) ${t.q.slice(0, 60)}…\n`);
  const A = await attempt([], t.q);
  await sleep(12_000);
  const B = await attempt(lessons, t.q);
  await sleep(12_000);
  const d = +(B.reward - A.reward).toFixed(1);
  console.log(`   A ${A.reward} (${A.steps}st ${A.secs}s) · B ${B.reward} (${B.steps}st ${B.secs}s) · Δ ${d >= 0 ? "+" : ""}${d}`);
  results.push({ ...t, A, B, delta: d });
  writeFileSync(`${process.env.HOME}/.hero-agent/bench20-results.json`, JSON.stringify({ agentId, student: STUDENT, lessons, results }, null, 2));
}

const mean = (xs, f) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
console.log("\n═══ VERDICT (20 tasks, A blind vs B lessons) ═══");
console.log(`  aggregate Δ reward: ${mean(results, (r) => r.delta).toFixed(1)} (positive = curriculum helps)`);
for (const cat of [...new Set(TASKS.map((t) => t.cat))]) {
  const rs = results.filter((r) => r.cat === cat);
  console.log(`  ${cat.padEnd(6)} Δ ${mean(rs, (r) => r.delta).toFixed(1)}  (${rs.length} tasks)`);
}
console.log(`  A means: ${mean(results, (r) => r.A.reward).toFixed(1)} reward · ${mean(results, (r) => r.A.steps).toFixed(1)} steps · ${Math.round(mean(results, (r) => r.A.cost))} $HERO`);
console.log(`  B means: ${mean(results, (r) => r.B.reward).toFixed(1)} reward · ${mean(results, (r) => r.B.steps).toFixed(1)} steps · ${Math.round(mean(results, (r) => r.B.cost))} $HERO`);
console.log(`\n  full data: ~/.hero-agent/bench20-results.json`);
