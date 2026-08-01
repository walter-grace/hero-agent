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
  "on the exact commit the issue was filed against. Read the relevant code with the shell and " +
  "read_file, make the minimal change that resolves the issue, and use write_file to edit files. Do " +
  "not write new tests. Do not run git. When the fix is complete, stop.";

// Load instances from a local JSONL or JSON array (export the HF dataset once, see docs/benchmarks.md).
export function loadSweBench(path, { instance } = {}) {
  const text = readFileSync(path, "utf8").trim();
  let rows = text[0] === "[" ? JSON.parse(text) : text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (instance) rows = rows.filter((r) => r.instance_id === instance || r.instance_id.includes(instance));
  return rows;
}

export async function runSweBench({ apiKey, instances, out = "predictions.jsonl", model = "auto", maxSteps = 40, onEvent = () => {} }) {
  const provider = heroRun({ apiKey });
  writeFileSync(out, ""); // fresh predictions file
  const results = [];
  for (const inst of instances) {
    const ex = new LocalExecutor();
    let patch = "", costHero = 0, err = null;
    try {
      const url = `https://github.com/${inst.repo}.git`;
      // Fetch only the one commit we need (fast even for large repos like django).
      const setup = await ex.exec(`git init -q && git remote add origin ${url} && git fetch -q --depth 1 origin ${inst.base_commit} && git checkout -q FETCH_HEAD`, { timeout: 300000 });
      if (setup.code !== 0) throw new Error(`checkout failed: ${setup.stderr.slice(0, 200)}`);
      const agent = new Harness({ provider, memory: scratch(), tools: shellTools(ex), system: SYSTEM, model, maxSteps, compactEvery: Infinity, onEvent });
      ({ costHero } = await agent.run(inst.problem_statement));
      const diff = await ex.exec("git add -A && git diff --cached", { timeout: 60000 });
      patch = diff.stdout || "";
    } catch (e) { err = e.message; }
    finally { await ex.cleanup(); }
    if (patch.trim()) appendFileSync(out, JSON.stringify({ instance_id: inst.instance_id, model_name_or_path: MODEL_NAME, model_patch: patch }) + "\n");
    results.push({ instance_id: inst.instance_id, produced: !!patch.trim(), costHero, err });
    onEvent("instance", { instance_id: inst.instance_id, produced: !!patch.trim(), costHero, err });
  }
  return { out, results, produced: results.filter((r) => r.produced).length, total: results.length };
}

const scratch = () => ({ append: async () => {}, getRoot: async () => null, sinceRoot: async () => [], setRoot: async () => {} });
