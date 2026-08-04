# hero-jobs-worker — Cloudflare Worker cron for scheduled agent jobs

The always-on scheduler. On its Cron Trigger it reads each configured agent's jobs from **on-chain
memory** (Robinhood Chain), runs the due ones through Hero Run, and checkpoints each result back
on-chain. Jobs you schedule from **herorunai.com/memory-graph** (or `hero-agent job add`) are exactly
what this runs — so scheduling and execution share one source of truth: the agent's memory NFT.

It reuses the same protocol as the CLI: `../src/jobs.mjs` (unchanged) for the job logic, and a
Workers-native memory client (`memory.mjs`: viem + WebCrypto + fflate) that reads/writes the same
encrypted, hash-chained checkpoints the browser and CLI do.

## Deploy

Prereqs: Cloudflare Workers Paid isn't required for cron (cron is on the free plan), `npx wrangler login`.

```bash
cd ~/Desktop/hero-agent/worker
npm install

# Which agents to service (the wallet below must own them):
#   edit "AGENT_IDS" in wrangler.jsonc, e.g. "3,6"

# Secrets:
npx wrangler secret put AGENT_PRIVATE_KEY   # a funded RH wallet that owns those agents (a little gas)
npx wrangler secret put HERO_RUN_KEY        # pays for each job's inference
npx wrangler secret put RUN_SECRET          # bearer for the manual /run endpoint

npm run deploy
```

Cron cadence is `*/30 * * * *` (every 30 min) in `wrangler.jsonc` — tighten/loosen freely; `run-due`
is interval-gated so extra ticks are harmless.

## Test it without waiting for the cron

```bash
npm run dev            # local; then in the dev console trigger the scheduled event
# or, against the deployed worker, fire a tick now:
curl -X POST https://hero-jobs-worker.<subdomain>.workers.dev/run -H "Authorization: Bearer $RUN_SECRET"
# → JSON: how many agents serviced, how many jobs ran, and the log lines.
```

`GET /` returns a health JSON.

## The full loop

1. Schedule a job on an agent NFT — from the memory graph (Append/Schedule panel) or `hero-agent job add`.
2. This Worker fires on its cron, reads that job from the agent's on-chain memory, runs it, and writes
   the result back as a `jobrun::` checkpoint.
3. See the result on the memory graph, on Blockscout, or via `hero-agent recall --memory onchain --agent <id>`.

No user funds move; the Worker only spends the configured key's $HERO on inference and a little RH gas
for the result checkpoints. Nothing runs until `AGENT_IDS` + the secrets are set.
