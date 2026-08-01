#!/usr/bin/env node
// hero-agent CLI. Requires HERO_RUN_KEY (mint at https://herorunai.com/keys).
//   hero-agent chat                 interactive REPL (remembers across sessions, compacts on-chain/disk)
//   hero-agent run "task"           one-shot task, prints the answer
//   hero-agent remember "fact"      write a memory without a chat turn
//   hero-agent recall               print the ROOT index + memory stats
//   hero-agent compact              force a compaction now
// Flags: --memory local|onchain  --file <path>  --agent <id>  --mcp <name:command>
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createHeroAgent } from "../src/agent.mjs";
import { LocalMemory } from "../src/memory/local.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "chat";
const flag = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const rest = argv.slice(1).filter((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);

async function makeMemory() {
  const kind = flag("memory", "local");
  if (kind === "onchain") {
    const { OnchainMemory } = await import("../src/memory/onchain.mjs");
    return new OnchainMemory({ agentId: flag("agent") });
  }
  return new LocalMemory({ file: flag("file", join(homedir(), ".hero-agent", "memory", "default.jsonl")) });
}
function mcpFromFlags() {
  const spec = flag("mcp");           // e.g. --mcp "fs:npx -y @modelcontextprotocol/server-filesystem ."
  if (!spec) return [];
  const [name, ...cmd] = spec.replace(/^[^:]+:/, (m) => m).split(":");
  const parts = spec.split(":"); const nm = parts.shift(); const c = parts.join(":").trim().split(/\s+/);
  return [{ name: nm, command: c[0], args: c.slice(1) }];
}

const onEvent = (type, data) => {
  if (type === "tool") process.stderr.write(`  · ${data.name}(${JSON.stringify(data.args).slice(0, 80)})\n`);
  if (type === "compact") process.stderr.write(`  · compacting ${data.entries} memories → ROOT\n`);
};

async function main() {
  if (!process.env.HERO_RUN_KEY) { console.error("Set HERO_RUN_KEY (mint at https://herorunai.com/keys)."); process.exit(1); }
  const memory = await makeMemory();
  const agent = await createHeroAgent({ memory, mcpServers: mcpFromFlags(), onEvent });
  console.error(`hero-agent · brain: Hero Run (auto) · memory: ${memory.label()}\n`);

  if (cmd === "recall") {
    const root = await memory.getRoot(); const raw = await memory.raw(); const since = await memory.sinceRoot();
    console.log(root?.text || "(no ROOT index yet)");
    console.error(`\n${raw.length} memories · ${since.length} since last ROOT · compacts every ${agent.compactEvery}`);
    return;
  }
  if (cmd === "compact") { const r = await agent.compact(); console.log(r ? "✓ compacted → new ROOT:\n\n" + r : "nothing new to compact"); return; }
  if (cmd === "remember") { await memory.append([{ role: "user", text: rest.join(" ") }]); console.log("✓ remembered"); return; }
  if (cmd === "run") { const { text, media } = await agent.run(rest.join(" ")); console.log(text); media.forEach((m) => console.log(`[${m.kind}] ${m.url}`)); return; }

  // chat REPL
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you › " });
  console.log("Hero Agent ready. Type a message (Ctrl+C to exit).\n"); rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim(); if (!text) return rl.prompt();
    try { const { text: reply, media } = await agent.run(text); console.log("\nagent › " + reply + "\n"); media.forEach((m) => console.log(`  [${m.kind}] ${m.url}`)); }
    catch (e) { console.error("error: " + e.message); }
    rl.prompt();
  }).on("close", () => process.exit(0));
}
main().catch((e) => { console.error(e); process.exit(1); });
