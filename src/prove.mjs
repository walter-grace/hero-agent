// prove: drive an agent to prove a theorem in Lean 4 inside an E2B sandbox, looping until Lean
// verifies clean. Mirrors the bench runner shape (runCodingBench): fresh executor, scratch memory,
// shell + aristotle tools, a skill-driven system prompt, then an objective verifier (a clean build
// with no `sorry`). Everything (toolchain, proof files, compilation) stays in the sandbox; only the
// final .lean and a short trace surface.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { Harness } from "./harness.mjs";
import { heroRun, heroUsd } from "./provider.mjs";
import { shellTools } from "./tools/shell.mjs";
import { aristotleTools } from "./tools/aristotle.mjs";
import { E2BExecutor, setupLean, PROOF_DIR } from "./bench/e2b-executor.mjs";

const scratchMemory = () => ({ append: async () => {}, getRoot: async () => null, sinceRoot: async () => [], setRoot: async () => {} });

// The prove skill lives in skills/prove/PROVE.md (a subdir so it does NOT auto-load into the chat
// agent's global skills). We read it here and use it as the system prompt for the prove harness.
function loadProveSkill() {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "skills", "prove", "PROVE.md");
  if (existsSync(path)) return readFileSync(path, "utf8");
  return "You are a Lean 4 theorem-proving agent. Draft Lean, compile it in the sandbox, read errors, and iterate until the build is clean with no sorry.";
}

// Verify: a clean `lake build` and no remaining `sorry` in Proof.lean. This is the objective pass/fail.
async function verifyProof(executor) {
  const build = await executor.exec(
    `cd ${PROOF_DIR} && export PATH="$HOME/.elan/bin:$PATH" && lake build 2>&1`,
    { timeout: 20 * 60_000 },
  );
  const lean = await executor.read(`${PROOF_DIR}/Proof.lean`);
  const hasSorry = /\bsorry\b/.test(lean) || /\badmit\b/.test(lean);
  const verified = build.code === 0 && !hasSorry;
  return { verified, buildCode: build.code, buildOutput: (build.stdout || build.stderr || "").slice(0, 3000), lean, hasSorry };
}

export async function runProve(statement, {
  apiKey = process.env.HERO_RUN_KEY,
  model = "auto",
  maxSteps = 24,
  fullMathlib = false,
  timeoutMs = 20 * 60_000,
  onEvent = () => {},
} = {}) {
  const provider = heroRun({ apiKey });
  const price = await heroUsd().catch(() => 0);
  const executor = new E2BExecutor({ timeoutMs });

  const trace = [];
  const note = (m) => { trace.push(m); onEvent("phase", { message: m }); };

  let verified = false, finalLean = "", buildOutput = "", costHero = 0, err = null;
  try {
    note("creating E2B sandbox");
    await executor.init();
    note(`sandbox ${executor.label()}`);

    note(`installing Lean${fullMathlib ? " + Mathlib (heavy)" : " (Mathlib skipped)"}`);
    const lean = await setupLean(executor, { fullMathlib, onLog: (m) => onEvent("lean", { message: m }) });
    note(`Lean ready: ${lean.toolchain}${lean.mathlib ? " + Mathlib " : ""}`);

    const system =
      loadProveSkill() +
      `\n\n=== TASK ===\nProve this in Lean 4 and make it compile clean (no errors, no sorry):\n${statement}\n` +
      `\nYour lake project is at ${PROOF_DIR} and its entry file is ${PROOF_DIR}/Proof.lean.` +
      (fullMathlib ? " Mathlib is available; import what you need." : " Mathlib is NOT available in this run; use Lean 4 core only.");

    const agent = new Harness({
      provider, memory: scratchMemory(),
      tools: [...shellTools(executor), ...aristotleTools()],
      system, model, maxSteps, compactEvery: Infinity, onEvent,
    });

    note("running the proof loop");
    const res = await agent.run(`Prove: ${statement}`);
    costHero = res.costHero || 0;

    note("verifying final build");
    const v = await verifyProof(executor);
    verified = v.verified; finalLean = v.lean; buildOutput = v.buildOutput;
    note(verified ? "VERIFIED: clean build, no sorry" : `NOT verified (build exit ${v.buildCode}${v.hasSorry ? ", sorry present" : ""})`);
  } catch (e) {
    err = e.message;
    note(`error: ${e.message}`);
  } finally {
    await executor.cleanup();
    note("sandbox cleaned up");
  }

  return { verified, statement, finalLean, buildOutput, costHero, costUsd: costHero * price, trace, err };
}
