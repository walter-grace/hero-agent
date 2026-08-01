// hero-agent: a Harness wired to Hero Run's brain, a memory backend, and the built-in + MCP tools.
// This is the "agent" (persona + capabilities); the Harness is "what controls it".
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { Harness } from "./harness.mjs";
import { heroRun } from "./provider.mjs";
import { LocalMemory } from "./memory/local.mjs";
import { builtinTools } from "./tools/index.mjs";
import { mcpTools } from "./tools/mcp.mjs";

const DEFAULT_SYSTEM =
  "You are a Hero Agent: a personal AI whose brain runs on Hero Run and whose memory lives in a " +
  "wallet-owned, compacting store. Below (if present) is your ROOT memory index, the current merged " +
  "state of everything you know, plus your recent raw memories. Treat them as your own past. Use " +
  "tools when you need live information or to make something. Be concise, accurate, and natural.";

// Load skills: any SKILL.md files under ./skills are appended to the system prompt (picoclaw idea).
function loadSkills(dir) {
  if (!dir || !existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  if (!files.length) return "";
  return "\n\n=== SKILLS ===\n" + files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n\n");
}

export async function createHeroAgent({
  apiKey = process.env.HERO_RUN_KEY,
  memory,                                   // a LocalMemory/OnchainMemory instance, or omit for default
  memoryFile = join(homedir(), ".hero-agent", "memory", "default.jsonl"),
  system = DEFAULT_SYSTEM,
  skillsDir = "skills",
  mcpServers = [],
  compactEvery = Number(process.env.HERO_AGENT_COMPACT_EVERY || 24),
  onEvent,
} = {}) {
  const provider = heroRun({ apiKey });
  const mem = memory || new LocalMemory({ file: memoryFile });
  const tools = [...builtinTools(provider), ...(mcpServers.length ? await mcpTools(mcpServers) : [])];
  const harness = new Harness({ provider, memory: mem, tools, system: system + loadSkills(skillsDir), compactEvery, onEvent });
  return harness;
}
