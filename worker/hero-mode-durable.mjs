// VENDORED from hero-foundry-web/lib/hero-mode-durable.js — keep byte-identical to the web copy.
// The browser seals runs with that file and this worker drives them; the two must agree on the
// on-chain format and on what "next step" means, so edit the web copy first and re-vendor.
// Durable Hero Mode: the on-chain memory IS the execution log, so a run defines its own
// start/resume/complete semantics and a harness (a worker cron) drives it. There is no orchestration
// loop anywhere: the worker executes exactly ONE step per tick, reads the log to see where the run is,
// and stops. Kill the worker, restart it, run it on another machine, the run resumes from the chain
// because the chain is the state.
//
// This module is deliberately pure and framework-free (no React, no viem, no network). The browser
// imports it to SEAL a run; the worker imports it to DRIVE one. Keeping the semantics in one place is
// what guarantees "sealed here, resumed there" actually agrees on what "next step" means.
//
// On-chain representation, all inside the agent's normal encrypted checkpoint chain:
//   - one PLAN entry, written once at seal time:
//       { role: "system", text: "heromode::" + JSON(task) }
//   - one STEP entry per completed step, appended as the run advances:
//       { role: "agent",  text: "step::"   + JSON({ index, result, at }) }
//   - one DONE entry when the run finishes (or fails), written once:
//       { role: "system", text: "heromodedone::" + JSON({ status, at }) }
// Progress is DERIVED from the log (count the step entries), never stored as a mutable cursor, so two
// drivers can never disagree about where the run is and a half-written tick cannot corrupt a counter.

export const HM_PLAN = "heromode::";
export const HM_STEP = "step::";
export const HM_DONE = "heromodedone::";

export const HERO_MODE_MAX_STEPS = 12; // hard ceiling, mirrors the interactive Hero Mode cap

// Build the sealed plan object + the checkpoint entry that carries it. `plan` is the step list the
// planning call produced. Bounds are clamped here so a bad input can never authorize an unbounded run
// that the worker would then dutifully drive, one paid step at a time, forever.
export function buildDurableTask({ runId, agentId, task, model = "auto", maxTokens = 700, maxSteps = 6, plan = [], createdAt }) {
  const steps = (Array.isArray(plan) ? plan : []).map((s) => String(s || "").trim()).filter(Boolean);
  const cap = Math.max(1, Math.min(Number(maxSteps) || 6, HERO_MODE_MAX_STEPS, steps.length || HERO_MODE_MAX_STEPS));
  const t = {
    v: 1,
    runId: String(runId),
    agentId: Number(agentId),
    task: String(task || "").slice(0, 2000),
    model: String(model || "auto"),
    maxTokens: Math.max(64, Math.min(Number(maxTokens) || 700, 4096)),
    maxSteps: cap,
    plan: steps.slice(0, cap),
    createdAt: createdAt || null, // stamped by the caller (this module never reads the clock)
  };
  return { task: t, entry: { role: "system", text: HM_PLAN + JSON.stringify(t) } };
}

// Parse the plan back out of a checkpoint entry. Returns null for anything that isn't a heromode plan.
export function parseDurableTask(entry) {
  const text = typeof entry === "string" ? entry : entry?.text;
  if (typeof text !== "string" || !text.startsWith(HM_PLAN)) return null;
  try { const t = JSON.parse(text.slice(HM_PLAN.length)); return t && t.v === 1 ? t : null; } catch { return null; }
}

// The completed steps, read out of the full checkpoint log in order. This is the resume state.
export function completedSteps(entries) {
  const out = [];
  for (const e of entries || []) {
    const text = e?.text;
    if (typeof text !== "string" || !text.startsWith(HM_STEP)) continue;
    try { const s = JSON.parse(text.slice(HM_STEP.length)); if (s && Number.isInteger(s.index)) out.push(s); } catch { /* skip malformed */ }
  }
  // Dedup by index (a retried tick could write the same step twice); keep the first, order by index.
  const byIndex = new Map();
  for (const s of out) if (!byIndex.has(s.index)) byIndex.set(s.index, s);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

// Has the run already been marked finished on-chain?
export function isMarkedDone(entries) {
  return (entries || []).some((e) => typeof e?.text === "string" && e.text.startsWith(HM_DONE));
}

// THE resume decision, the whole durable primitive in one pure function. Given the sealed task and the
// steps already on-chain, say what to do next: run a specific step, or the run is done. The harness
// calls this, acts on the single result, checkpoints, and returns. It never loops.
export function nextAction(task, done) {
  if (!task || !Array.isArray(task.plan)) return { kind: "done", reason: "no-plan" };
  const filled = done.length;
  if (filled >= task.plan.length) return { kind: "done", reason: "all-steps-complete" };
  if (filled >= task.maxSteps) return { kind: "done", reason: "step-cap-reached" };
  // The next step is simply the lowest index not yet filled. Deriving it from the set (not a stored
  // cursor) means an out-of-order or duplicated write self-heals: we always run the real gap.
  const have = new Set(done.map((s) => s.index));
  let index = 0;
  while (have.has(index)) index += 1;
  if (index >= task.plan.length) return { kind: "done", reason: "all-steps-complete" };
  return { kind: "step", index, step: task.plan[index], priorResults: done.map((s) => s.result) };
}

// The checkpoint entry a harness writes after finishing one step. `at` is passed in, not read here.
export function stepEntry(index, result, at) {
  return { role: "agent", text: HM_STEP + JSON.stringify({ index: Number(index), result: String(result || "").slice(0, 6000), at: at || null }) };
}

// The entry a harness writes once when the run is finished (or fails). `at` is passed in.
export function doneEntry(status, at) {
  return { role: "system", text: HM_DONE + JSON.stringify({ status: status === "failed" ? "failed" : "complete", at: at || null }) };
}

// Every durable run present in an agent's checkpoint log, with its derived progress. Usually one, but
// the format does not forbid more, so the worker iterates.
export function findTasks(entries) {
  const tasks = [];
  for (const e of entries || []) {
    const t = parseDurableTask(e);
    if (t) tasks.push(t);
  }
  const done = completedSteps(entries);
  const marked = isMarkedDone(entries);
  return tasks.map((task) => ({ task, done, isDone: marked || nextAction(task, done).kind === "done" }));
}

// Drive EXACTLY ONE step of a run, then stop. This is the whole harness contract: no loop, no retry
// storm, one unit of durable progress per call. Side effects are injected so the same function runs in
// the browser and in a Cloudflare worker unchanged, and so it is testable without a model or a chain:
//   runModel({ model, maxTokens, messages }) -> string   (one paid inference call)
//   checkpoint(entries)                      -> Promise    (one on-chain write, from the burner wallet)
//   now()                                    -> ISO string (injected: this module never reads the clock)
// Returns a small status so the caller (a cron) knows whether to schedule itself again.
export async function driveDurableStep({ task, entries, runModel, checkpoint, now }) {
  const done = completedSteps(entries);
  const action = nextAction(task, done);
  if (action.kind === "done") {
    if (!isMarkedDone(entries)) await checkpoint([doneEntry("complete", now())]);
    return { status: "complete", filled: done.length, total: task.plan.length };
  }
  // One inference call for this step. A throw propagates to the caller, which should fail-stop the run
  // (a bounded worker must never spin on a failing step, burning $HERO every tick).
  const result = await runModel({ model: task.model, maxTokens: task.maxTokens, messages: stepMessages(task, action) });
  // Effect before we claim progress: the checkpoint is the record. If it throws, the step is simply
  // not recorded and the next tick re-derives the same gap and retries it. Idempotent by construction.
  await checkpoint([stepEntry(action.index, result, now())]);
  const filled = done.length + 1;
  return { status: filled >= task.plan.length || filled >= task.maxSteps ? "final-step-done" : "stepped", index: action.index, filled, total: task.plan.length };
}

// ---- write-ahead event log (the working tier) ----------------------------------------------------
// The on-chain checkpoints above are the canonical, auditable record, but they are written AFTER a
// step completes, so on their own they cannot tell you a step was in flight when the process died.
// A cheap local append-only event log fixes that: the INTENT to run a unit is logged BEFORE the unit
// executes, and the result after. On resume you can see exactly what was attempted, redo only the one
// in-flight unit, and never re-run or lose a completed one. The log holds metadata only (which unit,
// when, model vs tool vs edit) never the content, which stays encrypted on-chain: so the working-tier
// log is safe to keep in plain localStorage or worker KV. This is what makes "every model call, tool
// run, and edit hits a local event log before it executes" literally true.
export const EV_INTENT = "intent";
export const EV_RESULT = "result";
export const EV_DONE = "done";

export function intentEvent(index, { kind = "model", redo = false, at } = {}) { return { t: EV_INTENT, index: Number(index), kind, redo: !!redo, at: at || null }; }
export function resultEvent(index, { kind = "model", at } = {}) { return { t: EV_RESULT, index: Number(index), kind, at: at || null }; }
export function doneEvent(at) { return { t: EV_DONE, at: at || null }; }

// Was this unit already started at least once (an intent logged for it)? A second intent means we are
// redoing a unit whose process died mid-flight, which the harness records so the audit trail is honest
// about the retry rather than hiding it.
export function wasStarted(events, index) {
  return (events || []).some((e) => e?.t === EV_INTENT && e.index === Number(index));
}

// A compact view of a run's state from both tiers, for a UI or a monitor: what the chain says is done,
// what the local log says was started, and any unit that was started but never completed on-chain.
export function resumeSummary(entries, events) {
  const done = completedSteps(entries).map((s) => s.index);
  const started = [...new Set((events || []).filter((e) => e?.t === EV_INTENT).map((e) => e.index))];
  const doneSet = new Set(done);
  return { completed: done, started, inFlight: started.filter((i) => !doneSet.has(i)), markedDone: isMarkedDone(entries) };
}

// The write-ahead harness step. Same one-unit-per-call contract as driveDurableStep, but it logs the
// intent to the local event log BEFORE the model call and the result after, while the on-chain
// checkpoint remains the resume authority (nextAction reads the chain, so a unit that crashed before
// its checkpoint is simply the next gap and gets redone, cleanly, deduped by index). Injected effects:
//   appendEvent(ev) -> Promise   (append one record to the local working-tier log)
//   runModel, checkpoint, now     (as in driveDurableStep)
export async function driveWithEventLog({ task, entries, events, appendEvent, runModel, checkpoint, now }) {
  const done = completedSteps(entries);
  const action = nextAction(task, done);
  if (action.kind === "done") {
    if (!isMarkedDone(entries)) { await appendEvent(doneEvent(now())); await checkpoint([doneEntry("complete", now())]); }
    return { status: "complete", filled: done.length, total: task.plan.length };
  }
  const redo = wasStarted(events, action.index); // a prior intent with no on-chain result = a crash mid-step
  // WRITE-AHEAD: the intent is durable in the local log before anything executes.
  await appendEvent(intentEvent(action.index, { redo, at: now() }));
  const result = await runModel({ model: task.model, maxTokens: task.maxTokens, messages: stepMessages(task, action) });
  // On-chain first (the authority), then the local result marker: if we crash between them, nextAction
  // still sees the step done on-chain next time, and the missing local marker is harmless metadata.
  await checkpoint([stepEntry(action.index, result, now())]);
  await appendEvent(resultEvent(action.index, { at: now() }));
  const filled = done.length + 1;
  return { status: filled >= task.plan.length || filled >= task.maxSteps ? "final-step-done" : "stepped", index: action.index, redo };
}

// The prompt a harness sends to the model for one step. Kept here so the browser preview and the
// worker send byte-identical instructions. Prior results are truncated so a long run's context can't
// grow unbounded (which would blow the token budget and the checkpoint size).
export function stepMessages(task, action) {
  const prior = (action.priorResults || []).slice(-3).map((r, i) => `Earlier result ${i + 1}: ${String(r).slice(0, 700)}`).join("\n");
  return [
    { role: "system", content: "You are Hero, running one step of a durable research and build task. Do only this step. Be concrete and self-contained: your output is checkpointed on-chain and read by the next step." },
    { role: "user", content: `Overall task: ${task.task}\n\n${prior ? prior + "\n\n" : ""}Now do step ${action.index + 1} of ${task.plan.length}: ${action.step}` },
  ];
}
