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

// Lean's own trusted axioms. Anything else in `#print axioms` means the proof leans on something
// the kernel did not check: `sorryAx` is an open hole, a user `axiom` is an assumption, and
// `native_decide` trusts the compiler rather than the kernel.
const TRUSTED_AXIOMS = new Set(["propext", "Classical.choice", "Quot.sound"]);

// Strip line and block comments so a comment that merely says "sorry" cannot fail a real proof.
const stripComments = (src) => String(src || "").replace(/\/-[\s\S]*?-\//g, " ").replace(/--[^\n]*/g, " ");

// Verify a proof properly. A clean `lake build` is necessary but NOT sufficient: `sorryAx` compiles,
// and `theorem x : True := trivial` compiles too. The real test is Lean's own axiom report, so we ask
// the compiler which axioms each theorem depends on and require the trusted three. We also reject
// source-level escape hatches that make the kernel stop checking.
async function verifyProof(executor) {
  const build = await executor.exec(
    `cd ${PROOF_DIR} && export PATH="$HOME/.elan/bin:$PATH" && lake build 2>&1`,
    { timeout: 20 * 60_000 },
  );
  const lean = await executor.read(`${PROOF_DIR}/Proof.lean`);
  const code = stripComments(lean);

  // Source-level holes and escape hatches (comments already removed).
  const hasSorry = /\bsorry\b|\bsorryAx\b|\badmit\b/.test(code);
  const badPragma = /^\s*axiom\s|\bnative_decide\b|\bunsafe\b|@\[implemented_by/m.test(code);

  // Ask Lean which axioms every theorem in the file depends on. `#print axioms` prints either
  // "'name' does not depend on any axioms" or "'name' depends on axioms: [a, b]".
  const names = [...code.matchAll(/^\s*(?:@\[[^\]]*\]\s*)?(?:private\s+|protected\s+|noncomputable\s+)*(?:theorem|lemma)\s+([A-Za-z_][A-Za-z0-9_.'!?]*)/gm)].map((m) => m[1]);
  let axiomReport = "", untrusted = [];
  if (build.code === 0 && names.length) {
    const cmds = names.map((n) => `#print axioms ${n}`).join("\n");
    const probe = await executor.exec(
      `cd ${PROOF_DIR} && export PATH="$HOME/.elan/bin:$PATH" && cp Proof.lean .axcheck.lean && printf '%s\\n' ${JSON.stringify(cmds)} >> .axcheck.lean && lake env lean .axcheck.lean 2>&1; rm -f .axcheck.lean`,
      { timeout: 10 * 60_000 },
    );
    axiomReport = (probe.stdout || probe.stderr || "").slice(0, 3000);
    for (const m of axiomReport.matchAll(/depends on axioms:\s*\[([^\]]*)\]/g)) {
      for (const a of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!TRUSTED_AXIOMS.has(a)) untrusted.push(a);
      }
    }
    untrusted = [...new Set(untrusted)];
  }

  // No theorems at all is not a proof, however cleanly it builds.
  const verified = build.code === 0 && !hasSorry && !badPragma && names.length > 0 && untrusted.length === 0;
  return {
    verified, buildCode: build.code, buildOutput: (build.stdout || build.stderr || "").slice(0, 3000),
    lean, hasSorry, badPragma, theorems: names, untrustedAxioms: untrusted, axiomReport,
  };
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

  let verified = false, finalLean = "", buildOutput = "", costHero = 0, err = null, check = null;
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
    verified = v.verified; finalLean = v.lean; buildOutput = v.buildOutput; check = v;
    if (verified) {
      note(`VERIFIED: clean build, ${v.theorems.length} theorem(s), axioms limited to Lean's trusted three`);
    } else {
      const why = [
        v.buildCode !== 0 && `build exit ${v.buildCode}`,
        v.hasSorry && "sorry/admit present",
        v.badPragma && "axiom/native_decide/unsafe used",
        !v.theorems?.length && "no theorem declared",
        v.untrustedAxioms?.length && `untrusted axioms: ${v.untrustedAxioms.join(", ")}`,
      ].filter(Boolean).join("; ");
      note(`NOT verified (${why || "unknown"})`);
    }
  } catch (e) {
    err = e.message;
    note(`error: ${e.message}`);
  } finally {
    await executor.cleanup();
    note("sandbox cleaned up");
  }

  return { verified, statement, finalLean, buildOutput, costHero, costUsd: costHero * price, trace, err,
    theorems: check?.theorems || [], untrustedAxioms: check?.untrustedAxioms || [], axiomReport: check?.axiomReport || "" };
}
