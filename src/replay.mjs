// replay: the sandboxed val_bpb replay harness. It is the objective ground-truth oracle
// that turns Hero Run's reputation and payouts from "trust" into "measured". Given a
// contributed research artifact (a unified diff to train.py, or a full train.py), it:
//   1) ships a PINNED tiny training stack into an E2B sandbox with egress OFF,
//   2) runs the unmodified baseline across several seeds to establish a NOISE BAND,
//   3) tamper-checks the artifact (diff-target scan, content scan, pinned-file re-hash),
//   4) applies the diff to train.py ONLY and runs the candidate across the same seeds,
//   5) returns { baselineBpb, candidateBpb, noiseBand, delta, verdict, tamper, seed, hashes, trace }.
//
// Mirrors src/prove.mjs: init sandbox -> set up toolchain -> run -> objective verdict ->
// cleanup -> return a trace. It never eval()s contributed code on the host; the candidate
// only ever runs inside the sandbox, and the scorer (eval.py) that produces the number is
// pinned and hash-verified.
//
// MODE: CPU-tiny. E2B's SDK exposes no GPU sandbox, so this stack is a tiny pure-Python
// char-level LM that yields a real val_bpb in seconds on CPU. It proves the MECHANISM and
// the SECURITY properties, NOT research-grade results. A GPU deployment swaps the stack for
// nanochat/autoresearch and keeps the identical trust boundary.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { E2BExecutor } from "./bench/e2b-executor.mjs";
import { stackFiles, PINNED_FILES, STACK_DIR, TRAIN_PY } from "./replay/stack.mjs";
import { sha256, hashFiles, looksLikeDiff, scanDiffTargets, scanContent } from "./replay/tamper.mjs";

const FLOOR = 1e-4; // minimum noise band (bpb): guards against declaring numerical dust an improvement.

// Apply a unified diff to the baseline train.py on the HOST (never executing it), returning
// the candidate train.py text. We patch a scratch copy so the diff can only ever affect the
// one file we hand it; the diff-target scan already rejected any diff aimed elsewhere.
function applyDiffHost(baseline, diffText) {
  const dir = mkdtempSync(join(tmpdir(), "replay-patch-"));
  try {
    writeFileSync(join(dir, "train.py"), baseline);
    writeFileSync(join(dir, "artifact.diff"), diffText);
    let lastErr;
    for (const strip of ["-p1", "-p0"]) {
      try {
        execFileSync("patch", [strip, "--no-backup-if-mismatch", "train.py", "artifact.diff"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        return { ok: true, candidate: readFileSync(join(dir, "train.py"), "utf8") };
      } catch (e) {
        lastErr = e;
        // restore baseline before trying the next strip level
        writeFileSync(join(dir, "train.py"), baseline);
      }
    }
    return { ok: false, err: `patch failed: ${String(lastErr?.stderr || lastErr?.message || lastErr).slice(0, 400)}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

// Classify improvement against the baseline's own seed-to-seed noise. A tiny model is noisy,
// so an "improvement" must beat the noise band, not just the mean. noiseBand = 2 sigma of the
// baseline across seeds (floored). Honest caveat: with only 2-3 seeds this 2-sigma estimate is
// weak; real deployments run more seeds and/or a paired significance test.
function classify(baselineBpbs, candidateBpbs) {
  const baselineBpb = mean(baselineBpbs);
  const candidateBpb = mean(candidateBpbs);
  const noiseBand = Math.max(2 * std(baselineBpbs), FLOOR);
  const delta = baselineBpb - candidateBpb; // positive = candidate is better (lower bpb)
  let verdict;
  if (delta > noiseBand) verdict = "improved";
  else if (delta < -noiseBand) verdict = "regressed";
  else verdict = "no_effect";
  return { baselineBpb, candidateBpb, noiseBand, delta, verdict };
}

// Run train.py at a given seed, then the pinned eval.py, and parse val_bpb from eval's output.
async function runSeed(executor, seed, steps, cmdTimeoutMs) {
  const env = `HERO_SEED=${seed}${steps ? ` HERO_STEPS=${steps}` : ""}`;
  const train = await executor.exec(`cd ${STACK_DIR} && ${env} python3 train.py`, { timeout: cmdTimeoutMs });
  if (train.code !== 0) throw new Error(`train.py exit ${train.code} (seed ${seed}): ${(train.stderr || train.stdout).slice(0, 400)}`);
  const ev = await executor.exec(`cd ${STACK_DIR} && python3 eval.py`, { timeout: cmdTimeoutMs });
  if (ev.code !== 0) throw new Error(`eval.py exit ${ev.code} (seed ${seed}): ${(ev.stderr || ev.stdout).slice(0, 400)}`);
  const line = (ev.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
  let parsed;
  try { parsed = JSON.parse(line); } catch { throw new Error(`could not parse eval output (seed ${seed}): ${line.slice(0, 200)}`); }
  if (typeof parsed.val_bpb !== "number" || !isFinite(parsed.val_bpb)) throw new Error(`eval returned no finite val_bpb (seed ${seed}): ${line}`);
  return parsed.val_bpb;
}

export async function runReplay(artifact, {
  seeds = 3,
  steps = null,               // override HERO_STEPS for both baseline and candidate (fair comparison)
  timeoutMs = 15 * 60_000,    // sandbox lifetime
  cmdTimeoutMs = 5 * 60_000,  // per train/eval command
  onEvent = () => {},
} = {}) {
  const trace = [];
  const note = (m) => { trace.push(m); onEvent("phase", { message: m }); };

  const isDiff = looksLikeDiff(artifact);
  const baseSeed = 1337;
  const seedList = Array.from({ length: Math.max(1, seeds) }, (_, i) => baseSeed + i);
  // Hashes of the pinned files as we ship them (the canonical, trusted values).
  const files = stackFiles();
  const hashes = hashFiles(files, PINNED_FILES);

  const result = {
    mode: "cpu-tiny", isDiff, seeds: seedList, steps,
    baselineBpb: null, candidateBpb: null, noiseBand: null, delta: null,
    verdict: null, tamper: { tampered: false, reasons: [], where: null },
    hashes, baselineBpbs: [], candidateBpbs: [], networkBlocked: null, trace, err: null,
  };

  // ---- STATIC TAMPER GATE (host, no sandbox, free) -------------------------------------
  // 1) A diff may target only train.py.
  if (isDiff) {
    const g = scanDiffTargets(artifact, { isDiff });
    if (g.tampered) {
      result.tamper = { tampered: true, reasons: g.reasons, where: "diff-target-scan" };
      result.verdict = "tampered";
      note(`TAMPERED (diff-target scan): ${g.reasons.join("; ")}`);
      return result;
    }
  }

  // 2) Produce the candidate train.py (apply the diff on the host, or take the full file).
  let candidateTrainPy;
  if (isDiff) {
    const applied = applyDiffHost(TRAIN_PY, artifact);
    if (!applied.ok) { result.err = applied.err; result.verdict = "error"; note(`error: ${applied.err}`); return result; }
    candidateTrainPy = applied.candidate;
  } else {
    candidateTrainPy = String(artifact || ""); // full-file train.py replacement
  }

  // 3) Content scan of the resulting train.py (network, val reads, exec, seed cherry-pick...).
  const contentReasons = scanContent(candidateTrainPy, isDiff ? artifact : "");
  if (contentReasons.length) {
    result.tamper = { tampered: true, reasons: contentReasons, where: "content-scan" };
    result.verdict = "tampered";
    note(`TAMPERED (content scan): ${contentReasons.join("; ")}`);
    return result;
  }

  // ---- SANDBOX RUN ---------------------------------------------------------------------
  const executor = new E2BExecutor({ timeoutMs, cmdTimeoutMs, allowInternetAccess: false });
  try {
    note("creating E2B sandbox (egress OFF)");
    await executor.init();
    note(`sandbox ${executor.label()}`);

    // Ship the pinned stack.
    note("writing pinned training stack");
    for (const [rel, content] of Object.entries(files)) {
      await executor.write(`${STACK_DIR}/${rel}`, content);
    }

    // Evidence that egress is actually off: a network call from inside must FAIL.
    const probe = await executor.exec(
      `python3 -c "import urllib.request; urllib.request.urlopen('http://example.com', timeout=5)" 2>&1 && echo OPEN || echo BLOCKED`,
      { timeout: 30_000 },
    );
    result.networkBlocked = /BLOCKED/.test(probe.stdout) && !/OPEN/.test(probe.stdout);
    note(`network egress: ${result.networkBlocked ? "BLOCKED (verified)" : "NOT blocked -- SECURITY GAP"}`);

    // Baseline across seeds (unmodified train.py) -> noise band.
    note(`running baseline across ${seedList.length} seed(s): ${seedList.join(", ")}`);
    for (const s of seedList) {
      const bpb = await runSeed(executor, s, steps, cmdTimeoutMs);
      result.baselineBpbs.push(bpb);
      onEvent("seed", { role: "baseline", seed: s, bpb });
    }
    note(`baseline val_bpb: ${result.baselineBpbs.map((x) => x.toFixed(5)).join(", ")}`);

    // Apply the candidate (write train.py ONLY) then re-verify the pinned files are untouched.
    note("applying candidate diff (train.py only)");
    await executor.write(`${STACK_DIR}/train.py`, candidateTrainPy);

    note("re-hashing pinned files (tamper check)");
    const after = {};
    for (const p of PINNED_FILES) after[p] = sha256(await executor.read(`${STACK_DIR}/${p}`));
    const changed = PINNED_FILES.filter((p) => after[p] !== hashes[p]);
    if (changed.length) {
      result.tamper = { tampered: true, reasons: [`pinned file(s) changed after applying diff: ${changed.join(", ")}`], where: "hash-verify" };
      result.verdict = "tampered";
      note(`TAMPERED (hash verify): ${changed.join(", ")}`);
      return result;
    }
    note("pinned files intact (hashes match)");

    // Candidate across the SAME seeds.
    note(`running candidate across ${seedList.length} seed(s)`);
    for (const s of seedList) {
      const bpb = await runSeed(executor, s, steps, cmdTimeoutMs);
      result.candidateBpbs.push(bpb);
      onEvent("seed", { role: "candidate", seed: s, bpb });
    }
    note(`candidate val_bpb: ${result.candidateBpbs.map((x) => x.toFixed(5)).join(", ")}`);

    const c = classify(result.baselineBpbs, result.candidateBpbs);
    Object.assign(result, c);
    note(`VERDICT: ${c.verdict} (delta ${c.delta.toFixed(5)} bpb vs noise band ${c.noiseBand.toFixed(5)})`);
  } catch (e) {
    result.err = e.message;
    result.verdict = result.verdict || "error";
    note(`error: ${e.message}`);
  } finally {
    await executor.cleanup();
    note("sandbox cleaned up");
  }
  return result;
}
