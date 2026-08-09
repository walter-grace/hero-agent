// Swarm tick: make spawned workers execute THEMSELVES.
//
// swarm_spawn (hero-run-mcp) mints one agent per slice of work and seeds it with a `task::` entry.
// Without this file the harness that spawned them still has to drive every worker by hand, which
// makes the swarm a to-do list rather than a workforce. This lane closes the loop: each cron tick,
// an agent holding an unanswered task runs it — one paid inference call — and records the result as
// the `handoff::` entry swarm_collect already reads.
//
// Deliberately NO claim lease, following the Hero Mode precedent rather than TWAP's: a double-fired
// step here costs one duplicate inference call, not a duplicate swap, and the lease itself would be
// an extra transaction per step. What it DOES have that Hero Mode lacks is an attempt cap, because
// the failure mode is different: a task can be impossible (bad brief, model refusal), and an
// impossible task with no cap is a 288-calls-a-day leak from the operator's key until someone
// notices. Three strikes, then a FAILED handoff so the swarm terminates visibly instead of burning.

const TASK_MARK = "task::";
const HANDOFF_MARK = "handoff::";
const TRY_MARK = "swarmtry::";

const MAX_ATTEMPTS = 3;

/**
 * One swarm step for one agent, at most one paid call.
 * Returns { acted, done, reason } so the tick log says what happened without spelunking.
 */
export async function runSwarmTick(mem, { chat, log = () => {} } = {}) {
  if (!chat) return { acted: false, reason: "no HERO_RUN_KEY" }; // same no-op rule as scheduled jobs

  const entries = await mem.raw();
  const task = entries.filter((e) => String(e.text || "").startsWith(TASK_MARK)).pop();
  if (!task) return { acted: false, reason: "no task" };
  // Any handoff means this worker already reported — a swarm worker carries exactly one brief.
  if (entries.some((e) => String(e.text || "").startsWith(HANDOFF_MARK))) {
    return { acted: false, done: true, reason: "already handed off" };
  }

  let brief = "", swarm = "";
  try { const t = JSON.parse(task.text.slice(TASK_MARK.length)); brief = t.brief || ""; swarm = t.swarm || ""; }
  catch { brief = task.text.slice(TASK_MARK.length); }
  if (!brief.trim()) return { acted: false, reason: "empty brief" };

  const attempts = entries.filter((e) => String(e.text || "").startsWith(TRY_MARK)).length;
  if (attempts >= MAX_ATTEMPTS) {
    // Terminal, and it must be SAID, not just stopped: a worker that silently goes quiet reads as
    // "still running" in swarm_collect forever, and the whole point of the cap is to end that.
    await mem.append([{ role: "agent", text: HANDOFF_MARK + JSON.stringify({ text: `FAILED after ${attempts} attempts. Brief: ${brief.slice(0, 200)}`, failed: true, at: new Date().toISOString() }) }]);
    log(`swarm: gave up after ${attempts} attempts`);
    return { acted: true, done: true, reason: "attempt cap" };
  }

  // The attempt marker goes on-chain BEFORE the paid call. If the call (or this worker) dies, the
  // next tick still sees the strike; recording it after would make a crash-looping step invisible
  // to the cap it exists for.
  await mem.append([{ role: "system", text: `${TRY_MARK}${JSON.stringify({ n: attempts + 1, at: new Date().toISOString() })}` }]);

  log(`swarm: running task (attempt ${attempts + 1}/${MAX_ATTEMPTS})`);
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
      { role: "user", content: brief },
    ],
  });

  const answer = String(res?.content ?? "").trim(); // makeChat returns { content, message, charged }
  if (!answer) throw new Error("model returned nothing"); // caught by serviceAgent; the strike above still counts
  // JSON handoff so the cost travels WITH the result. Readers accept both shapes: this JSON and the
  // legacy bare string — a format change must never make old handoffs unreadable.
  await mem.append([{ role: "agent", text: HANDOFF_MARK + JSON.stringify({ text: answer, spentHero: res?.charged ?? null, at: new Date().toISOString() }) }]);
  log(`swarm: handed off ${answer.length} chars${swarm ? ` (swarm "${swarm}")` : ""}`);
  return { acted: true, done: true, reason: "handed off" };
}
