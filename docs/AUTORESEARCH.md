# Durable autoresearch worker

Runs a contributed `train.py` diff through the `val_bpb` replay as **durable, on-chain-checkpointed
steps**, then posts the verdict to the web app's ground-truth ingest seam. It is the automated,
resumable, verifiable version of the manual `hero-agent replay` → post-verdict flow.

## Why on-chain checkpoints = durable execution

Each completed step (`fetch → replay → classify → ingest`) is checkpointed to the Agent Memory
contract on Robinhood Chain (encrypted, hash-chained, via `OnchainMemory`). The chain **is** the event
log: on a crash or restart, `DurableRun.load()` reads the log and resumes from the last completed step
instead of re-running it. Unlike a managed workflow log, the state is wallet-owned, portable, and
anyone can verify the run happened as claimed. No external workflow backend.

The `replay` step is deliberately re-run on resume if it didn't finish (it's idempotent and is the
only expensive step); `fetch`/`classify`/`ingest` are memoized once on-chain.

## Run it

Inert unless `AUTORESEARCH_ENABLED=1`.

```bash
# Offline test of the durable mechanism (no E2B, no gas): local log, stubbed replay.
AUTORESEARCH_ENABLED=1 hero-agent autoresearch <train.py-diff> \
  --contribution <id> --memory local --file /tmp/ar.jsonl --dry-replay --fake-verdict improved
# Run it twice with the same --contribution to see it resume from the log.

# Real run: replay in an E2B sandbox (egress OFF), checkpoints on Robinhood Chain, post the verdict.
AUTORESEARCH_ENABLED=1 \
E2B_API_KEY=... \
AGENT_PRIVATE_KEY=0x...            # a wallet with a little RH gas; owns the memory agent \
FOUNDRY_INGEST_URL=https://herorunai.com/api/foundry/verify/resolve \
FOUNDRY_ATTESTOR_KEY=...           # must equal the web app's FOUNDRY_ATTESTOR_KEY \
hero-agent autoresearch <train.py-diff> --contribution <id> --memory onchain --agent <agentId>
```

Flags: `--contribution <id>` (required, the corpus contribution being replayed), `--memory
onchain|local`, `--agent <id>` (memory agent NFT id, for onchain), `--file <mem.jsonl>` (local memory
path), `--seeds N`, `--steps N`, `--timeout <secs>`, `--source <s>`, `--dry-replay` (+`--fake-verdict`
/`--fake-delta`).

## What it posts

To `FOUNDRY_INGEST_URL` (the web app's `resolveGroundTruth` seam), authed with `FOUNDRY_ATTESTOR_KEY`:
`{ contributionId, source: "replay", outcome, valBpbDelta, evidence }`. The replay verdict is mapped
to the engine's vocabulary (`tampered → eval_tamper`; `improved`/`no_effect`/`regressed` pass through;
`error` is skipped, nothing posted). Without the URL/key it's a dry run — it prints the payload and
posts nothing.

## Activation checklist (operator)

1. Set `FOUNDRY_ATTESTOR_KEY` on BOTH the web app (Vercel) and this worker to the same value.
2. Set `FOUNDRY_ENABLED`/`FOUNDRY_VERIFY_ENABLED` on the web app so the resolve seam is open (else 503).
3. Fund the `AGENT_PRIVATE_KEY` wallet with a little RH gas and give it (or mint) a memory agent id.
4. `AUTORESEARCH_ENABLED=1` + `E2B_API_KEY`, then run per-contribution.

Nothing here moves user funds; payouts stay stubbed on the web app pending legal review. The worker
only measures and reports.

## Not yet (deliberate)

- **Candidate pull is manual** (one diff + `--contribution` per run). A `--api` mode that pulls the
  next pending replayable contribution from a corpus endpoint is a later add; it would need a new web
  endpoint, which we intentionally avoided to keep the live app untouched.
- **CPU-tiny stack.** The replay uses the pinned toy stack (proves the mechanism). Production swaps it
  for nanochat/autoresearch on a GPU sandbox (see `src/replay/stack.mjs`).
