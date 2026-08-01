// SWE-bench (Lite) adapter. Each instance is a real GitHub issue on a real repo at a fixed commit;
// the agent must produce a patch that resolves it. The correct, standard integration is: run the
// agent in the repo, capture its `git diff` as a prediction, and let SWE-bench's OWN harness score
// it (apply the hidden test_patch, run FAIL_TO_PASS + PASS_TO_PASS in the official per-repo image).
// We do NOT reimplement their evaluation — that is finicky per repo and version, and their harness is
// the authority. This module produces a predictions file in the exact format their harness expects.
//
// Instance schema (princeton-nlp/SWE-bench_Lite, split test):
//   instance_id, repo ("owner/name"), base_commit, problem_statement (the issue = the instruction),
//   patch (gold; ignored), test_patch (hidden tests; the harness applies it), FAIL_TO_PASS,
//   PASS_TO_PASS, environment_setup_commit, version.
//
// Flow per instance: fetch repo@base_commit -> agent solves problem_statement with shell tools ->
// `git diff` -> append { instance_id, model_name_or_path, model_patch } to predictions.jsonl.
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { Harness } from "../harness.mjs";
import { heroRun } from "../provider.mjs";
import { shellTools } from "../tools/shell.mjs";
import { LocalExecutor } from "./executor.mjs";

const MODEL_NAME = "hero-agent";
const SYSTEM =
  "You are a software engineer fixing a real bug in an existing repository. You are at the repo root " +
  "on the exact commit the issue was filed against. Work in this order: (1) use the shell (grep, ls, " +
  "cat) and read_file to find the exact file and lines responsible; (2) use write_file to make the " +
  "minimal change that resolves the issue in the SOURCE files (do not create helper or config files " +
  "like sitecustomize.py, and do not add tests); (3) confirm your edit is in place by reading the " +
  "file back. You MUST actually modify at least one existing source file with write_file. Do not " +
  "finish, and do not just describe the fix, until you have edited the source and verified it. Do not " +
  "run git.";

// Load instances from a local JSONL or JSON array (export the HF dataset once, see docs/benchmarks.md).
export function loadSweBench(path, { instance } = {}) {
  const text = readFileSync(path, "utf8").trim();
  let rows = text[0] === "[" ? JSON.parse(text) : text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (instance) rows = rows.filter((r) => r.instance_id === instance || r.instance_id.includes(instance));
  return rows;
}

export async function runSweBench({ apiKey, instances, out = "predictions.jsonl", model = "auto", maxSteps = 40, nudges = 2, onEvent = () => {} }) {
  const provider = heroRun({ apiKey });
  writeFileSync(out, ""); // fresh predictions file
  const results = [];
  const currentPatch = async (ex) => (await ex.exec("git add -A && git diff --cached", { timeout: 60000 })).stdout || "";
  for (const inst of instances) {
    const ex = new LocalExecutor();
    let patch = "", costHero = 0, err = null, attempts = 0;
    try {
      const url = `https://github.com/${inst.repo}.git`;
      // Fetch only the one commit we need (fast even for large repos like django).
      const setup = await ex.exec(`git init -q && git remote add origin ${url} && git fetch -q --depth 1 origin ${inst.base_commit} && git checkout -q FETCH_HEAD`, { timeout: 300000 });
      if (setup.code !== 0) throw new Error(`checkout failed: ${setup.stderr.slice(0, 200)}`);
      // In-task memory so a re-nudge continues from what the agent already explored (not from scratch).
      const agent = new Harness({ provider, memory: ramMemory(), tools: shellTools(ex), system: SYSTEM, model, maxSteps, compactEvery: Infinity, onEvent });
      // The observed failure mode was the model concluding in prose without ever calling write_file,
      // leaving an empty diff. So: run, and if nothing changed on disk, nudge it to actually edit and
      // run again (bounded). This is model-agnostic — it needs a real edit, not a specific model.
      for (let a = 0; a <= nudges; a++) {
        attempts = a + 1;
        const prompt = a === 0 ? inst.problem_statement
          : "You have NOT modified any source file yet — `git` shows no changes, so nothing you did counts. Find the exact source file responsible and use write_file to make the fix RIGHT NOW, then read it back to confirm. Do not explain; edit.";
        const r = await agent.run(prompt);
        costHero += r.costHero || 0;
        patch = await currentPatch(ex);
        if (patch.trim()) break;
        onEvent("nudge", { instance_id: inst.instance_id, attempt: a + 1 });
      }
    } catch (e) { err = e.message; }
    finally { await ex.cleanup(); }
    if (patch.trim()) appendFileSync(out, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: MODEL_NAME, model_patch: patch }) + "\n");
    results.push({ instance_id: inst.instance_id, produced: !!patch.trim(), costHero, attempts, err });
    onEvent("instance", { instance_id: inst.instance_id, produced: !!patch.trim(), costHero, attempts, err });
  }
  return { out, results, produced: results.filter((r) => r.produced).length, total: results.length };
}

// In-RAM memory that persists for the duration of one instance (no disk, no compaction), so a
// re-nudge run sees what the earlier run already explored instead of starting over.
const ramMemory = () => {
  const items = [];
  return {
    append: async (es) => { for (const e of es) items.push({ ...e, seq: items.length + 1 }); },
    raw: async () => items,
    getRoot: async () => null,
    sinceRoot: async () => items,
    setRoot: async () => {},
  };
};
