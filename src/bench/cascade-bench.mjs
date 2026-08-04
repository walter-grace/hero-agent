// Cascade eval: measure the cost/quality tradeoff of a FrugalGPT-style cascade against single-model
// baselines and today's route-once `auto`, on a small mixed-difficulty task set with OBJECTIVE gold
// scoring (no LLM judge in the grader — the cascade's own judge must not grade itself).
//
// Arms:
//   cheap     — one small model on every task
//   frontier  — one strong model on every task
//   auto      — Hero Run's route-once picker (today's behavior)
//   cascade   — draft on the cheap model, a free structural gate, then a cheap 0-10 LLM-judge; escalate
//               to frontier once if the draft looks weak (this is the policy proposed for `auto`)
//
// Reports per arm: accuracy, cost ($HERO + USD), and for cascade the escalation rate and the headline
// "quality retained at X% of frontier cost". The number that decides shipping is cascade-vs-auto.
//
// The papers: FrugalGPT (cascade, arXiv 2305.05176), Hybrid LLM (2404.14618), RouteLLM (2406.18665).

import { heroUsd } from "../provider.mjs";

// ---- task set: ~50% trivial, ~30% medium, ~20% hard, all objectively gradable ------------------
export const CASCADE_TASKS = [
  { id: "cap-fr", q: "What is the capital of France? Answer with one word.", gold: "Paris", grade: "contains", tier: "easy" },
  { id: "sent", q: "Classify the sentiment as POSITIVE or NEGATIVE: \"I absolutely loved it.\" Answer with one word.", gold: "POSITIVE", grade: "contains", tier: "easy" },
  { id: "arith", q: "What is 47 + 68? Answer with just the number.", gold: "115", grade: "number", tier: "easy" },
  { id: "mcq-planet", q: "Which is the largest planet? A) Earth B) Jupiter C) Mars D) Venus. Answer with just the letter.", gold: "B", grade: "mcq", tier: "easy" },
  { id: "spell", q: "How many letter 'r's are in the word \"strawberry\"? Answer with just the number.", gold: "3", grade: "number", tier: "medium" },
  { id: "rate", q: "A train travels 90 miles in 1.5 hours. What is its average speed in mph? Answer with just the number.", gold: "60", grade: "number", tier: "medium" },
  { id: "mcq-logic", q: "If all Bloops are Razzies and all Razzies are Lazzies, are all Bloops definitely Lazzies? A) Yes B) No C) Cannot tell. Answer with just the letter.", gold: "A", grade: "mcq", tier: "medium" },
  { id: "gsm", q: "A shop sells pens at 3 for $2. Maria buys 12 pens and pays with a $20 bill. How much change does she get, in dollars? Answer with just the number.", gold: "12", grade: "number", tier: "hard" },
  { id: "gsm2", q: "A tank holds 240 liters. It drains at 8 L/min for 10 minutes, then is refilled at 20 L/min for 6 minutes. How many liters are in it now? Answer with just the number.", gold: "280", grade: "number", tier: "hard" },
  { id: "date", q: "If today is Wednesday, what day of the week is 100 days from now? Answer with the day name.", gold: "Friday", grade: "contains", tier: "hard" },
];

// ---- objective grading (no model calls) --------------------------------------------------------
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const lastNumber = (s) => { const m = String(s || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/g); return m ? Number(m[m.length - 1]) : NaN; };
const firstLetter = (s) => { const m = String(s || "").toUpperCase().match(/\b([A-D])\b/); return m ? m[1] : null; };
function grade(answer, task) {
  if (task.grade === "number") return lastNumber(answer) === Number(task.gold);
  if (task.grade === "mcq") return firstLetter(answer) === task.gold;
  return norm(answer).includes(norm(task.gold)); // contains
}

// ---- the cascade policy (client-side; mirrors the proposed `auto` upgrade) ----------------------
const REFUSE = /\b(i(?:'m| am)? ?(?:not sure|unsure)|i can(?:'|no)?t|i don'?t know|as an ai|cannot help)\b/i;
function freeGateFails(draft) {
  const t = String(draft || "").trim();
  return t.length === 0 || REFUSE.test(t);
}
async function judgeScore(chat, judgeModel, q, draft) {
  const msg = await chat({
    model: judgeModel, maxTokens: 6,
    messages: [{ role: "user", content:
      `Grade whether the draft correctly and completely answers the question.\nQ: ${q}\nDraft: ${draft}\n` +
      `Reply with ONLY one integer 0-10 (10 = certainly correct and complete).` }],
  });
  const n = lastNumber(msg.content);
  return { score: Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0, cost: charged(msg) };
}
const charged = (msg) => Number(msg?.x_hero?.charged_hero || 0);

async function runArm(arm, task, { chat, cheap, frontier, judge, threshold }) {
  if (arm === "cascade") {
    const draft = await chat({ model: cheap, maxTokens: 256, messages: [{ role: "user", content: task.q }] });
    let cost = charged(draft), escalated = false, answer = draft.content, why = "kept draft";
    if (freeGateFails(draft.content)) { escalated = true; why = "free gate (refusal/empty)"; }
    else {
      const j = await judgeScore(chat, judge, task.q, draft.content); cost += j.cost;
      if (j.score < threshold) { escalated = true; why = `judge ${j.score}<${threshold}`; }
    }
    if (escalated) { const f = await chat({ model: frontier, maxTokens: 256, messages: [{ role: "user", content: task.q }] }); cost += charged(f); answer = f.content; }
    return { answer, cost, escalated, why };
  }
  const model = arm === "cheap" ? cheap : arm === "frontier" ? frontier : "auto";
  const msg = await chat({ model, maxTokens: 256, messages: [{ role: "user", content: task.q }] });
  return { answer: msg.content, cost: charged(msg), escalated: false, resolved: msg?.x_hero?.resolved_model };
}

// ---- run the whole eval ------------------------------------------------------------------------
export async function runCascadeBench({ chat, tasks = CASCADE_TASKS, arms = ["cheap", "frontier", "auto", "cascade"],
  cheap = "cheapest", frontier = "anthropic/claude-sonnet-5", judge = "openai/gpt-oss-20b", threshold = 6,
  usd = 0, onEvent = () => {} }) {
  const agg = {};
  for (const a of arms) agg[a] = { arm: a, solved: 0, total: 0, costHero: 0, escalated: 0 };
  for (const task of tasks) {
    for (const a of arms) {
      let r; try { r = await runArm(a, task, { chat, cheap, frontier, judge, threshold }); }
      catch (e) { r = { answer: "", cost: 0, escalated: false, err: e.message }; }
      const ok = grade(r.answer, task);
      const A = agg[a]; A.total++; A.costHero += r.cost; if (ok) A.solved++; if (r.escalated) A.escalated++;
      onEvent("cell", { task: task.id, tier: task.tier, arm: a, ok, escalated: r.escalated, why: r.why, cost: r.cost, err: r.err });
    }
  }
  for (const a of arms) {
    const A = agg[a];
    A.accuracy = A.total ? A.solved / A.total : 0;
    A.costUsd = A.costHero * usd;
    A.escalationRate = a === "cascade" && A.total ? A.escalated / A.total : null;
  }
  // headline: cascade vs frontier + cascade vs auto
  const f = agg.frontier, c = agg.cascade, au = agg.auto;
  const summary = {};
  if (f && c) summary.qualityRetained = f.accuracy ? c.accuracy / f.accuracy : null, summary.costFraction = f.costHero ? c.costHero / f.costHero : null;
  if (au && c) summary.vsAuto = { costDeltaHero: c.costHero - au.costHero, accDelta: c.accuracy - au.accuracy };
  return { arms: agg, summary, tasks: tasks.length };
}

export { heroUsd };

// ---- test hook: a stubbed chat() so the eval logic can run with no key / no cost -----------------
// Models a realistic cascade win: the cheap model nails easy+medium tasks but fails hard ones; the
// judge scores a wrong draft low (→ escalate) and a right draft high; frontier/auto always answer
// correctly. Lets us verify grading, aggregation, escalation, and reporting deterministically.
export function makeStubChat({ cheap = "cheapest", frontier = "anthropic/claude-sonnet-5" } = {}) {
  const findByQ = (p) => CASCADE_TASKS.find((t) => p.includes(t.q.slice(0, 24)));
  const goldOf = (t) => (t ? t.gold : "");
  const isRight = (ans, t) => t && grade(ans, t);
  return async ({ model, messages }) => {
    const p = messages[messages.length - 1].content;
    const wrap = (content, hero) => ({ content, x_hero: { charged_hero: hero, resolved_model: model === "auto" ? "auto→gpt-oss-20b" : model } });
    if (/Reply with ONLY one integer/.test(p)) {           // judge call
      const t = findByQ(p);
      const dm = p.match(/Draft:\s*([\s\S]*?)\nReply/);
      const draft = dm ? dm[1].trim() : "";
      return wrap(isRight(draft, t) ? "9" : "3", 0.0001);
    }
    const t = findByQ(p);
    if (model === frontier || model === "auto") return wrap(goldOf(t), model === frontier ? 0.006 : 0.004);
    // cheap model: right on easy/medium, wrong on hard
    const ans = t && t.tier !== "hard" ? goldOf(t) : (t?.grade === "mcq" ? "Z" : t?.grade === "number" ? "0" : "unknown");
    return wrap(ans, 0.0004);
  };
}
