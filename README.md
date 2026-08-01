# hero-agent

A personal AI agent with a memory that's actually **yours** — wallet-owned, compacting, and (optionally) sealed encrypted onto **Robinhood Chain**. Its brain is **[Hero Run](https://herorunai.com)**: one key, one endpoint, auto-routed across ~15 inference providers and billed in $HERO. No per-provider keys, no model config.

Built on **`hero-harness`** — the small, provider- and memory-agnostic runtime that hosts it (the loop, the tool layer, pluggable memory, and stateless sub-agents). Inspired by picoclaw's tiny agent loop and Hermes' disk-first, drop-on-a-$5-VPS design — with one thing they don't have: memory you own and can carry between agents, because your wallet is the only key.

```
input → Hero Run (brain) → tools (web search · generate · MCP) → output
                     ↑                                    ↓
             ROOT memory index  ←  compaction  ←  raw memories (leaves)
```

## Quickstart

```bash
git clone https://github.com/walter-grace/hero-agent && cd hero-agent
npm install                       # viem is optional (only for on-chain memory)
export HERO_RUN_KEY=hr_live_...   # mint one at https://herorunai.com/keys

node bin/hero-agent.mjs chat      # talk to it; it remembers across sessions
```

That's it — no OpenAI/Anthropic keys, no model list. The default memory is a local JSONL file, so it runs anywhere.

## Commands

```bash
hero-agent chat                       # interactive REPL, remembers + compacts automatically
hero-agent run "research X and summarize"
hero-agent remember "I prefer dark roasts"
hero-agent recall                     # print the ROOT index + memory stats
hero-agent compact                    # force a compaction now
```

Flags: `--memory local|onchain` · `--file <path>` · `--agent <id>` · `--mcp "fs:npx -y @modelcontextprotocol/server-filesystem ."`

## Memory: compaction, not a growing transcript

Raw memories are **append-only leaves and never deleted**. Compaction builds a small, constant-cost **ROOT index** on top of them — the agent reads the ROOT + only what's new, so it knows what it knows without replaying its whole history. Two ideas drive it:

- **Hierarchical compaction** ([openclaw#51612](https://github.com/openclaw/openclaw/issues/51612)): summarize into an index, keep the raw beneath.
- **Log-structured merge** ([RocksDB compaction](https://github.com/facebook/rocksdb/wiki/Compaction)): when memories conflict about the same thing, the **newest supersedes the stale** — a changed preference or reversed decision keeps only the current state.

The compaction prompt is accuracy-first: preserve every concrete fact/identifier, never invent, newest-wins, keep-if-unsure. (Fixture-tested: a light→dark preference flip keeps *dark*, preserves an account number verbatim, drops chit-chat, invents nothing.)

### On-chain memory (optional)

```bash
export AGENT_PRIVATE_KEY=0x...        # a wallet you control, with a little Robinhood Chain gas
hero-agent chat --memory onchain --agent 7
```

Each memory is AES-256-GCM encrypted with a key derived from your wallet's signature, gzip'd, and checkpointed to the Agent Memory contract on Robinhood Chain. On-chain (and to Hero Run) it's just random bytes — only your wallet can decrypt. Because the key is the wallet's, **any agent you own can read another's memory**: one brain, many agents. Mint an agent at [herorunai.com/agent](https://herorunai.com/agent).

## Tools

- **web_search** — live results (routed to Perplexity Sonar through Hero Run; no separate search key).
- **hero_generate** — image or audio from a prompt.
- **MCP** — point it at any [MCP](https://modelcontextprotocol.io) stdio server and its tools become the agent's tools.

## Use it as a library

```js
import { createHeroAgent } from "hero-agent";
const agent = await createHeroAgent({ apiKey: process.env.HERO_RUN_KEY });
const { text } = await agent.run("What did we decide about the Seattle location?");
```

`hero-harness` is exported separately (`hero-agent/harness`) if you want the runtime with your own provider/memory.

## Skills

Drop `SKILL.md` files in `./skills/` and they're appended to the agent's system prompt (picoclaw-style).

## License

MIT.
