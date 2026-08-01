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

The built-in suite is for quick local validation. For the published agent-harness comparison, run against [Terminal-Bench](https://www.tbench.ai), which scores agent harnesses on containerized terminal tasks. hero-agent ships an adapter, so it's one command once you have the dataset:

```bash
git clone https://github.com/laude-institute/terminal-bench
export HERO_RUN_KEY=hr_live_...          # funded; a full run is many frontier calls
export DOCKER_HOST=...                    # Docker daemon must be running

hero-agent terminal-bench --dataset ./terminal-bench --task hello-world   # one task
hero-agent terminal-bench --dataset ./terminal-bench                       # the whole set
```

For each task the adapter reads `task.yaml` for the instruction, builds the task's own container (Dockerfile or `docker-compose.yaml`), lets the agent drive it through the shell tools, then copies in `tests/` and runs `run-tests.sh`. All tests passing counts as solved. It reports pass rate and cost per task.

Two knobs cover dataset variation, since the layout shifted between Terminal-Bench 1.x and 2.0 (Harbor):

- `--service <name>`: the compose service the agent works in (default `client`).
- `--tests-path <path>`: where `run-tests.sh` expects the tests (default `/app/tests`).

The adapter is built to the documented task format and validated on the parser and file-detection side. Confirm the two knobs against your checkout before trusting the pass rate, since a dataset can wire tests differently.

## Smoke test first

Before any real run, confirm the whole chain works for a few $HERO:

```bash
hero-agent smoke
```

It runs one trivial coding task on the cheapest model in a local sandbox and scores it. A pass means the key, the agent loop, the shell tools, and the verifier all work. Then move to `bench-code`, `terminal-bench`, or `swe-bench` with a funded key.

## SWE-bench Lite

SWE-bench gives the agent a real GitHub issue on a real repo at a fixed commit; the agent must produce a patch that resolves it. hero-agent produces the patches; SWE-bench's own harness scores them (it applies the hidden test patch and runs the target tests in the official per-repo image). We do not reimplement that scoring.

Export the dataset once, then run:

```bash
# 1. export SWE-bench Lite to JSONL (needs the `datasets` python package)
python -c "from datasets import load_dataset; import json; \
[print(json.dumps(dict(r))) for r in load_dataset('princeton-nlp/SWE-bench_Lite', split='test')]" > lite.jsonl

# 2. produce patches (start with one instance to smoke-test the flow)
hero-agent swe-bench --dataset lite.jsonl --instance django__django-11099 --out predictions.jsonl
hero-agent swe-bench --dataset lite.jsonl --out predictions.jsonl        # the whole set

# 3. score with SWE-bench's official harness
python -m swebench.harness.run_evaluation \
  --predictions_path predictions.jsonl \
  --dataset_name princeton-nlp/SWE-bench_Lite \
  --run_id hero-agent
```

For each instance the agent works in a fresh checkout of the repo at `base_commit` (fetched shallow, one commit), edits files, and its `git diff` becomes the patch in `predictions.jsonl` (the format the harness expects: `instance_id`, `model_name_or_path`, `model_patch`). Step 3 needs Docker and the `swebench` package. Instances the agent left unchanged are skipped, so the resolved rate is computed over what it actually attempted.
