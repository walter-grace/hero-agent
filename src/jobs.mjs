// Scheduled agent jobs, stored IN on-chain memory (the "decentralized cron").
//
// A job is a memory entry (marker `job::`). Each run appends a result entry (marker `jobrun::`). A
// cron — a Cloudflare Worker Cron Trigger, a Vercel cron, or launchd — calls runDue() every so often;
// it reads the agent's jobs straight from its on-chain memory, runs the due ones through the agent's
// brain, and checkpoints each result back to memory. So the agent literally "pings its memory and runs
// the task in the memory," and the whole schedule + history is wallet-owned and verifiable on-chain.
//
// Memory is append-only, so state is derived: a job's current definition is the latest `job::` entry
// for its id; lastRun is the newest `jobrun::` timestamp. No mutable rows needed.

const JOB_MARK = "job::";
const RUN_MARK = "jobrun::";

// ms per unit for "6h", "30m", "1d", "45s"
export function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (!m) throw new Error(`bad duration "${s}" — use like 45s, 30m, 6h, 1d`);
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return n * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 })[u];
}
export const fmtDuration = (ms) => ms % 864e5 === 0 ? ms / 864e5 + "d" : ms % 36e5 === 0 ? ms / 36e5 + "h" : ms % 6e4 === 0 ? ms / 6e4 + "m" : Math.round(ms / 1e3) + "s";

export function parseJobs(entries) {
  const jobs = new Map(), lastRun = new Map(), runs = [];
  for (const e of entries || []) {
    if (e.role !== "system" || typeof e.text !== "string") continue;
    if (e.text.startsWith(JOB_MARK)) { try { const j = JSON.parse(e.text.slice(JOB_MARK.length)); if (j.jobId) jobs.set(j.jobId, j); } catch {} }
    else if (e.text.startsWith(RUN_MARK)) { try { const r = JSON.parse(e.text.slice(RUN_MARK.length)); if (r.jobId) { runs.push(r); const at = Date.parse(r.at) || 0; if (at > (lastRun.get(r.jobId) || 0)) lastRun.set(r.jobId, at); } } catch {} }
  }
  return { jobs, lastRun, runs };
}

export function dueJobs(store, now) {
  const out = [];
  for (const [id, j] of store.jobs) {
    if (j.enabled === false) continue;
    const last = store.lastRun.get(id) || 0;
    if (now - last >= (j.everyMs || 0)) out.push(j);
  }
  return out;
}

// Add (or update) a job by writing a `job::` entry to memory (one on-chain checkpoint).
export async function addJob(memory, { task, everyMs, jobId, enabled = true }) {
  const j = { jobId: jobId || "job-" + Math.random().toString(36).slice(2, 8), task, everyMs, enabled, createdAt: new Date().toISOString() };
  await memory.append([{ role: "system", text: JOB_MARK + JSON.stringify(j) }]);
  return j;
}

// The cron tick. Read jobs from memory, run every due one through `chat`, checkpoint each result.
// `chat({model,messages,maxTokens})` is the brain (hero-agent provider) or a stub. `rootContext` is
// the agent's memory summary, injected so the task runs "in the memory."
// `onSpan(span)` receives a per-job trace event with timings and counts only — never task or result
// text — so a tracing backend (Cloudflare, OTel) can record it without leaking encrypted job content.
export async function runDue(memory, { chat, now = Date.now(), rootContext = "", onLog = () => {}, onSpan = () => {} }) {
  const store = parseJobs(await memory.raw().catch(() => []));
  const due = dueJobs(store, now);
  onLog(`${store.jobs.size} job(s) defined · ${due.length} due`);
  const results = [];
  for (const j of due) {
    onLog(`run ${j.jobId}: ${String(j.task).slice(0, 60)}`);
    const startedAt = now === Date.now() ? now : Date.now();
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    let ok = true, result;
    try {
      const msg = await chat({ model: "auto", maxTokens: 600, messages: [
        { role: "system", content: "You are a scheduled Hero agent running one task. Use your on-chain memory as context and reply with just the result, concise." + (rootContext ? "\n\nMEMORY:\n" + rootContext : "") },
        { role: "user", content: String(j.task) },
      ] });
      result = String(msg.content || "").trim();
    } catch (e) { ok = false; result = "error: " + e.message; }
    const ms = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
    await memory.append([{ role: "system", text: RUN_MARK + JSON.stringify({ jobId: j.jobId, at: new Date(now).toISOString(), ok, result: result.slice(0, 1200) }) }]);
    results.push({ jobId: j.jobId, ok, result });
    onSpan({ name: "job.run", jobId: j.jobId, ms, ok, resultChars: result.length, everyMs: j.everyMs });
    onLog(`  ${ok ? "ok" : "error"} in ${ms}ms: ${result.slice(0, 70)}`);
  }
  return { defined: store.jobs.size, due: due.length, ran: results.length, results };
}
