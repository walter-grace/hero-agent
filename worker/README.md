# hero-jobs-worker — Cloudflare Worker cron for scheduled agent jobs

The always-on scheduler. On its Cron Trigger it reads each configured agent's jobs from **on-chain
memory** (Robinhood Chain), runs the due ones through Hero Run, and checkpoints each result back
on-chain. Jobs you schedule from **herorunai.com/memory-graph** (or `hero-agent job add`) are exactly
what this runs — so scheduling and execution share one source of truth: the agent's memory NFT.

It reuses the same protocol as the CLI: `../src/jobs.mjs` (unchanged) for the job logic, and a
Workers-native memory client (`memory.mjs`: viem + WebCrypto + fflate) that reads/writes the same
encrypted, hash-chained checkpoints the browser and CLI do.

## Set up a burner (never paste a key)

Use a dedicated burner wallet + its own agent for the cron, so the key in the Worker can only touch a
throwaway wallet. The key is written to a `chmod 600` file and never printed:

```bash
hero-agent wallet new                                  # writes ~/.hero-agent/keys/<address>.key, prints only the address
# fund that address with a little RH gas, then:
hero-agent wallet mint-agent --key-file ~/.hero-agent/keys/<address>.key   # mints the cron agent, prints its id
# schedule work on it (key stays in the file, --key-file loads it):
hero-agent job add "…" --every 6h --memory onchain --agent <id> --key-file ~/.hero-agent/keys/<address>.key
```

Then set `AGENT_IDS` to that agent id below, and load the key into the Worker straight from the file:

```bash
npx wrangler secret put AGENT_PRIVATE_KEY < ~/.hero-agent/keys/<address>.key   # file → Cloudflare, never pasted
```

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
