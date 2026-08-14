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

## The `hero` terminal

The pretty front door: a full-screen terminal app (streaming chat, animated banner, slash-command
palette, model picker, markdown, per-turn $HERO cost and tok/s). First run walks you through
pasting a key (masked, saved 0600); after that it just opens.

```bash
node bin/hero.mjs        # or `hero` once the package is installed globally
```

Inside: `/model` picks a brain from the live catalog, `/balance` shows key + gas, `/agents` lists
your on-chain agents, `/remember` mints the conversation to the working agent's memory NFT,
`/recall` reads it back, and `/channel <id>` + `/send <id> <text>` speak the channels protocol
(public rooms and encrypted group rooms, membership auto-detected from your on-chain wrap).
`/stats` shows the session: turns, tokens, average speed with a sparkline, spend.

Rebuild after editing `src/tui/`: `npm run build:tui` (the built `dist/tui.mjs` is committed so
`hero` works from a fresh clone).

You need no OpenAI or Anthropic key and no model list. Memory defaults to a local JSONL file, so a fresh clone runs on any machine with Node 20.

## One command: `hero-run`

The whole point in a single line. Give it an agent and a mission; it does real work on your machine and writes what it did onto the agent, on-chain, live.

```bash
hero-run 31 "spin up a small HF model and report its exact tokens/sec"
```

That's it. `hero-run` finds the two keys for you so nobody has to remember flags:

- **brain key** (pays for the thinking): `$HERO_RUN_KEY`, else `~/.hero-agent/hero-run-key.txt`. Mint one at [herorunai.com/keys](https://herorunai.com/keys).
- **agent key** (signs the memory writes): whichever `~/.hero-agent/keys/*.key` actually owns that agent on-chain. It reads `ownerOf(<id>)` and matches.

Under the hood it runs `hero-agent run --shell --memory onchain --agent <id>`, so the agent can download and run a model, run tests, inspect files, and every run mints its own trace to the agent instead of vanishing to a local file. When it finishes it prints a link to view the run on the graph.

```bash
hero-run 31 "run the test suite and summarize failures"   # real shell work, logged on-chain
hero-run 31 "what changed in my memory this week?" --local # local memory, no chain, no gas
hero-run 31 "…" --no-shell                                 # think only, no local commands
hero-run 31 "…" --key-file ./agent.key --brain-key hr_live_…   # point at keys explicitly
```

> `--shell` lets the agent run commands on your machine, so only aim it at tasks you trust.

## Commands

```bash
hero-agent chat                       # interactive REPL that remembers and compacts as you go
hero-agent run "research X and summarize"
hero-agent remember "I prefer dark roasts"
hero-agent recall                     # print the ROOT index + memory stats
hero-agent compact                    # force a compaction now
hero-agent export --out mine.json     # dump full decrypted history (entries + jobs + ROOT)
hero-agent import mine.json           # load a bundle into this memory (fresh agent or after transfer)
hero-agent smoke                      # cheap end-to-end check: one task, cheapest model
hero-agent bench                      # measure cost per task on a light suite
hero-agent bench-code                 # coding benchmark: solve tasks in a sandbox, score pass rate + cost
hero-agent terminal-bench --dataset ./terminal-bench   # run against a Terminal-Bench checkout
hero-agent swe-bench --dataset lite.jsonl              # produce SWE-bench Lite patches to score
```

Flags: `--memory local|onchain` · `--file <path>` · `--agent <id>` · `--mcp "fs:npx -y @modelcontextprotocol/server-filesystem ."` · `--fff` ([fast file search](#fast-file-search-optional))

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

**Interoperable across surfaces.** This backend shares the exact contract, key derivation, blob format (byte 0 marker: 0 plaintext, 1 passphrase, 2 wallet-derived; then IV, then ciphertext), and payload envelope (`{v, at, entries}` inside the gzip; readers also accept the legacy bare-array shape) with the web app at herorunai.com/agent and the hosted MCP server. So memory written here is readable there, and by any MCP agent (Claude Code, Codex, Cursor) holding the same wallet, from one key. Write a memory in the CLI overnight, recall it on the website in the morning, or hand it to Claude Code.

**Own it, take it with you.** `hero-agent export` dumps an agent's full decrypted history, entries plus jobs plus the ROOT index, as one JSON bundle; `hero-agent import` loads it into another agent. Because the encryption key is derived from the owner's wallet, transferring the agent NFT alone does not hand over readable history: the new owner holds a different key. Export under the old wallet, import under the new one to move it with the transfer. The chain stores the ciphertext; export is how you get the plaintext back out.

## Cost per task

hero-agent instruments its own cost. Every model call records the $HERO charged (`x_hero.charged_hero`), and `bench` reports cost per task at the live token price, so you can compare configurations and track cost as you change the setup.

```bash
hero-agent bench
hero-agent bench --model cheapest --tasks 5
```

Two design choices move the number. Routing sizes each call to the step instead of pinning one model for everything. Compaction keeps the context the agent reads roughly flat as memory grows, so tokens per turn do not scale with history. How much each helps depends on the workload, which is why `bench` measures it rather than asserting it.

For context, published cost-per-task figures for other agent harnesses sit in a range of roughly $0.39 to $1.47. Those come from heavier coding benchmarks on frontier models, so read them as background, not a head-to-head. To get a number you can compare, run the coding benchmark below at a matching model tier.

## Delegate-wave: cut your Claude/Codex token usage

The pattern going around ("drop $20 on a provider, delegate everything cheap to a worker CLI") works
even better here, because one minted key replaces the provider account entirely and the router
already right-sizes each call.

1. Mint an API key at [herorunai.com/keys](https://herorunai.com/keys) — pay in $HERO, no signup,
   no per-provider accounts. That key funds every call below.
2. Copy [`integrations/delegate-wave/SKILL.md`](integrations/delegate-wave/SKILL.md) into your
   harness's skills directory (Claude Code: `.claude/skills/delegate-wave/SKILL.md`).
3. Add one line to `AGENTS.md` / `CLAUDE.md`: **"Always use delegate-wave: delegate read,
   discovery, and change work to the Hero Run worker; your role is to review and delegate."**
4. The worker is this repo's CLI:

```bash
export HERO_RUN_KEY=hr_live_...
hero-agent run "read src/ and summarize the auth flow" --model cheapest
hero-agent run "find every rpcCall call site, list file:line" --model deepseek/deepseek-v4-flash-0731
```

`--model cheapest` pins the cheapest trusted model, `auto` right-sizes per task, or use any of the
600+ catalog ids (`HERO_MODEL` env sets the default). Every call reports the exact $HERO charged, so
the savings are measured, not asserted — `hero-agent bench` gives you the per-task number. Your
frontier harness spends tokens only on review and decisions; the wave of reads, searches, and
mechanical edits runs on models that cost a fraction of a cent.

## Coding benchmark

`bench-code` scores the agent objectively: it solves a task in a sandbox, then a verifier runs (exit 0 means solved). Each run reports pass rate and cost per task.

```bash
hero-agent bench-code                     # built-in suite, local temp-dir sandbox
hero-agent bench-code --executor docker   # one container per task (real isolation)
```

The agent gets `shell`, `write_file`, and `read_file` tools inside a fresh sandbox per task. For the published comparison, run against [Terminal-Bench](https://www.tbench.ai) or SWE-bench with the Docker executor. See [docs/benchmarks.md](docs/benchmarks.md).

## Theorem proving

`prove` turns the same harness into a Lean 4 theorem prover. The agent runs in an [E2B](https://e2b.dev) cloud sandbox, drafts Lean 4 (or calls the Harmonic Aristotle prover), compiles it inside the sandbox, reads the compiler errors, and loops until Lean verifies clean with no `sorry`. The toolchain, proof files, and every compile stay in the sandbox; only the final `.lean` and a short trace come back.

```bash
export E2B_API_KEY=e2b_...          # get one at https://e2b.dev/dashboard
export ARISTOTLE_API_KEY=arstl_...  # optional: enables the aristotle_prove tool
hero-agent prove "the sum of two even integers is even"
hero-agent prove "..." --full-mathlib --timeout 1800   # fetch the Mathlib cache (slow, heavier proofs)
```

Success is objective: a clean `lake build` with zero errors and zero `sorry`. Lean installs at runtime by default (elan + a pinned toolchain, Lean `v4.15.0`); Mathlib is skipped unless you pass `--full-mathlib` because its build cache is large and slow. For faster repeated runs, build the prebuilt template in [templates/lean](templates/lean) and point at it with `E2B_TEMPLATE`. The sandbox uses the same `E2BExecutor` (`src/bench/e2b-executor.mjs`), which implements the same executor contract as the local and Docker backends, so `bench-code` can run against E2B too.

## Tools

- **web_search**: live results, routed to Perplexity Sonar through Hero Run. No separate search key.
- **hero_generate**: an image or an audio clip from a prompt.
- **aristotle_prove**: formalize a statement or fill `sorry`s into verified Lean 4 via Harmonic's Aristotle prover (used by `prove`).
- **MCP**: point it at any [MCP](https://modelcontextprotocol.io) stdio server and its tools become the agent's tools.

## Fast file search (optional)

[**fff**](https://github.com/dmtrKovalenko/fff) (MIT) is a Rust file-search server built for AI agents: a resident in-memory index that answers in single-digit milliseconds on huge repos, with SIMD fuzzy path matching, Smith-Waterman content scoring, and frecency ranking. It is **optional**. hero-agent has no native dependency: fff is attached at runtime through the existing MCP client, and core commands (`chat`, `run`, `prove`, `replay`, `bench`) work exactly the same whether or not it is installed.

Install the prebuilt `fff-mcp` binary (no npm or cargo needed):

```bash
curl -L https://dmtrkovalenko.dev/install-fff-mcp.sh | bash   # Linux/macOS, installs to ~/.local/bin
brew install dmtrKovalenko/fff/fff-mcp                          # or Homebrew
```

Then enable it with the convenience flag:

```bash
hero-agent chat --fff       # the agent gets fff's file-search tools
hero-agent run "where is the MCP client wired up?" --fff
```

`--fff` finds `fff-mcp` via `FFF_MCP_BIN`, then the common install dirs, then `PATH`. If it is not installed, hero-agent prints the install command and keeps running without file search, so the flag is always safe.

No code path is required: `--fff` is just sugar over MCP, so you can wire the same server by hand and it works on any hero-agent build:

```bash
hero-agent chat --mcp "fff:$(brew --prefix)/bin/fff-mcp"
hero-agent chat --mcp "fff:$HOME/.local/bin/fff-mcp"
```

Either way the agent gains three tools: `fff__find_files` (fuzzy filename search), `fff__grep` (content search), and `fff__multi_grep` (multi-pattern content search). The [search skill](skills/search/SEARCH.md) tells the agent to prefer these over shelling out to `grep`/`find` in a large repo. Because fff ships its own MCP server, the same install also benefits any Claude Code, Cursor, or Codex user (add `fff-mcp` to their MCP config), including alongside Hero Run's hosted MCP.

## One call, any harness

Run any coding harness with Hero Run as its brain. The SDK writes the harness's config if it's
missing (never touches an existing one), resolves your key (env → key file → wallet vault), and
hands off the task:

```bash
hero-agent harness ls                                # what's available on this machine
hero-agent harness dsh "fix the failing test"        # DeepSeek Harness, headless
hero-agent harness claude "add input validation"     # Claude Code
hero-agent harness opencode "write the migration"    # OpenCode
hero-agent harness grok "profile this function"      # Grok Build
```

`--model auto|cheapest|<any catalog id>` picks the brain. The harness does the agenting; Hero Run
does the thinking across 600+ models; the vault supplies the secrets. Verified live: dsh and Claude
Code both answered through this command, billed in $HERO, key loaded from the wallet vault.

## Secrets from your wallet, not .env files

Your agent's API keys, tokens, and connection strings can live in your Hero vault: AES-sealed under a
key derived from one wallet signature, stored server-side as ciphertext nobody can read. Your code
then loads them at runtime instead of from `.env` files scattered across machines and repos.

```js
import { loadHeroEnv } from "hero-agent/src/vault.mjs";
await loadHeroEnv();               // process.env now has your vault's variables
```

Or run anything with the vault injected, nothing written to disk:

```bash
hero-agent vault run -- node bot.mjs
```

Setup is one command. Two ways, depending on where the machine sits:

```bash
# On a machine you trust with a key file (used once, then not needed for secrets):
hero-agent vault login --key-file ~/.hero-agent/my.key

# On a server/CI box that should NEVER see your private key:
#   herorunai.com/locker → Environment → "Connect a machine" → copy the token
hero-agent vault login --token hvt1.0xYourAddr.0x…
```

Manage values from the CLI (`vault set NAME=value`, `ls`, `get`, `rm`, `env`) or the web UI at
[herorunai.com/locker](https://herorunai.com/locker), same vault either way.

The property that matters: the machine token can decrypt the vault, and that is all it can do. It
cannot sign transactions, spend, or mint. A compromised box leaks secrets you can rotate, never the
wallet you cannot. Every pull lands in the access log on /locker, so "what read my secrets, when"
has an answer.

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
