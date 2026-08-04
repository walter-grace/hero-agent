# Scheduled agent jobs — the decentralized cron

A job lives IN the agent's on-chain memory. A cron pings that memory every so often and runs the due
jobs, checkpointing each result back. Schedule + history are wallet-owned and verifiable on-chain.

## Model
- `job::{jobId, task, everyMs, enabled, createdAt}` — a job definition (one memory checkpoint).
- `jobrun::{jobId, at, ok, result}` — one run's result (one checkpoint). `lastRun` is derived as the
  newest run timestamp; a job is "due" when `now - lastRun >= everyMs`.
- Append-only, so no mutable state: current job = latest `job::` for its id; history = all `jobrun::`.

## Commands
```bash
# Define a job (stored in memory; onchain writes a checkpoint tx)
hero-agent job add "Summarize new AI security CVEs affecting our stack." --every 6h --memory onchain --agent 6

hero-agent job list --memory onchain --agent 6           # jobs + lastRun

# The cron tick: run every due job through the brain, checkpoint results back to memory
hero-agent run-due --memory onchain --agent 6            # needs HERO_RUN_KEY + AGENT_PRIVATE_KEY
hero-agent run-due --memory local --file /tmp/j.jsonl --dry   # offline test (stubbed brain)
```

## Wire the cron (pick one)
`run-due` is stateless and idempotent (interval-gated), so call it as often as you like:

- **Cloudflare Worker Cron Trigger** (`[triggers] crons = ["*/30 * * * *"]`) → a Worker that shells to
  a hosted `run-due` or calls the same logic. This is the "always-on decentralized worker" shape.
- **Vercel cron** — `vercel.json` `{ "crons": [{ "path": "/api/jobs/run-due", "schedule": "*/30 * * * *" }] }`
  hitting a route that runs the tick.
- **launchd / systemd / pm2** — `*/30 * * * * hero-agent run-due --memory onchain --agent 6`.

Keys the tick needs for a real run: `HERO_RUN_KEY` (brain) + `AGENT_PRIVATE_KEY` (to checkpoint
results on-chain) + a little RH gas. Inert otherwise. No user funds move.

## Verified
Dry run: added 2 jobs → `run-due` ran both and logged results → an immediate second `run-due` found
0 due (interval gating), with `lastRun` populated. See `src/jobs.mjs`.
