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

// A step whose text starts with this marker is answered by a LIVE-SEARCH model instead of the run's
// chosen model. That keeps the contract that makes this whole thing bounded and resumable — exactly
// ONE paid call per step — while still letting a run reach today's web. A tool loop would have been
// the obvious alternative and is the wrong shape here: it makes a step's cost unbounded and its
// call count unpredictable, which the cron driver and the $HERO budget both depend on.
// The marker lives inside the step's own text, so a sealed v1 plan needs no format change and older
// plans keep working (nothing marked = nothing searched).
export const HM_SEARCH = "[search]";
export const HERO_SEARCH_MODEL = "perplexity/sonar"; // same live-search model the Hero Agent uses
export const needsSearch = (step) => String(step || "").trim().toLowerCase().startsWith(HM_SEARCH);
export const stripSearchMark = (step) => String(step || "").trim().replace(/^\[search\]\s*/i, "");

// Build the sealed plan object + the checkpoint entry that carries it. `plan` is the step list the
// planning call produced. Bounds are clamped here so a bad input can never authorize an unbounded run
// that the worker would then dutifully drive, one paid step at a time, forever.
export function buildDurableTask({ runId, agentId, task, model = "auto", maxTokens = 700, maxSteps = 6, plan = [], tools = [], createdAt }) {
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
    // Tools the cloud worker may use for this run. Sealed WITH the plan on purpose: the worker reads
    // the plan off-chain and must not be able to acquire capabilities the owner did not approve.
    //
    // ⚠️ A token here is written INTO the checkpoint. The checkpoint is encrypted and only the owning
    // wallet can read it, but it is also permanent and on a public chain: it cannot be deleted, and a
    // key that leaks later exposes it retroactively. Keyless servers carry no token and have none of
    // that exposure, which is why they are the default and a token is strictly opt-in per server.
    tools: sanitizeTools(tools),
    createdAt: createdAt || null, // stamped by the caller (this module never reads the clock)
  };
  return { task: t, entry: { role: "system", text: HM_PLAN + JSON.stringify(t) } };
}

// Normalise the tool list a run is allowed to use. Everything is clamped here rather than trusted
// from the caller, because this is what authorises a worker to spend money and reach the network.
export function sanitizeTools(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((t) => ({
      id: String(t?.id || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 32),
      name: String(t?.name || "").slice(0, 40),
      url: String(t?.url || "").slice(0, 300),
      // Only ever an allowlist: a server with no allowed tools contributes nothing, so a stale entry
      // fails closed instead of exposing whatever that server happens to offer today.
      allowed: (Array.isArray(t?.allowed) ? t.allowed : []).map((x) => String(x).slice(0, 64)).slice(0, 24),
      ...(t?.token ? { token: String(t.token).slice(0, 400) } : {}),
    }))
    .filter((t) => t.id && /^https:\/\//.test(t.url) && t.allowed.length)
    .slice(0, 4); // a run with a dozen servers is a runaway bill, not a feature
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
export function stepEntry(index, result, at, spentHero = null, tokens = null) {
  // spentHero is what the step's inference call charged, recorded AT PAY TIME because a cost that
  // is not written into the entry when it happens is unknowable later. Optional and additive: old
  // callers pass three args and produce exactly the old entry shape.
  return { role: "agent", text: HM_STEP + JSON.stringify({ index: Number(index), result: String(result || "").slice(0, 6000), at: at || null, ...(Number.isFinite(spentHero) ? { spentHero } : {}), ...(Number.isFinite(tokens?.tokIn) ? { tokIn: tokens.tokIn } : {}), ...(Number.isFinite(tokens?.tokOut) ? { tokOut: tokens.tokOut } : {}) }) };
}

// The entry a harness writes once when the run is finished, fails, or is cancelled. `at` is passed in.
//
// "cancelled" exists so stopping a run tells the truth. Cancelling IS writing this marker: the worker
// treats any done marker as terminal and deregisters the run on its next tick, so an owner can halt
// their own run with a checkpoint they are already entitled to write, and no new authority is needed
// anywhere. Recording it as "complete" would have made a stopped run indistinguishable from a
// finished one, forever, in a log that cannot be edited.
const DONE_STATUSES = new Set(["complete", "failed", "cancelled"]);
export function doneEntry(status, at) {
  const st = DONE_STATUSES.has(status) ? status : "complete";
  return { role: "system", text: HM_DONE + JSON.stringify({ status: st, at: at || null }) };
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

// What a run looks like right now, for a human. Derived entirely from the log, like everything else
// here, so it needs no stored state and cannot disagree with what the worker will do next.
//
// `staleMs` is what separates "running" from "stalled". A durable run advances one step per cron
// tick, so silence is only meaningful in multiples of that tick: the default allows three missed
// ticks of a */5 cron before calling it stalled, which is long enough to absorb a slow model or a
// laggy RPC and short enough to notice within a coffee break.
//
// A stalled run is the failure that would otherwise be invisible. The loud failures already write a
// marker: two step errors write status "failed". The quiet ones cannot — a session wallet out of gas
// cannot even afford the checkpoint that would record its own death — so they can only ever be
// detected by absence, which is exactly what this measures.
export function runStatus(entries, { now = Date.now(), staleMs = 15 * 60_000 } = {}) {
  const out = [];
  const done = completedSteps(entries);
  const marker = (entries || []).find((e) => typeof e?.text === "string" && e.text.startsWith(HM_DONE));
  let finished = null;
  if (marker) { try { finished = JSON.parse(marker.text.slice(HM_DONE.length)); } catch { finished = { status: "complete" }; } }

  for (const e of entries || []) {
    const task = parseDurableTask(e);
    if (!task) continue;
    const total = (task.plan || []).length;
    const completed = done.length;
    // Newest timestamp anywhere in this run, so "quiet for how long" survives out-of-order writes.
    const stamps = [task.createdAt, ...done.map((d) => d.at), finished?.at].map((t) => Date.parse(t || "")).filter((n) => Number.isFinite(n));
    const lastAt = stamps.length ? Math.max(...stamps) : null;
    const quietMs = lastAt ? Math.max(0, now - lastAt) : null;
    const state = finished
      ? (finished.status === "failed" ? "failed" : finished.status === "cancelled" ? "cancelled" : "complete")
      : (quietMs != null && quietMs > staleMs ? "stalled" : "running");
    out.push({ runId: task.runId, agentId: task.agentId, task: task.task, state, completed, total, lastAt, quietMs, tools: (task.tools || []).map((t) => t.name) });
  }
  return out;
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
  const at = now();
  // A marked step overrides the run's model for that one call. Cost stays one call either way.
  const model = needsSearch(action.step) ? HERO_SEARCH_MODEL : task.model;
  const r = await runModel({ model, maxTokens: task.maxTokens, messages: stepMessages(task, action, at) });
  // runModel may return a bare string (every existing harness) or { text, spentHero } (a harness
  // that reports what the call charged). Both are first-class; cost is recorded when known.
  const result = typeof r === "string" ? r : String(r?.text ?? "");
  const spent = typeof r === "object" && Number.isFinite(r?.spentHero) ? r.spentHero : null;
  const toks = typeof r === "object" ? { tokIn: r?.tokIn, tokOut: r?.tokOut } : null;
  // Effect before we claim progress: the checkpoint is the record. If it throws, the step is simply
  // not recorded and the next tick re-derives the same gap and retries it. Idempotent by construction.
  await checkpoint([stepEntry(action.index, result, at, spent, toks)]);
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
  const r = await runModel({ model: needsSearch(action.step) ? HERO_SEARCH_MODEL : task.model, maxTokens: task.maxTokens, messages: stepMessages(task, action, now()) });
  const result = typeof r === "string" ? r : String(r?.text ?? "");
  const spent = typeof r === "object" && Number.isFinite(r?.spentHero) ? r.spentHero : null;
  const toks = typeof r === "object" ? { tokIn: r?.tokIn, tokOut: r?.tokOut } : null;
  // On-chain first (the authority), then the local result marker: if we crash between them, nextAction
  // still sees the step done on-chain next time, and the missing local marker is harmless metadata.
  await checkpoint([stepEntry(action.index, result, now(), spent, toks)]);
  await appendEvent(resultEvent(action.index, { at: now() }));
  const filled = done.length + 1;
  return { status: filled >= task.plan.length || filled >= task.maxSteps ? "final-step-done" : "stepped", index: action.index, redo };
}

// The prompt a harness sends to the model for one step. Kept here so the browser preview and the
// worker send byte-identical instructions. Prior results are truncated so a long run's context can't
// grow unbounded (which would blow the token budget and the checkpoint size).
// `nowIso` is passed in, never read here (this module stays clock-free so runs are deterministic to
// test). Without it a model answers from its training cutoff and quietly produces stale work — the
// single most common way a run looks confidently wrong.
export function stepMessages(task, action, nowIso) {
  const prior = (action.priorResults || []).slice(-3).map((r, i) => `Earlier result ${i + 1}: ${String(r).slice(0, 700)}`).join("\n");
  const search = needsSearch(action.step);
  const today = nowIso ? String(nowIso).slice(0, 10) : null;
  const dateLine = today ? `Today's date is ${today}. Treat anything you remember as potentially out of date, and say so when it matters.` : "";
  return [
    { role: "system", content: `You are Hero, running one step of a durable research and build task. Do only this step. Be concrete and self-contained: your output is checkpointed on-chain and read by the next step.${dateLine ? " " + dateLine : ""}${search ? " This step needs CURRENT information: search the live web, and cite what you found with dates and sources." : ""}` },
    { role: "user", content: `Overall task: ${task.task}\n\n${prior ? prior + "\n\n" : ""}Now do step ${action.index + 1} of ${task.plan.length}: ${stripSearchMark(action.step)}` },
  ];
}
