// Swarm tick: make spawned workers execute THEMSELVES — now MULTI-TASK.
//
// Originally one task per agent (swarm_spawn mints an agent per slice). Council "Broadcast to
// memory" changed the shape: it pools SEVERAL task:: entries on one agent, so the lane now works
// through ALL of them — one task per tick (pacing unchanged), each matched to its handoff by task
// index, progress derived from the log exactly like durable Hero Mode derives steps. No cursor,
// no state: kill the worker anywhere and the next tick re-derives the same gap.
//
// Compatibility: legacy single-task agents have a handoff:: with no taskIndex — that matches the
// only task they have. New handoffs carry {taskIndex} so N tasks and N handoffs pair up.
//
// Still no claim lease (a double-fired step costs one duplicate inference call), still a 3-attempt
// cap PER TASK ending in a visible FAILED handoff — an impossible task must not starve the rest of
// the pool, so the cap moves the lane to the next task instead of stopping the agent.

const TASK_MARK = "task::";
const HANDOFF_MARK = "handoff::";
const TRY_MARK = "swarmtry::";

const MAX_ATTEMPTS = 3;

const parse = (e, mark) => { try { return JSON.parse(String(e.text).slice(mark.length)); } catch { return null; } };

/**
 * One swarm step for one agent, at most one paid call.
 * Returns { acted, done, reason } so the tick log says what happened without spelunking.
 */
export async function runSwarmTick(mem, { chat, log = () => {} } = {}) {
  if (!chat) return { acted: false, reason: "no HERO_RUN_KEY" }; // same no-op rule as scheduled jobs

  const entries = await mem.raw();
  // All tasks, by index. Entries without an index (hand-written) get their position in arrival order.
  const tasks = [];
  for (const e of entries) {
    if (!String(e.text || "").startsWith(TASK_MARK)) continue;
    const t = parse(e, TASK_MARK) || { brief: String(e.text).slice(TASK_MARK.length) };
    tasks.push({ index: Number.isInteger(t.index) ? t.index : tasks.length, brief: t.brief || "", swarm: t.swarm || "" });
  }
  if (!tasks.length) return { acted: false, reason: "no task" };

  // Handoffs by task index. A legacy handoff (bare string or JSON without taskIndex) closes index 0 —
  // the only shape single-task agents ever had.
  const done = new Set();
  for (const e of entries) {
    if (!String(e.text || "").startsWith(HANDOFF_MARK)) continue;
    const h = parse(e, HANDOFF_MARK);
    done.add(Number.isInteger(h?.taskIndex) ? h.taskIndex : 0);
  }
  // Attempts per task index. Legacy try-markers (no idx) count against index 0.
  const tries = new Map();
  for (const e of entries) {
    if (!String(e.text || "").startsWith(TRY_MARK)) continue;
    const t = parse(e, TRY_MARK);
    const idx = Number.isInteger(t?.idx) ? t.idx : 0;
    tries.set(idx, (tries.get(idx) || 0) + 1);
  }

  // The next task is simply the lowest index not yet handed off — derived, never stored.
  const open = tasks.filter((t) => !done.has(t.index)).sort((a, b) => a.index - b.index);
  if (!open.length) return { acted: false, done: true, reason: "all tasks handed off" };
  const task = open[0];
  if (!task.brief.trim()) {
    await mem.append([{ role: "agent", text: HANDOFF_MARK + JSON.stringify({ taskIndex: task.index, text: "FAILED: empty brief", failed: true, at: new Date().toISOString() }) }]);
    return { acted: true, reason: "empty brief closed" };
  }

  const attempts = tries.get(task.index) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    // Terminal AND said, per task: closing this index moves the lane to the next task instead of
    // letting one impossible brief starve the whole pool.
    await mem.append([{ role: "agent", text: HANDOFF_MARK + JSON.stringify({ taskIndex: task.index, text: `FAILED after ${attempts} attempts. Brief: ${task.brief.slice(0, 200)}`, failed: true, at: new Date().toISOString() }) }]);
    log(`swarm: task ${task.index} gave up after ${attempts} attempts`);
    return { acted: true, reason: "attempt cap" };
  }

  // The attempt marker goes on-chain BEFORE the paid call, carrying the task index it counts against.
  await mem.append([{ role: "system", text: `${TRY_MARK}${JSON.stringify({ n: attempts + 1, idx: task.index, at: new Date().toISOString() })}` }]);

  log(`swarm: task ${task.index} (attempt ${attempts + 1}/${MAX_ATTEMPTS}) of ${tasks.length}`);
  const res = await chat({
    model: "auto",
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content:
          "You are one worker in a swarm. Do exactly the task below and reply with ONLY the result: " +
          "the findings, the answer, or the artifact. No preamble, no restating the task. " +
          "If the task cannot be done, start your reply with CANNOT: and say why in one line.",
      },
      { role: "user", content: task.brief },
    ],
  });

  const answer = String(res?.content ?? "").trim(); // makeChat returns { content, message, charged }
  if (!answer) throw new Error("model returned nothing"); // caught by serviceAgent; the strike above still counts
  await mem.append([{ role: "agent", text: HANDOFF_MARK + JSON.stringify({ taskIndex: task.index, text: answer, spentHero: res?.charged ?? null, tokIn: res?.tokIn ?? null, tokOut: res?.tokOut ?? null, at: new Date().toISOString() }) }]);
  const remaining = open.length - 1;
  log(`swarm: task ${task.index} handed off (${answer.length} chars)${remaining ? ` · ${remaining} task(s) remain` : " · pool complete"}`);
  return { acted: true, done: remaining === 0, reason: "handed off" };
}
