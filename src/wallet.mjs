// Burner-wallet helpers so a private key is never pasted into a terminal, chat, or env.
// `generateBurner` writes a fresh key to a chmod-600 file and returns only the public address.
// `mintCronAgent` reads that file and mints a dedicated agent NFT for the jobs cron. `readKeyFile`
// lets the other commands load the key from the file (via --key-file) instead of AGENT_PRIVATE_KEY.
//
// The key is NEVER returned to callers, printed to stdout, or logged — only its address is.
import { createWalletClient, createPublicClient, http, defineChain, encodeFunctionData, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MEM_ADDR = process.env.HERO_MEM_ADDR || "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const rhChain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } });
const MINT_ABI = [{ name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }], outputs: [] }];
const T_MINTED = keccak256(toBytes("AgentMinted(uint256,address,string)"));

export function readKeyFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  const pk = raw.startsWith("0x") ? raw : "0x" + raw;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`key file ${path} does not contain a 32-byte hex private key`);
  return pk;
}

// Generate a fresh burner, write the key to a 0600 file, return ONLY {address, path}.
export function generateBurner({ outPath } = {}) {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  const dir = join(homedir(), ".hero-agent", "keys");
  const path = outPath || join(dir, `${address}.key`);
  if (!outPath) mkdirSync(dir, { recursive: true });
  writeFileSync(path, pk, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  return { address, path };
}

async function ownedAgentIds(pub, address) {
  const ownerTopic = "0x" + address.slice(2).toLowerCase().padStart(64, "0");
  const logs = await pub.request({ method: "eth_getLogs", params: [{ address: MEM_ADDR, topics: [T_MINTED, null, ownerTopic], fromBlock: "0x0", toBlock: "latest" }] }).catch(() => []);
  return logs.map((l) => Number(BigInt(l.topics[1])));
}

// Mint a dedicated cron agent from the burner. Reads the key from the file (never an arg/env/chat).
export async function mintCronAgent({ keyFile, label = "cron" }) {
  const account = privateKeyToAccount(readKeyFile(keyFile));
  const wallet = createWalletClient({ account, chain: rhChain, transport: http(RH_RPC) });
  const pub = createPublicClient({ chain: rhChain, transport: http(RH_RPC) });
  const before = await ownedAgentIds(pub, account.address);
  const tx = await wallet.sendTransaction({ to: MEM_ADDR, data: encodeFunctionData({ abi: MINT_ABI, functionName: "mint", args: [label] }) });
  await pub.waitForTransactionReceipt({ hash: tx });
  const after = await ownedAgentIds(pub, account.address);
  const created = after.find((id) => !before.includes(id)) ?? (after.length ? Math.max(...after) : null);
  return { address: account.address, agentId: created, tx };
}
