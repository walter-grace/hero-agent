# Benchmarks

hero-agent ships a coding benchmark that scores the agent objectively: it solves a task in a sandbox, and a verifier runs afterward (exit 0 means solved). Every run reports **pass rate and cost per task** from the same $HERO instrumentation the agent uses in production.

```bash
hero-agent bench-code                          # built-in suite, local sandbox
hero-agent bench-code --executor docker        # isolate each task in a container
hero-agent bench-code --tasks 1 --model cheapest
```

Each task runs in a fresh sandbox and the agent gets `shell`, `write_file`, and `read_file` tools. After it stops, the task's `verify` command runs; a zero exit counts as solved.

## Sandboxes

- **local** (default): a disposable temp directory. The agent's commands run on your host, so use it only with the built-in suite (tasks written here, with known verifiers).
- **docker**: one `python:3.12-slim` container per task, network disabled. Use this for anything you did not write yourself. Requires the Docker daemon.

## Cost note

A real coding task is several frontier-model calls (write, run, read the error, fix). Fund the key you pass in `HERO_RUN_KEY` before a full run. A single task on a low balance stops with an "insufficient credits" message rather than half-finishing.

With a matching model tier, cost per task lands near other harnesses running the same class of model, because the underlying token prices are the same. The number worth reporting from a real run is **pass rate at that cost**, not a low price.

## Running real Terminal-Bench

The built-in suite is for quick local validation. For the published agent-harness comparison, run against [Terminal-Bench](https://www.tbench.ai), which scores agent harnesses on containerized terminal tasks.

The pieces you need:

1. **The Docker executor** (`src/bench/executor.mjs`) already speaks `docker run` / `docker exec`. Point it at Terminal-Bench's per-task container instead of the default image.
2. **A task adapter**: map a Terminal-Bench task's instruction to `agent.run(instruction)` and its test to the `verify` step. `runCodingBench` in `src/bench/run.mjs` takes any `{ id, instruction, setup, verify }` array, so a Terminal-Bench task loader drops straight in.
3. **The shell tools** (`src/tools/shell.mjs`) give the agent the terminal, which is what Terminal-Bench expects an agent to drive.

SWE-bench (Verified or Lite) works the same way: load the task, run the agent against the repo checkout in a container, and use the task's test patch as `verify`.
