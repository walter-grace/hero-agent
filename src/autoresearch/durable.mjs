// Durable step runner whose EVENT LOG is the on-chain memory itself.
//
// Each completed step is checkpointed (encrypted, hash-chained) to Robinhood Chain through the same
// Agent Memory contract the agent already uses. So a crash or restart mid-run resumes from the last
// step that made it on-chain, and every step of the run is independently verifiable by anyone who can
// read the chain. The blockchain IS the durable-execution store — no external workflow backend, and
// unlike a managed workflow log, the state is wallet-owned and portable.
//
// Works with any memory that has { append(entries), raw() } — OnchainMemory (RH) or LocalMemory
// (a JSONL file, for offline testing with no wallet or gas).

const STEP_MARK = "ar-step::"; // marks a step record; role:"system" keeps it out of conversational recall

export class DurableRun {
  constructor({ memory, runId, onLog = () => {} }) {
    this.memory = memory;
    this.runId = String(runId);
    this.onLog = onLog;
    this.done = new Map(); // step name -> result, rebuilt from the log on load()
  }

  // Read the durable log and rebuild which steps of THIS run already completed.
  async load() {
    let entries = [];
    try { entries = await this.memory.raw(); }
    catch (e) { this.onLog(`log read failed (${e.message}); starting a fresh run`); }
    for (const e of entries) {
      if (e.role !== "system" || typeof e.text !== "string" || !e.text.startsWith(STEP_MARK)) continue;
      let rec; try { rec = JSON.parse(e.text.slice(STEP_MARK.length)); } catch { continue; }
      if (rec && rec.runId === this.runId && rec.step) this.done.set(rec.step, rec.result);
    }
    if (this.done.size) this.onLog(`resuming run ${this.runId}: ${this.done.size} step(s) already on the durable log`);
    return this;
  }

  // Run a step once. If it already completed (found on the log), return the checkpointed result
  // without re-running. Otherwise run it, checkpoint the result, and return it. The result must be
  // JSON-serializable and small — it goes into an on-chain checkpoint.
  async step(name, fn) {
    if (this.done.has(name)) { this.onLog(`step ${name}: cached — resumed from the durable log`); return this.done.get(name); }
    this.onLog(`step ${name}: running`);
    const result = await fn();
    await this.memory.append([{ role: "system", text: STEP_MARK + JSON.stringify({ runId: this.runId, step: name, result, at: new Date().toISOString() }) }]);
    this.done.set(name, result);
    this.onLog(`step ${name}: done — checkpointed to the durable log`);
    return result;
  }
}
