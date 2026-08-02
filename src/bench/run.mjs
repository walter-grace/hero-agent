// Coding-benchmark runner. For each task: spin a fresh sandbox, run setup, hand the agent the
// instruction plus shell/file tools, let it work, then run the task's verifier (exit 0 = solved).
// Records solved/cost/steps per task and reports pass rate alongside cost — the two numbers that
// actually matter for an agent harness. Cost comes from the same $HERO instrumentation as `bench`.
import { Harness } from "../harness.mjs";
import { heroRun, heroUsd } from "../provider.mjs";
import { shellTools } from "../tools/shell.mjs";
import { LocalExecutor, DockerExecutor } from "./executor.mjs";
import { E2BExecutor } from "./e2b-executor.mjs";

const CODING_SYSTEM =
  "You are a coding agent working in a sandbox. Use the shell, write_file, and read_file tools to " +
  "complete the task. Write the code, run it, read any errors, and iterate until it works. Verify " +
  "your own work by running it before you finish. When the task is done, stop and say so. Do not ask " +
  "the user questions; act.";

const scratchMemory = () => ({ append: async () => {}, getRoot: async () => null, sinceRoot: async () => [], setRoot: async () => {} });

export async function runCodingBench({ apiKey, tasks, executor = "local", image, model = "auto", maxSteps = 14, onEvent = () => {} }) {
  const provider = heroRun({ apiKey });
  const price = await heroUsd();
  const results = [];
  for (const task of tasks) {
    const ex = executor === "docker" ? new DockerExecutor({ image })
      : executor === "e2b" ? new E2BExecutor()
      : new LocalExecutor();
    let solved = false, costHero = 0, err = null;
    try {
      await task.setup?.(ex);
      const agent = new Harness({ provider, memory: scratchMemory(), tools: shellTools(ex), system: CODING_SYSTEM, model, maxSteps, compactEvery: Infinity, onEvent });
      const { costHero: c } = await agent.run(task.instruction);
      costHero = c;
      const v = await ex.exec(task.verify, { timeout: 60000 });
      solved = v.code === 0;
    } catch (e) { err = e.message; }
    finally { await ex.cleanup(); }
    results.push({ id: task.id, solved, costHero, err });
    onEvent("task", { id: task.id, solved, costHero, err });
  }
  const solvedN = results.filter((r) => r.solved).length;
  const totalHero = results.reduce((s, r) => s + r.costHero, 0);
  const solvedHero = results.filter((r) => r.solved).reduce((s, r) => s + r.costHero, 0);
  return {
    results, price,
    passRate: results.length ? solvedN / results.length : 0,
    solved: solvedN, total: results.length,
    avgCostHero: results.length ? totalHero / results.length : 0,
    avgCostUsd: (results.length ? totalHero / results.length : 0) * price,
    costPerSolvedUsd: solvedN ? (solvedHero / solvedN) * price : null,
  };
}
