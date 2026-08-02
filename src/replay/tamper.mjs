// Tamper defenses for the replay harness. This is the load-bearing security layer: a
// malicious diff must not be able to fake its own val_bpb. We defend on three fronts:
//   1) hashing   -- the pinned files (eval, val, vocab, seed) are byte-hashed and
//                    re-verified after the diff is applied; any change is tampering.
//   2) diff scan -- the unified diff may target ONLY train.py. Any hunk aimed at a
//                    pinned file (or anywhere else) is tampering, caught before we run.
//   3) content scan -- the resulting train.py is scanned for forbidden capabilities
//                    (network, reading val data, importing the scorer, exec/eval,
//                    writing pinned files, seed cherry-picking).
// None of the contributed code is ever eval()'d on the host. We only hash it, pattern-scan
// it, and run it inside the sandbox where the scorer we control produces the verdict.
import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(String(s ?? ""), "utf8").digest("hex");

// Hash a { path: contents } map into { path: sha256 } for the given subset of paths.
export function hashFiles(fileMap, paths) {
  const out = {};
  for (const p of paths) out[p] = sha256(fileMap[p]);
  return out;
}

// Normalize a diff header path: strip the a/ b/ prefixes, ./, and leading slashes so
// "a/train.py", "b/./train.py" and "train.py" all compare equal.
function normPath(p) {
  let s = String(p || "").trim();
  // drop a trailing tab + timestamp that diff -u sometimes appends
  s = s.split("\t")[0].trim();
  s = s.replace(/^[ab]\//, "").replace(/^\.\//, "").replace(/^\/+/, "");
  return s;
}

// Extract every file path a unified diff targets, from its --- / +++ headers and any
// "diff --git" / "rename"/"copy" lines. Returns a de-duplicated list of normalized paths.
export function diffTargets(diffText) {
  const paths = new Set();
  for (const line of String(diffText || "").split("\n")) {
    let m;
    if ((m = line.match(/^\+\+\+ (.+)$/)) || (m = line.match(/^--- (.+)$/))) {
      const p = normPath(m[1]);
      if (p && p !== "/dev/null") paths.add(p);
    } else if ((m = line.match(/^diff --git (.+) (.+)$/))) {
      paths.add(normPath(m[1]));
      paths.add(normPath(m[2]));
    } else if ((m = line.match(/^(?:rename|copy) (?:from|to) (.+)$/))) {
      paths.add(normPath(m[1]));
    }
  }
  return [...paths];
}

// Does this artifact look like a unified diff, or is it a full-file train.py replacement?
export function looksLikeDiff(text) {
  const t = String(text || "");
  return /^(diff --git |--- |\+\+\+ |@@ )/m.test(t) || /\n@@ .+ @@/.test(t);
}

// Forbidden capability patterns scanned in the resulting train.py. Each is something a
// benign training script has no reason to do but a score-faking diff would want.
const CONTENT_RULES = [
  [/\b(socket|urllib|http\.client|httplib|requests|ftplib|smtplib|telnetlib|asyncio\.open_connection)\b/, "network access (exfiltration / fetching a precomputed score)"],
  [/\b(subprocess|os\.system|os\.popen|pty\.spawn|commands\.getoutput)\b/, "shell / subprocess execution"],
  [/\b(curl|wget)\b/, "network fetch via shell tool"],
  [/\b__import__\s*\(|\beval\s*\(|\bexec\s*\(|\bcompile\s*\(/, "dynamic code execution (eval/exec/compile/__import__)"],
  [/\bimport\s+eval\b|\bfrom\s+eval\s+import\b|\beval\.py\b/, "reaching into the pinned scorer eval.py"],
  [/val\.txt|data\/val|['"]val['"]/, "reading the validation data (training on val is cheating)"],
  [/\bopen\s*\([^)]*['"](?:\/|\.\.)/, "opening a file by absolute or parent path (escaping the stack dir)"],
  [/vocab\.json['"]\s*,\s*['"][wax]/, "opening vocab.json for writing (vocab is pinned)"],
  [/seed\.json['"]\s*,\s*['"][wax]/, "opening seed.json for writing (seed is pinned)"],
  [/eval\.py['"]\s*,\s*['"][wax]/, "opening eval.py for writing (scorer is pinned)"],
];

// A benign script reads HERO_SEED. A cherry-picking diff hardcodes a favorable seed and
// ignores it. We flag a literal-seed call that is NOT obviously derived from HERO_SEED.
function scanSeedHandling(trainPy) {
  const out = [];
  const seedCalls = [...trainPy.matchAll(/random\.seed\s*\(([^)]*)\)|manual_seed\s*\(([^)]*)\)/g)];
  for (const m of seedCalls) {
    const arg = (m[1] ?? m[2] ?? "").trim();
    if (/^\d/.test(arg) || /^-?\d+$/.test(arg)) {
      out.push(`seed hardcoded to a literal (${arg}) instead of using HERO_SEED -- possible seed cherry-picking`);
    }
  }
  return out;
}

// Strip Python comments so a descriptive comment ("must not touch eval.py / val.txt") does
// not trip the scanner. We only care about executable code: forbidden capabilities (import
// socket, os.system, ...) are code tokens that appear before any trailing "#", so cutting at
// "#" cannot hide them. This removes comment-based false positives.
function stripPyComments(src) {
  return String(src || "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
}

// Scan the (already-applied) candidate train.py for forbidden patterns. Comments are ignored;
// only executable code is examined.
export function scanContent(trainPy, _diffText = "") {
  const reasons = [];
  const hay = stripPyComments(trainPy);
  for (const [re, why] of CONTENT_RULES) if (re.test(hay)) reasons.push(why);
  reasons.push(...scanSeedHandling(hay));
  return [...new Set(reasons)];
}

// Top-level diff gate: returns { tampered, reasons }. It checks that a diff (if it is one)
// targets only train.py. Hash re-verification and content scanning happen in replay.mjs
// after the diff is applied.
export function scanDiffTargets(artifact, { isDiff = looksLikeDiff(artifact) } = {}) {
  const reasons = [];
  if (isDiff) {
    const targets = diffTargets(artifact);
    const offending = targets.filter((p) => p !== "train.py");
    if (offending.length) {
      reasons.push(`diff targets non-editable file(s): ${offending.join(", ")} (only train.py may change)`);
    }
    if (!targets.includes("train.py") && targets.length) {
      reasons.push(`diff does not target train.py (targets: ${targets.join(", ") || "none"})`);
    }
  }
  return { tampered: reasons.length > 0, reasons };
}
