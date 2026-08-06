// Play #2 (starter): give Prime Agent's Continual Harness ON-CHAIN, wallet-owned memory.
//
// Prime Agent's durable state (supplemental prompts, memories, skill descriptions, subagent specs)
// lives in local files under a state dir. That state is not portable, not verifiable, and not
// resumable on another machine. This bridge checkpoints it onto the Hero Run agent-memory contract on
// Robinhood Chain (encrypted, hash-linked, wallet-owned), so the same wallet can resume the harness
// anywhere and prove what it knew and when.
//
//   PRIVATE_KEY=0x...  node hero-memory-bridge.mjs push   # local Continual Harness -> on-chain
//   PRIVATE_KEY=0x...  node hero-memory-bridge.mjs pull   # on-chain -> local (resume elsewhere)
//   PRIVATE_KEY=0x...  node hero-memory-bridge.mjs recall # dump the on-chain timeline
//
// It uses the open-source agent-memory library (github.com/walter-grace/agent-memory). Install it, or
// vendor node/onchain.mjs + node/compaction.mjs next to this file.
//
// STATUS: v0. The one thing to confirm per prime-agent version is the state directory + which files
// are the durable harness state (STATE_DIR / STATE_GLOBS below). Everything else is wired.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

// --- config -------------------------------------------------------------------------------------
// Prime Agent keeps Continual Harness state under ~/.prime (confirmed: its prime-inference config is
// ~/.prime/config.json). Point this at the harness state dir; adjust per prime-agent version.
const STATE_DIR = process.env.PRIME_STATE_DIR || join(homedir(), ".prime");
const AGENT_LABEL = process.env.PRIME_AGENT_LABEL || "prime-agent-harness";
// Only sync the durable harness artifacts, not caches/logs. Tune to the actual layout.
const INCLUDE = [/\.md$/, /\.json$/, /skills?\//i, /memor/i, /supplemental/i, /subagent/i];
const EXCLUDE = [/node_modules/, /\.log$/, /cache/i, /tmp/i];

// --- agent-memory SDK (open-source) -------------------------------------------------------------
// Expects the unified agent-memory repo's node/ modules. If you vendored them, fix these paths.
let mem;
try { mem = await import("agent-memory/node/onchain"); }
catch {
  try { mem = await import(new URL("./agent-memory/node/onchain.mjs", import.meta.url).href); }
  catch { console.error("Missing agent-memory. `npm i github:walter-grace/agent-memory` or vendor node/onchain.mjs here."); process.exit(1); }
}
const { OnchainMemory, mintAgent } = mem;

const pk = (() => { let k = process.env.PRIVATE_KEY; if (!k) { console.error("Set PRIVATE_KEY (a funded Robinhood Chain wallet)."); process.exit(1); } return k.startsWith("0x") ? k : "0x" + k; })();

// Collect the durable harness files into one snapshot object { path: contents }.
function snapshot() {
  const out = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (EXCLUDE.some((re) => re.test(p))) continue;
      const s = statSync(p);
      if (s.isDirectory()) { walk(p); continue; }
      const rel = relative(STATE_DIR, p);
      if (!INCLUDE.some((re) => re.test(rel))) continue;
      if (s.size > 200_000) continue; // skip oversized blobs; attach separately if needed
      out[rel] = readFileSync(p, "utf8");
    }
  };
  try { walk(STATE_DIR); } catch (e) { console.error("Cannot read state dir", STATE_DIR, e.message); process.exit(1); }
  return out;
}

const cmd = process.argv[2] || "push";

if (cmd === "push") {
  const snap = snapshot();
  const files = Object.keys(snap);
  if (!files.length) { console.error(`No harness state found under ${STATE_DIR}. Set PRIME_STATE_DIR / tune INCLUDE.`); process.exit(1); }
  const agentId = process.env.PRIME_AGENT_ID ? BigInt(process.env.PRIME_AGENT_ID) : await mintAgent(pk, AGENT_LABEL);
  const m = new OnchainMemory({ agentId, privateKey: pk });
  // One checkpoint = one durable snapshot of the harness, encrypted to the wallet.
  await m.checkpoint({ role: "harness", text: JSON.stringify({ at: new Date().toISOString(), files: snap }) });
  console.log(`✓ pushed ${files.length} harness file(s) on-chain to agent #${agentId}. Set PRIME_AGENT_ID=${agentId} to keep appending to it.`);
} else if (cmd === "pull") {
  const agentId = BigInt(process.env.PRIME_AGENT_ID || (() => { console.error("Set PRIME_AGENT_ID to the on-chain agent to restore from."); process.exit(1); })());
  const m = new OnchainMemory({ agentId, privateKey: pk });
  const timeline = await m.recall();
  const last = [...(timeline.entries || [])].reverse().find((e) => e.role === "harness");
  if (!last) { console.error("No harness snapshot found on-chain for that agent."); process.exit(1); }
  const { files } = JSON.parse(last.text);
  for (const [rel, contents] of Object.entries(files)) {
    const dest = join(STATE_DIR, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, contents);
  }
  console.log(`✓ restored ${Object.keys(files).length} harness file(s) into ${STATE_DIR}`);
} else if (cmd === "recall") {
  const agentId = BigInt(process.env.PRIME_AGENT_ID || (() => { console.error("Set PRIME_AGENT_ID."); process.exit(1); })());
  const m = new OnchainMemory({ agentId, privateKey: pk });
  const t = await m.recall();
  console.log(JSON.stringify(t, null, 2));
} else {
  console.error("usage: node hero-memory-bridge.mjs [push|pull|recall]");
  process.exit(1);
}
