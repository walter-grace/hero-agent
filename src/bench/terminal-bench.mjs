// Terminal-Bench adapter. Runs hero-agent against a checked-out Terminal-Bench dataset: build each
// task's own container, let the agent drive it through the shell tools, then run the task's tests to
// score it. Reports pass rate + cost per task, the two numbers the published harness comparison uses.
//
// Terminal-Bench task layout (standard):
//   tasks/<name>/
//     task.yaml            # instruction: <the English prompt> (+ metadata)
//     Dockerfile           # environment (or docker-compose.yaml with a service, default "client")
//     run-tests.sh         # installs test deps and runs pytest
//     tests/               # pytest files; all pass  ==>  task solved
//     solution.sh|.yaml    # oracle (ignored here)
//
// The tests are copied in AFTER the agent stops (the agent never sees them), matching how the real
// harness scores. Requires the Docker daemon, a funded HERO_RUN_KEY, and a local dataset checkout:
//   git clone https://github.com/laude-institute/terminal-bench
//
// Two knobs cover dataset variation (v1 vs v2/Harbor): --service (compose service name) and
// --tests-path (where run-tests.sh expects the tests). Verify against your checkout before trusting
// the numbers; this adapter is built to the documented format but the live wiring can differ per set.
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Harness } from "../harness.mjs";
import { heroRun, heroUsd } from "../provider.mjs";
import { shellTools } from "../tools/shell.mjs";
const pexec = promisify(execFile);

// Parse task.yaml's `instruction`. Uses the `yaml` package if installed; falls back to a block-scalar
// aware extractor good enough for the `instruction:` field alone.
async function readInstruction(taskYaml) {
  const text = readFileSync(taskYaml, "utf8");
  // Prefer a real YAML parser (optional `yaml` dep) for full correctness.
  try { const YAML = (await import("yaml")).default; const o = YAML.parse(text); if (o?.instruction) return String(o.instruction).trim(); } catch {}
  // Fallback: line-based parse of the `instruction:` field, block scalar (| or >) aware.
  const lines = text.split("\n");
  const i = lines.findIndex((l) => /^instruction:/.test(l));
  if (i < 0) return null;
  const head = lines[i].replace(/^instruction:\s*/, "");
  if (!/^[|>]/.test(head.trim())) return head.trim().replace(/^["']|["']$/g, "") || null; // inline
  // Block scalar: take following lines more-indented than the key until dedent to a new key.
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === "") { body.push(""); continue; }
    if (!/^\s/.test(l)) break;            // back to column 0 = next key
    body.push(l);
  }
  const indent = Math.min(...body.filter((b) => b.trim()).map((b) => b.match(/^ */)[0].length));
  return body.map((b) => b.slice(indent)).join("\n").trim();
}

export async function loadTerminalBenchTasks(datasetDir, { include } = {}) {
  const tasksRoot = existsSync(join(datasetDir, "tasks")) ? join(datasetDir, "tasks") : datasetDir;
  const names = readdirSync(tasksRoot).filter((n) => statSync(join(tasksRoot, n)).isDirectory() && existsSync(join(tasksRoot, n, "task.yaml")));
  const filtered = include ? names.filter((n) => n.includes(include)) : names;
  const tasks = [];
  for (const name of filtered) {
    const dir = join(tasksRoot, name);
    tasks.push({
      id: name, dir,
      instruction: await readInstruction(join(dir, "task.yaml")),
      compose: existsSync(join(dir, "docker-compose.yaml")) ? join(dir, "docker-compose.yaml") : existsSync(join(dir, "docker-compose.yml")) ? join(dir, "docker-compose.yml") : null,
      dockerfile: existsSync(join(dir, "Dockerfile")),
      runTests: existsSync(join(dir, "run-tests.sh")),
      testsDir: existsSync(join(dir, "tests")),
    });
  }
  return tasks;
}

// Executor bound to one Terminal-Bench task's container. Builds/starts it, execs the agent's
// commands, and runs the task's tests to verify.
class TBExecutor {
  constructor(task, { service = "client", testsPath = "/app/tests" } = {}) {
    this.task = task; this.service = service; this.testsPath = testsPath;
    this.useCompose = !!task.compose;
    this.cname = `hero-tb-${task.id}-${Math.floor(Date.now() % 1e9)}`;
    this.image = `hero-tb-${task.id}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  }
  async start() {
    if (this.useCompose) {
      await pexec("docker", ["compose", "-p", this.cname, "-f", this.task.compose, "up", "-d", "--build"], { timeout: 600000 });
    } else {
      await pexec("docker", ["build", "-t", this.image, this.task.dir], { timeout: 600000 });
      await pexec("docker", ["run", "-d", "--name", this.cname, this.image, "sleep", "infinity"], { timeout: 60000 });
    }
  }
  _base() { return this.useCompose ? ["docker", ["compose", "-p", this.cname, "-f", this.task.compose, "exec", "-T", this.service]] : ["docker", ["exec", this.cname]]; }
  async exec(cmd, { timeout = 60000 } = {}) {
    const [bin, pre] = this._base();
    try { const { stdout, stderr } = await pexec(bin, [...pre, "sh", "-c", cmd], { timeout, maxBuffer: 8 << 20 }); return { code: 0, stdout, stderr }; }
    catch (e) { return { code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || String(e.message) }; }
  }
  async write(path, content) { const b64 = Buffer.from(content).toString("base64"); return this.exec(`mkdir -p "$(dirname '${path}')"; echo '${b64}' | base64 -d > '${path}'`); }
  async read(path) { const r = await this.exec(`cat '${path}'`); return r.code === 0 ? r.stdout : `read error: ${r.stderr}`; }
  // Copy the tests in (agent never saw them) and run the task's own test script. Solved = exit 0.
  async verify() {
    const target = this.useCompose ? `${this.cname}-${this.service}-1` : this.cname;
    try {
      if (this.task.testsDir) await pexec("docker", ["cp", join(this.task.dir, "tests"), `${target}:${this.testsPath.replace(/\/tests$/, "")}/tests`], { timeout: 60000 }).catch(() => {});
      if (this.task.runTests) await pexec("docker", ["cp", join(this.task.dir, "run-tests.sh"), `${target}:/run-tests.sh`], { timeout: 60000 });
    } catch {}
    const r = await this.exec(this.task.runTests ? "sh /run-tests.sh" : `python3 -m pytest -q ${this.testsPath}`, { timeout: 300000 });
    return r.code === 0;
  }
  async cleanup() {
    try { if (this.useCompose) await pexec("docker", ["compose", "-p", this.cname, "-f", this.task.compose, "down", "-v"], { timeout: 120000 }); else await pexec("docker", ["rm", "-f", this.cname], { timeout: 60000 }); } catch {}
  }
}

const TB_SYSTEM =
  "You are a terminal agent solving a task in a live shell. Use the shell, write_file, and read_file " +
  "tools to inspect the environment and complete the task. Run commands to check your work. Do not ask " +
  "questions; act, and finish when the task is done.";

export async function runTerminalBench({ apiKey, datasetDir, include, model = "auto", maxSteps = 30, service, testsPath, onEvent = () => {} }) {
  const provider = heroRun({ apiKey });
  const price = await heroUsd();
  const tasks = await loadTerminalBenchTasks(datasetDir, { include });
  const results = [];
  for (const task of tasks) {
    if (!task.instruction) { results.push({ id: task.id, solved: false, costHero: 0, err: "no instruction" }); continue; }
    const ex = new TBExecutor(task, { service, testsPath });
    let solved = false, costHero = 0, err = null;
    try {
      await ex.start();
      const scratch = { append: async () => {}, getRoot: async () => null, sinceRoot: async () => [], setRoot: async () => {} };
      const agent = new Harness({ provider, memory: scratch, tools: shellTools(ex), system: TB_SYSTEM, model, maxSteps, compactEvery: Infinity, onEvent });
      ({ costHero } = await agent.run(task.instruction));
      solved = await ex.verify();
    } catch (e) { err = e.message; }
    finally { await ex.cleanup(); }
    results.push({ id: task.id, solved, costHero, err });
    onEvent("task", { id: task.id, solved, costHero, err });
  }
  const solvedN = results.filter((r) => r.solved).length;
  const totalHero = results.reduce((s, r) => s + r.costHero, 0);
  return { results, price, solved: solvedN, total: results.length, passRate: results.length ? solvedN / results.length : 0, avgCostUsd: (results.length ? totalHero / results.length : 0) * price };
}
