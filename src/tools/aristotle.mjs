// aristotle tool: lets the agent hand a statement (or a Lean file with `sorry`s) to Harmonic's
// Aristotle prover and get verified Lean 4 back. Aristotle is a long-running async agent, so the
// tool submits, polls to a terminal state, downloads the result tarball, and returns the Lean text
// of the produced files. Bind it like the other tools: aristotleTools() -> [{ def, run }].
//
// Cost note: a real formalize run takes minutes of Aristotle compute. `maxWaitSeconds` bounds the
// wait; the agent can call again if it needs more time.
import { gunzipSync } from "node:zlib";
import { submitProof, cancelTask, getProjectResult, waitForTask, aristotleReady } from "../aristotle.mjs";

// Minimal, dependency-free tar.gz extractor. Aristotle returns a gzipped ustar archive; we only need
// the text of the .lean files inside it. Parses 512-byte ustar headers; skips everything non-.lean.
function extractLeanFiles(tarGzBuffer) {
  let data;
  try { data = gunzipSync(tarGzBuffer); } catch { data = tarGzBuffer; } // some results may be plain tar
  const files = [];
  let off = 0;
  while (off + 512 <= data.length) {
    const header = data.subarray(off, off + 512);
    // A name of all-zero bytes marks the end-of-archive padding.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    off += 512;
    const base = name.split("/").pop();
    if ((typeFlag === "0" || typeFlag === "\0") && name.endsWith(".lean") && !base.startsWith("._") && size > 0) {
      files.push({ name, content: data.subarray(off, off + size).toString("utf8") });
    }
    off += Math.ceil(size / 512) * 512; // advance past the file body (padded to 512)
  }
  return files;
}

export function aristotleTools() {
  return [
    {
      def: { type: "function", function: {
        name: "aristotle_prove",
        description:
          "Formalize a math statement into verified Lean 4, or fill the `sorry`s in a Lean file, using " +
          "Harmonic's Aristotle prover. Returns the produced Lean 4 source. Aristotle runs for minutes; " +
          "if it does not finish within max_wait_seconds the tool reports the run id so you can retry.",
        parameters: { type: "object", properties: {
          statement: { type: "string", description: "The theorem to prove in natural language, or Lean 4 source containing `sorry` to fill." },
          max_wait_seconds: { type: "number", description: "How long to wait for Aristotle before returning (default 600)." },
        }, required: ["statement"] },
      } },
      async run({ statement, max_wait_seconds }) {
        if (!aristotleReady()) return "aristotle unavailable: ARISTOTLE_API_KEY is not set.";
        const waitMs = Math.max(30, Number(max_wait_seconds) || 600) * 1000;
        let taskId, projectId;
        try {
          const { project, taskId: tid } = await submitProof({ prompt: String(statement) });
          projectId = project.project_id; taskId = tid;
        } catch (e) { return `aristotle submit failed: ${e.message}`; }
        if (!taskId) return `aristotle submitted (project ${projectId}) but no task id resolved yet; retry to read its result.`;

        let task;
        try {
          task = await waitForTask(taskId, { timeoutMs: waitMs, intervalMs: 5000 });
        } catch (e) {
          // Timed out waiting: leave the task running and let the agent decide whether to retry.
          return `aristotle still running (task ${taskId}, project ${projectId}) after ${Math.round(waitMs / 1000)}s: ${e.message}`;
        }

        if (task.status !== "COMPLETE" && task.status !== "COMPLETE_WITH_ERRORS") {
          return `aristotle finished with status ${task.status} (task ${taskId}). No verified proof produced.`;
        }
        try {
          const { buffer } = await getProjectResult(projectId);
          const leanFiles = extractLeanFiles(buffer);
          if (!leanFiles.length) return `aristotle ${task.status} but no .lean files in the result (task ${taskId}).`;
          const body = leanFiles.map((f) => `-- ${f.name}\n${f.content}`).join("\n\n");
          return `aristotle ${task.status} (task ${taskId}):\n\n${body}`.slice(0, 12000);
        } catch (e) { return `aristotle ${task.status} but result download failed: ${e.message}`; }
      },
    },
  ];
}

// Exposed for tests: submit then immediately cancel (verifies the live API without burning compute).
export async function submitAndCancel(statement) {
  const { project, taskId } = await submitProof({ prompt: String(statement) });
  let canceled = null;
  if (taskId) { try { canceled = await cancelTask(taskId); } catch (e) { canceled = { error: e.message }; } }
  return { projectId: project.project_id, taskId, canceled };
}

export { extractLeanFiles };
