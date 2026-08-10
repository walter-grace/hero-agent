#!/usr/bin/env node
// hero-run — the one-liner for a memory-logging agent run. Made for demos and for anyone who just
// wants to say "run this, and log what you did onto the agent" without knowing the flag plumbing.
//
//   hero-run <agentId> "<mission>"
//
// It does what `hero-agent run --shell --memory onchain --agent <id> --key-file <…>` does, but it
// finds the two keys for you:
//   • the brain key   → $HERO_RUN_KEY, else ~/.hero-agent/hero-run-key.txt
//   • the agent key   → whichever ~/.hero-agent/keys/*.key actually owns <agentId> on-chain
// so the run works on the machine (--shell) AND mints its own trace to the agent, live.
//
// Flags:  --local (local memory, no chain)   --no-shell (no local commands)   --key-file <path>
//         --brain-key <hr_live_…>            --agent already positional; extra --flags pass through.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, defineChain, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readKeyFile } from "../src/wallet.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const KEYS_DIR = join(HOME, ".hero-agent", "keys");
const RUN_KEY_FILE = join(HOME, ".hero-agent", "hero-run-key.txt");
const MEM_ADDR = process.env.HERO_MEM_ADDR || "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";

const die = (msg) => { console.error("hero-run: " + msg); process.exit(1); };

// --- parse: first non-flag is the agent id, the rest of the non-flags are the mission -------------
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(`--${name}`);
if (!argv.length || has("help") || has("h")) {
  console.log('Usage: hero-run <agentId> "<mission>"   [--local] [--no-shell] [--key-file <path>] [--brain-key <hr_live_…>]');
  console.log('Example: hero-run 31 "spin up a small HF model and report its exact tokens/sec"');
  process.exit(argv.length ? 0 : 1);
}
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) { if (["local", "no-shell", "help", "h"].includes(a.slice(2))) continue; i++; continue; } // skip flag (+value)
  positionals.push(a);
}
const agentId = positionals[0];
const mission = positionals.slice(1).join(" ").trim();
if (!/^\d+$/.test(agentId || "")) die('first argument must be the numeric agent id. e.g. hero-run 31 "…"');
if (!mission) die('give a mission in quotes. e.g. hero-run ' + agentId + ' "spin up a model and report tok/s"');

const onchain = !has("local");

// --- brain key (pays for the thinking) ------------------------------------------------------------
let brainKey = flag("brain-key") || process.env.HERO_RUN_KEY;
if (!brainKey && existsSync(RUN_KEY_FILE)) brainKey = readFileSync(RUN_KEY_FILE, "utf8").trim();
if (!brainKey) die(`no brain key. Set HERO_RUN_KEY, pass --brain-key, or drop it in ${RUN_KEY_FILE}. Mint one at https://herorunai.com/keys`);

// --- agent signing key: the local key file whose address OWNS this agent ---------------------------
async function resolveKeyFile() {
  if (!onchain) return null;                       // local memory needs no wallet
  const explicit = flag("key-file");
  if (explicit) return explicit;
  if (!existsSync(KEYS_DIR)) die(`onchain memory needs the agent's key. No ${KEYS_DIR}. Pass --key-file <path> or run --local.`);
  const files = readdirSync(KEYS_DIR).filter((f) => f.endsWith(".key"));
  if (!files.length) die(`no key files in ${KEYS_DIR}. Pass --key-file <path> or run --local.`);
  // Map each local key to its address, then ask the contract who owns this agent and match.
  const byAddr = {};
  for (const f of files) {
    try { byAddr[privateKeyToAccount(readKeyFile(join(KEYS_DIR, f))).address.toLowerCase()] = f; } catch {}
  }
  const rh = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } });
  const pub = createPublicClient({ chain: rh, transport: http(RH_RPC) });
  let owner;
  try {
    owner = await pub.readContract({ address: MEM_ADDR, functionName: "ownerOf", args: [BigInt(agentId)],
      abi: [{ name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "address" }] }] });
  } catch (e) { die(`could not read owner of agent #${agentId} from the chain (${e.shortMessage || e.message}).`); }
  const match = byAddr[owner.toLowerCase()];
  if (!match) die(`agent #${agentId} is owned by ${owner}, but no key file in ${KEYS_DIR} matches it. Add that wallet's key or run --local.`);
  return join(KEYS_DIR, match);
}

const keyFile = await resolveKeyFile();

// --- run it through the real CLI so there's one code path -----------------------------------------
const cli = join(HERE, "hero-agent.mjs");
const args = ["run", mission];
if (!has("no-shell")) args.push("--shell");
if (onchain) args.push("--memory", "onchain", "--agent", agentId, "--key-file", keyFile);
else args.push("--memory", "local");

console.error("");
console.error(`  hero-run · agent #${agentId} · memory: ${onchain ? "on-chain (logs this run live)" : "local"}${has("no-shell") ? "" : " · shell ON"}`);
console.error(`  mission: ${mission}`);
if (onchain) console.error(`  signing key: ${keyFile.replace(HOME, "~")}`);
console.error("");

const child = spawn(process.execPath, [cli, ...args], { stdio: "inherit", env: { ...process.env, HERO_RUN_KEY: brainKey } });
child.on("exit", (code) => {
  if (onchain && code === 0) console.error(`\n  ✓ logged to agent #${agentId}. View it: https://herorunai.com/memory-graph`);
  process.exit(code ?? 0);
});
