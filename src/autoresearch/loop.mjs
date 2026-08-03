// The autoresearch loop, as durable steps.
//
// One iteration takes a candidate train.py diff, runs the val_bpb replay in a sandbox (the objective
// oracle), classifies the outcome, and posts the verdict to the web app's ground-truth ingest seam
// (POST /api/foundry/verify/resolve → resolveGroundTruth). Every step is wrapped by DurableRun, so a
// crash mid-run resumes from the last on-chain step and the whole run is verifiable. The web app stays
// the ingestion point; this worker only reads candidates and POSTs verdicts.
//
// Inert unless the operator runs it (CLI) with AUTORESEARCH_ENABLED=1 and the needed keys.

import { runReplay } from "../replay.mjs";

// Post a ground-truth verdict to the web app's resolve seam (authed with the attestor key). Without
// the URL + key it's a dry run — prints what it WOULD post, moves nothing.
export function makeIngest({ url, attestorKey, onLog = () => {} }) {
  return async (payload) => {
    if (!url || !attestorKey) { onLog("ingest not configured (FOUNDRY_INGEST_URL / FOUNDRY_ATTESTOR_KEY) — dry run, nothing posted"); return { dryRun: true, payload }; }
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${attestorKey}` }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ingest failed ${res.status}: ${j.error || JSON.stringify(j).slice(0, 120)}`);
    return j;
  };
}

// Run one durable autoresearch iteration.
//   run       : a loaded DurableRun (its runId should be stable per contribution so re-runs resume)
//   candidate : { contributionId, artifact (the train.py diff text), source }
//   ingest    : async (payload) => result   (from makeIngest)
//   replayOpts: passed to runReplay ({ seeds, steps, timeoutMs }); or { fake } to stub replay in tests
export async function runAutoresearchOnce({ run, candidate, ingest, replayOpts = {}, onLog = () => {} }) {
  await run.step("fetch", async () => ({
    contributionId: candidate.contributionId, source: candidate.source || null, bytes: candidate.artifact.length,
  }));

  const verdict = await run.step("replay", async () => {
    if (replayOpts.fake) return replayOpts.fake; // test hook: skip the real (paid) sandbox run
    const r = await runReplay(candidate.artifact, {
      seeds: replayOpts.seeds, steps: replayOpts.steps, timeoutMs: replayOpts.timeoutMs,
      onEvent: (t, d) => { if (t === "phase") onLog(`replay: ${d.message}`); },
    });
    // Keep the checkpointed payload small + structured (it lands in an on-chain checkpoint).
    return {
      verdict: r.verdict,
      delta: typeof r.delta === "number" ? r.delta : null,
      baseline: r.baselineBpbs || null,
      candidate: r.candidateBpbs || null,
      err: r.err || null,
    };
  });

  const classified = await run.step("classify", async () => {
    // Map the replay's verdict vocabulary to resolveGroundTruth's GROUND_TRUTH_OUTCOMES. Note the
    // replay says "tampered"; the engine's enum is "eval_tamper". "error" has no outcome and is skipped.
    const MAP = { improved: "improved", regressed: "regressed", no_effect: "no_effect", tampered: "eval_tamper" };
    const outcome = MAP[verdict?.verdict] || null;
    if (!outcome) return { outcome: null, reason: verdict?.err || `no usable verdict (${verdict?.verdict || "none"})` };
    return { outcome, valBpbDelta: verdict.delta };
  });

  const ingested = await run.step("ingest", async () => {
    if (!classified.outcome) { onLog(`skip ingest: ${classified.reason}`); return { skipped: true, reason: classified.reason }; }
    return ingest({
      contributionId: candidate.contributionId,
      source: "replay",
      outcome: classified.outcome,
      valBpbDelta: classified.valBpbDelta,
      evidence: { baseline: verdict.baseline, candidate: verdict.candidate },
    });
  });

  return { contributionId: candidate.contributionId, outcome: classified.outcome, valBpbDelta: classified.valBpbDelta, ingested };
}
