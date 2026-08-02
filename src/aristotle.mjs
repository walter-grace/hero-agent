// Aristotle (Harmonic) Lean 4 theorem-proving client for hero-agent.
//
// Ported from the live-verified web client at hero-foundry-web/lib/aristotle.js, itself a fetch
// port of the Python `aristotlelib` HTTP surface. Carries no dependency: plain fetch.
//
// Aristotle is NOT an OpenAI-compatible gateway. It is a long-running async agent:
//   1. createProject(prompt, tar?)         -> Project (a first task starts implicitly)
//   2. getTasks(projectId)                 -> find the AgentTask id
//   3. poll getTask(taskId) / getEvents()  -> minutes to much longer
//   4. getProjectResult(projectId)         -> download the result .tar.gz
//
// INERT WITHOUT A KEY: importing this module touches no network. Every network call throws a clear,
// catchable AristotleError when ARISTOTLE_API_KEY is unset. Gate any surface with aristotleReady().
//
// Auth header is X-API-Key (NOT Authorization: Bearer). Base is fixed by the SDK to /api/v3.

const BASE_URL = (process.env.ARISTOTLE_BASE_URL || "https://aristotle.harmonic.fun/api/v3").replace(/\/$/, "");
const DEFAULT_TIMEOUT_MS = 30_000; // SDK DEFAULT_TIMEOUT_SECONDS = 30

// ---- enums (mirror the SDK) -----------------------------------------------------------------
// AgentTask.status is a STRING enum on the wire.
export const TaskStatus = Object.freeze({
  UNKNOWN: "UNKNOWN", QUEUED: "QUEUED", IN_PROGRESS: "IN_PROGRESS",
  COMPLETE: "COMPLETE", COMPLETE_WITH_ERRORS: "COMPLETE_WITH_ERRORS",
  OUT_OF_BUDGET: "OUT_OF_BUDGET", FAILED: "FAILED", CANCELED: "CANCELED",
});
const TERMINAL_STATUSES = new Set(["COMPLETE", "COMPLETE_WITH_ERRORS", "OUT_OF_BUDGET", "FAILED", "CANCELED"]);
export const isTerminalStatus = (s) => TERMINAL_STATUSES.has(String(s));

// AgentQuestionsSetting: DISABLED=1 (agent never blocks on a question), TIMEOUT_15_MIN=2.
// DISABLED is the only sane setting for an unattended agent: nobody is at a terminal to answer.
export const AgentQuestionsSetting = Object.freeze({ DISABLED: 1, TIMEOUT_15_MIN: 2 });

// Event.event_type is an INT enum. Surfaced so a caller can label the live proof trace.
export const EventType = Object.freeze({
  0: "UNKNOWN", 1: "MESSAGE", 2: "BUILDING", 3: "THINKING", 4: "EDITING_FILE",
  5: "SEARCHING_LOCAL", 6: "RUNNING_COMMAND", 7: "PROVING", 8: "READING_FILES",
  9: "REVIEWING", 10: "FINISHED", 11: "ERROR", 12: "READING_LEAN",
  13: "SEARCHING_EXTERNAL", 14: "RUNNING_LEAN", 15: "QUESTION", 16: "SUMMARY", 17: "AGENT_QUESTION",
});
export const eventTypeName = (n) => EventType[n] || "UNKNOWN";

// ---- key / readiness ------------------------------------------------------------------------
export function aristotleReady() { return !!process.env.ARISTOTLE_API_KEY; }
function apiKey() {
  const k = process.env.ARISTOTLE_API_KEY;
  if (!k) throw new AristotleError("Aristotle is not configured (ARISTOTLE_API_KEY is unset).", { status: 503 });
  return k; // arstl_… key
}

export class AristotleError extends Error {
  constructor(message, { status = null } = {}) { super(message); this.name = "AristotleError"; this.status = status; }
}

// ---- core request ---------------------------------------------------------------------------
async function request(method, endpoint, { params, jsonBody, form, expectBinary = false, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = apiKey();
  let url = `${BASE_URL}/${String(endpoint).replace(/^\//, "")}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  const headers = { "X-API-Key": key };
  let body;
  if (jsonBody !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(jsonBody); }
  else if (form !== undefined) { body = form; } // fetch sets multipart/urlencoded Content-Type itself

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const combined = signal ? anySignal([signal, ctrl.signal]) : ctrl.signal;

  let res;
  try { res = await fetch(url, { method, headers, body, signal: combined }); }
  catch (e) { clearTimeout(t); throw new AristotleError(`Aristotle request failed: ${e.message}`); }
  clearTimeout(t);

  if (!res.ok) {
    let detail = null;
    try { const j = await res.json(); detail = j.detail || j.message || null; }
    catch { try { detail = await res.text(); } catch { /* ignore */ } }
    if (res.status === 429) throw new AristotleError("Too many projects in progress. Cancel a running task or wait before starting another.", { status: 429 });
    throw new AristotleError(`Aristotle API ${res.status}: ${detail || res.statusText}`, { status: res.status });
  }

  if (expectBinary) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, contentDisposition: res.headers.get("content-disposition") || "" };
  }
  return res.json();
}

// Minimal AbortSignal.any polyfill (Node <20 lacks it).
function anySignal(signals) {
  if (typeof AbortSignal !== "undefined" && AbortSignal.any) return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) { if (s.aborted) { ctrl.abort(); break; } s.addEventListener("abort", () => ctrl.abort(), { once: true }); }
  return ctrl.signal;
}

function filenameFromDisposition(cd, fallback) {
  if (cd && cd.includes("filename=")) return cd.split("filename=")[1].trim().replace(/^"|"$/g, "");
  return fallback;
}

// ---- Projects -------------------------------------------------------------------------------

// POST /project — create a project (a first task starts implicitly). The SDK sends a form field
// "body" holding a JSON STRING { prompt, agent_questions_setting }, plus an optional "input" file
// (a .tar / .tar.gz of the Lean project or paper to formalize). Field shapes mirrored exactly.
export async function createProject({ prompt, tar = null, agentQuestionsSetting = AgentQuestionsSetting.DISABLED, signal } = {}) {
  if (!prompt || !String(prompt).trim()) throw new AristotleError("createProject: prompt is required");
  const bodyJson = JSON.stringify({ prompt: String(prompt), agent_questions_setting: agentQuestionsSetting });
  if (tar && tar.bytes) {
    const fd = new FormData();
    fd.append("body", bodyJson);
    fd.append("input", new Blob([tar.bytes], { type: "application/x-tar" }), tar.filename || "project.tar.gz");
    return request("POST", "/project", { form: fd, signal });
  }
  const fd = new URLSearchParams();
  fd.append("body", bodyJson);
  return request("POST", "/project", { form: fd, signal });
}

// GET /project/{id}
export function getProject(projectId, { signal } = {}) { return request("GET", `/project/${projectId}`, { signal }); }

// GET /project/{id}/tasks -> { agent_tasks, pagination_key }
export function getTasks(projectId, { paginationKey, limit = 10, newestFirst = true, signal } = {}) {
  return request("GET", `/project/${projectId}/tasks`, { params: { pagination_key: paginationKey, limit, ascending: !newestFirst }, signal });
}

// GET /project/{id}/result (has_files) or /input (has_input only) -> binary tarball. Returns { buffer, filename }.
export async function getProjectResult(projectId, { signal } = {}) {
  const proj = await getProject(projectId, { signal });
  let endpoint;
  if (proj.has_files) endpoint = `/project/${projectId}/result`;
  else if (proj.has_input) endpoint = `/project/${projectId}/input`;
  else throw new AristotleError(`Project ${projectId} has no files yet.`, { status: 409 });
  const { buffer, contentDisposition } = await request("GET", endpoint, { expectBinary: true, signal });
  return { buffer, filename: filenameFromDisposition(contentDisposition, `${projectId}_aristotle.tar.gz`) };
}

// ---- Tasks ----------------------------------------------------------------------------------

// GET /task/{id}
export function getTask(taskId, { signal } = {}) { return request("GET", `/task/${taskId}`, { signal }); }

// GET /task/{id}/events -> { events, pagination_key }
export function getEvents(taskId, { paginationKey, limit = 50, newestFirst = true, signal } = {}) {
  return request("GET", `/task/${taskId}/events`, { params: { pagination_key: paginationKey, limit, ascending: !newestFirst }, signal });
}

// POST /task/{id}/cancel -> updated AgentTask
export function cancelTask(taskId, { signal } = {}) { return request("POST", `/task/${taskId}/cancel`, { signal }); }

// ---- convenience: submit + resolve the implicit first task ----------------------------------
// createProject returns a Project but not the task id; the first task is created implicitly.
// This resolves it so callers get { project, taskId } in one step.
export async function submitProof({ prompt, tar = null, agentQuestionsSetting = AgentQuestionsSetting.DISABLED, signal } = {}) {
  const project = await createProject({ prompt, tar, agentQuestionsSetting, signal });
  let taskId = null;
  try {
    const { agent_tasks } = await getTasks(project.project_id, { limit: 1, newestFirst: true, signal });
    taskId = agent_tasks?.[0]?.agent_task_id || null;
  } catch { /* task list can lag a beat right after create; caller can re-fetch */ }
  return { project, taskId };
}

// ---- convenience: poll a task to a terminal state -------------------------------------------
// Blocks (polling getTask) until the task reaches a terminal status or the deadline passes.
// Returns the final task object. onEvent(task) fires on each poll for a live trace.
export async function waitForTask(taskId, { intervalMs = 5_000, timeoutMs = 15 * 60_000, onPoll, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const task = await getTask(taskId, { signal });
    if (onPoll) onPoll(task);
    if (isTerminalStatus(task.status)) return task;
    if (Date.now() > deadline) throw new AristotleError(`waitForTask: ${taskId} did not finish within ${Math.round(timeoutMs / 1000)}s`, { status: 504 });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
