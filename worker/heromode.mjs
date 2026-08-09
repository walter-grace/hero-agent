// Durable Hero Mode driver: continues a sealed research/build run from on-chain memory after the
// tab is gone. The memory graph's "Run durably" panel seals the plan (`heromode::` entry) into a
// burner-owned agent; this tick reads the log, derives the next unfilled step, runs ONE paid
// inference call for it, and checkpoints the result back (`step::`). The chain is the state — kill
// this worker and any other worker that can read the log resumes at the same gap.
//
// Same conservatism as the durable TWAP executor: one step per tick per agent (pacing), every
// result on-chain, and fail-stop the run the moment a step errors twice — a failing step must never
// burn $HERO every tick forever. Unlike TWAP there is no claim lease: a double-fired step costs one
// wasted inference call and a duplicate `step::` entry that dedups by index, so the log self-heals.
import { findTasks, completedSteps, nextAction, driveDurableStep, doneEntry, isMarkedDone } from "./hero-mode-durable.mjs";
import { loadPlanTools, runStepWithTools, TOOL_SAFETY_NOTE } from "./mcp-tools.mjs";

export const HM_FAIL_MARK = "heromodefail::"; // one per failed attempt; two on a step halts the run

export function parseFails(entries) {
  const out = [];
  for (const e of entries || []) {
    if (typeof e.text !== "string" || !e.text.startsWith(HM_FAIL_MARK)) continue;
    try { const f = JSON.parse(e.text.slice(HM_FAIL_MARK.length)); if (Number.isInteger(f.index)) out.push(f); } catch {}
  }
  return out;
}

// A record that MUST land retries hard; the fail counter is what stops a run from spending forever,
// so losing a fail write would let the next tick pay for the same broken step again.
async function appendHard(mem, entries, log, tries = 3) {
  for (let a = 0; a < tries; a++) {
    try { await mem.append(entries); return true; }
    catch (e) { log(`heromode write retry ${a + 1}: ${String(e.message).slice(0, 60)}`); await new Promise((r) => setTimeout(r, 3000)); }
  }
  return false;
}

// The per-agent tick: read the log, drive at most ONE step, checkpoint the outcome. `chat` is the
// worker's Hero Run brain ({model, messages, maxTokens} -> {content}); without one there is nothing
// to drive with, so the tick is a no-op. Returns allDone once the run's done marker is on-chain, so
// the shared path knows when to deregister.
export async function runHeroModeTick(mem, { chat, now = () => new Date().toISOString(), log = () => {} } = {}) {
  if (!chat) return { tasks: 0, acted: 0, allDone: false };
  const entries = await mem.raw().catch((e) => { log(`heromode: memory unreadable — ${String(e.message).slice(0, 80)}`); return null; });
  if (!entries) return { tasks: 0, acted: 0, allDone: false };
  const tasks = findTasks(entries);
  if (!tasks.length) return { tasks: 0, acted: 0, allDone: false };
  // The done marker is per-agent, and a durable agent carries exactly one run by construction, so a
  // marked log means every run here is finished (complete or halted).
  if (isMarkedDone(entries)) return { tasks: tasks.length, acted: 0, allDone: true };
  const fails = parseFails(entries);
  let acted = 0;
  // Connected MCP servers for the run currently being driven. null = not attempted yet, [] = tried
  // and none usable. Scoped per task inside the loop so one run's servers never leak into another's.
  let live = null;
  for (const { task } of tasks) {
    live = null;
    const action = nextAction(task, completedSteps(entries));
    // Fail-stop BEFORE spending: two recorded failures on the step we are about to run means the
    // run halts, with the halt itself on-chain so every driver and the UI agree it is over.
    if (action.kind === "step" && fails.filter((f) => f.index === action.index).length >= 2) {
      log(`heromode ${task.runId}: step ${action.index + 1} failed twice — run halted.`);
      await appendHard(mem, [doneEntry("failed", now())], log);
      acted++;
      break;
    }
    try {
      const r = await driveDurableStep({
        task, entries,
        runModel: async ({ model, maxTokens, messages }) => {
          // Connect lazily, HERE, rather than once per tick: driveDurableStep only calls runModel
          // when there is actually a step to run, so a tick that just writes the done marker no
          // longer opens a pointless MCP session. Cached per task so multiple steps reuse it.
          if (task.tools?.length && live === null) {
            live = await loadPlanTools(task.tools, (m) => log(`heromode ${task.runId}: ${m}`));
          }
          if (live?.length) {
            // Tell the model it has tools, and that their output is untrusted, without touching the
            // shared stepMessages() contract the browser also builds from.
            const withTools = messages.map((m, i) => (i === 0 && m.role === "system"
              ? { ...m, content: `${m.content} You have tools connected; use them when this step needs facts you do not reliably know. ${TOOL_SAFETY_NOTE}` }
              : m));
            const { content, toolTrace } = await runStepWithTools({
              chatRaw: async (a) => (await chat(a)).message,
              model, maxTokens, messages: withTools, live,
              log: (m) => log(`heromode ${task.runId}: ${m}`),
            });
            if (!String(content || "").trim()) throw new Error("empty model response");
            if (toolTrace.length) log(`heromode ${task.runId}: step used ${toolTrace.length} tool call(s)`);
            // Cost is unknown on the tool path (several chatRaw calls inside the loop), and an
            // honest null beats a partial number presented as the total.
            return { text: content, spentHero: null };
          }
          const { content, charged, tokIn, tokOut } = await chat({ model, messages, maxTokens });
          if (!String(content || "").trim()) throw new Error("empty model response");
          return { text: content, spentHero: charged ?? null, tokIn: tokIn ?? null, tokOut: tokOut ?? null };
        },
        // The model call above already cost $HERO, so the step:: record MUST land: on RH's lagging
        // RPCs a single append can transiently fail, and without a retry that wastes the paid call and
        // (after two) spuriously halts a healthy run. Retry hard, exactly like the TWAP twaprun:: write.
        checkpoint: async (es) => { if (!(await appendHard(mem, es, log))) throw new Error("checkpoint failed after retries"); },
        now,
      });
      log(`heromode ${task.runId}: ${r.status}${r.index != null ? ` (step ${r.index + 1}/${r.total})` : ""}`);
    } catch (e) {
      log(`heromode ${task.runId}: step ${action.index + 1} error — ${String(e.message).slice(0, 200)}`);
      await appendHard(mem, [{ role: "system", text: HM_FAIL_MARK + JSON.stringify({ runId: task.runId, index: action.index, error: String(e.message).slice(0, 300), at: now() }) }], log);
    }
    acted++;
    break; // one step per tick, across all runs: pacing and blast-radius control
  }
  return { tasks: tasks.length, acted, allDone: false };
}
