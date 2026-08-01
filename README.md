# hero-agent

A personal AI agent whose memory belongs to you: wallet-owned, compacting, and optionally sealed encrypted onto **Robinhood Chain**. Its brain is **[Hero Run](https://herorunai.com)**. You set one key and one endpoint; Hero Run auto-routes each call across ~15 inference providers and bills in $HERO. No per-provider keys. No model config.

It runs on **`hero-harness`**, a small runtime that stays agnostic to the provider and the memory backend. The harness owns the loop, the tool layer, the pluggable memory, and stateless sub-agents. picoclaw shaped the tiny agent loop; Hermes shaped the disk-first design you can drop on a $5 VPS. hero-agent adds memory you own and carry between agents, since your wallet holds the only key.

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

You need no OpenAI or Anthropic key and no model list. Memory defaults to a local JSONL file, so a fresh clone runs on any machine with Node 20.

## Commands

```bash
hero-agent chat                       # interactive REPL that remembers and compacts as you go
hero-agent run "research X and summarize"
hero-agent remember "I prefer dark roasts"
hero-agent recall                     # print the ROOT index + memory stats
hero-agent compact                    # force a compaction now
hero-agent bench                      # measure real cost per task
```

Flags: `--memory local|onchain` · `--file <path>` · `--agent <id>` · `--mcp "fs:npx -y @modelcontextprotocol/server-filesystem ."`

## Memory: compaction, not a growing transcript

Raw memories are append-only leaves. The agent never deletes them. Compaction builds a small, constant-cost **ROOT index** on top, and the agent reads the ROOT plus only what arrived since. So it recalls what it knows without replaying its whole history. Two ideas drive it:

- **Hierarchical compaction** ([openclaw#51612](https://github.com/openclaw/openclaw/issues/51612)): summarize into an index, keep the raw beneath.
- **Log-structured merge** ([RocksDB compaction](https://github.com/facebook/rocksdb/wiki/Compaction)): when two memories conflict about the same thing, the newest supersedes the stale one. A changed preference or a reversed decision keeps only the current state.

The compaction prompt preserves every concrete fact and identifier, never invents, resolves conflicts newest-wins, and keeps anything it is unsure about. A fixture test confirms it: feed a light-to-dark roast preference flip and it keeps dark, preserves the account number verbatim, and drops the chit-chat.

### On-chain memory (optional)

```bash
export AGENT_PRIVATE_KEY=0x...        # a wallet you control, with a little Robinhood Chain gas
hero-agent chat --memory onchain --agent 7
```

Each memory gets AES-256-GCM encrypted with a key derived from your wallet's signature, gzip'd, and checkpointed to the Agent Memory contract on Robinhood Chain. On-chain, and to Hero Run, it reads as random bytes. Only your wallet decrypts it. Because the key comes from the wallet rather than the agent, any agent you own can read another's memory: one brain across many agents. Mint an agent at [herorunai.com/agent](https://herorunai.com/agent).

## Cost per task

```bash
hero-agent bench                 # runs a task suite, prints real cost/task vs other harnesses
hero-agent bench --model cheapest --tasks 5
```

The harness records the $HERO charged on every call (`x_hero.charged_hero`) and reports cost per task at the live token price. Two levers keep it low:

1. **Auto-routing.** Hero Run picks the cheapest capable model per call, including $0 free-served ones like DeepSeek V4 Flash, so easy steps skip frontier prices.
2. **Compaction.** The agent reads a constant-size ROOT index instead of its whole history, so tokens per turn stay flat as memory grows. On long runs this saves the most.

A measured run (light Q&A, `--model auto`, live prices):

| agent | $/task |
|---|---|
| **Hero Agent** | **~$0.0002** (measured) |
| Hermes Agent | $0.39 |
| Pi Agent | $0.40 |
| Codex | $0.47 |
| OpenCode | $0.51 |
| Kimi Code | $0.54 |
| Claude Code | $1.47 |

Read that number carefully. It is not like-for-like. The published figures come from coding-agent harnesses running heavy SWE-style tasks on frontier models; the sample above was light Q&A routed to cheap models. What the harness gives you is a way to measure cost per task and levers to lower it (cheap and free routing, plus compaction). For a fair comparison, run the same task suite with a frontier tier pinned.

## Tools

- **web_search**: live results, routed to Perplexity Sonar through Hero Run. No separate search key.
- **hero_generate**: an image or an audio clip from a prompt.
- **MCP**: point it at any [MCP](https://modelcontextprotocol.io) stdio server and its tools become the agent's tools.

## Use it as a library

```js
import { createHeroAgent } from "hero-agent";
const agent = await createHeroAgent({ apiKey: process.env.HERO_RUN_KEY });
const { text } = await agent.run("What did we decide about the Seattle location?");
```

`hero-harness` ships as its own export (`hero-agent/harness`) if you want the runtime with your own provider and memory.

## Skills

Put `SKILL.md` files in `./skills/` and the agent appends them to its system prompt, the way picoclaw loads skills.

## License

MIT.
