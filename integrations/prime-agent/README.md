# Hero Run × Prime Agent

Three ways to connect [Hero Run](https://herorunai.com) (the $HERO inference rail + wallet-owned
on-chain agent memory) to [Prime Intellect's prime-agent](https://github.com/PrimeIntellect-ai/prime-agent).
Built from prime-agent's own documented extension API. MIT.

Prime Intellect and Hero Run share one thesis: fund and build open AI. prime-agent is their coding /
research agent CLI with a pluggable inference layer and a local-file "Continual Harness" memory. Hero
Run supplies exactly what it doesn't have: an inference rail that funds open training, and memory that
is portable, verifiable, and owned. These are the seams.

---

## Play #1 — Run prime-agent paid-in-$HERO  (`hero-run-provider.ts`)

Routes prime-agent's inference through Hero Run's OpenAI-compatible gateway: 500+ models across 16
gateways, one key, billed per call in $HERO. Every call funds a frontier open-source training run,
which is prime-agent running *on* the thesis.

It registers a `hero-run` provider via prime-agent's documented `pi.registerProvider()` with
`api: "openai-completions"`, and discovers models live from `/v1/models`.

```bash
# 1. Mint a key: https://herorunai.com/keys  (connect a Base wallet, deposit $HERO -> hr_live_...)
export HERO_RUN_KEY=hr_live_...
# 2. Load hero-run-provider.ts as a prime-agent extension, then inside prime-agent:
#      /login  -> pick "Hero Run"        (or just run a model as `hero-run/auto`)
#    `auto` = the router picks a right-sized model at one flat price.
```

This is the one to ship first: it's a base-URL + auth + model-list wiring against machinery
prime-agent already has, and it yields a clean "Prime Intellect's own agent runs on the $HERO rail"
proof point.

## Play #2 — On-chain, wallet-owned memory for the Continual Harness  (`hero-memory-bridge.mjs`)

prime-agent's durable state (supplemental prompts, memories, skills, subagent specs) lives in local
files, not portable, not verifiable, not resumable elsewhere. This bridge checkpoints that state onto
Hero Run's [agent-memory](https://github.com/walter-grace/agent-memory) contract on Robinhood Chain
(encrypted, hash-linked, wallet-owned), so the same wallet resumes the harness on any machine.

```bash
PRIVATE_KEY=0x...  node hero-memory-bridge.mjs push    # local harness -> on-chain
PRIVATE_KEY=0x...  node hero-memory-bridge.mjs pull    # on-chain -> local (resume elsewhere)
```

Status: v0. It's fully wired against the open-source agent-memory SDK; the one thing to confirm per
prime-agent version is the harness state directory (`PRIME_STATE_DIR`, defaults to `~/.prime`) and
which files are the durable state. This showcases the moat instead of competing on harness features.

## Play #3 — Big Distill → Prime Intellect environments  (`BIG-DISTILL-PITCH.md`)

Not code, a BD/data conversation. Hero Run's curated public corpus (agent-memory artifacts, opt-in and
licensed) becomes inputs to Prime Intellect's Verifiers environments and the training runs $HERO
exists to fund. The deepest strategic fit and the bridge to a real collaboration. See the pitch doc.

---

## What NOT to do
Do not adopt prime-agent as hero-agent's harness. That would trade away the on-chain, wallet-owned
memory moat and the $HERO thesis for a local-files coding CLI. Borrow its `/refine` Continual Harness
*design* (review trajectory → small evidence-backed updates → promote to skills) for our tiered-memory
promotion gate, but store the state on-chain, not on disk. That's the differentiated version.

## License
MIT (matches prime-agent). Attribution appreciated.
