// One-shot: stand up a real durable-TWAP demo the Cloudflare worker will execute.
//   node setup-durable-demo.mjs
// Funds the cron burner with RH gas+spend from the bridge wallet (0x33c8), mints the burner's own
// memory agent, seals a tiny 2-chunk rh-eth TWAP plan into it, and points wrangler.jsonc at that
// agent. After this: put the burner key in the worker secret and `npm run deploy`.
import { createWalletClient, createPublicClient, http, formatEther, parseEther, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const BURNER_ADDR = "0x66e07BDa43afEc9360A1c4B1CFd5D61564F50ceA";
const BURNER_KEYFILE = `${homedir()}/.hero-agent/keys/${BURNER_ADDR}.key`;
const RECIPIENT = "0x00dD6F77f995235588A6277e4BAC763e24F7f749"; // your main wallet — where bought HERO lands, holds >1M HERO so the stake gate passes
const MEM = "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const HERO_RH = "0xbA221e393645901C962Ad21E4e7FA097d550B67c";
const FUND_WEI = parseEther("0.00014"); // 2×0.00002 ETH spend + gas for mint/checkpoints/swaps + cushion

const rhChain = { id: 4663, name: "RH", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const pub = createPublicClient({ chain: rhChain, transport: http(rhChain.rpcUrls.default.http[0]) });

// funder = the bridge wallet 0x33c8 (PRIVATE_KEY in hero-bridge/.env)
const benv = Object.fromEntries(readFileSync(`${homedir()}/Desktop/hero-bridge/.env`, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
let funderPk = benv.PRIVATE_KEY; if (!funderPk.startsWith("0x")) funderPk = "0x" + funderPk;
const funder = privateKeyToAccount(funderPk);
const funderWc = createWalletClient({ account: funder, chain: rhChain, transport: http(rhChain.rpcUrls.default.http[0]) });

let burnerPk = readFileSync(BURNER_KEYFILE, "utf8").trim(); if (!burnerPk.startsWith("0x")) burnerPk = "0x" + burnerPk;
const burner = privateKeyToAccount(burnerPk);
const burnerWc = createWalletClient({ account: burner, chain: rhChain, transport: http(rhChain.rpcUrls.default.http[0]) });

// 1) fund the burner
const have = await pub.getBalance({ address: burner.address });
if (have < FUND_WEI) {
  console.log(`funding burner ${burner.address} with ${formatEther(FUND_WEI - have)} RH ETH from ${funder.address}…`);
  const fh = await funderWc.sendTransaction({ to: burner.address, value: FUND_WEI - have });
  await pub.waitForTransactionReceipt({ hash: fh });
  console.log("  ✓ funded:", fh);
} else console.log("burner already funded:", formatEther(have), "ETH");

// 2) mint the burner's own memory agent
console.log("minting the burner's cron agent…");
const mintTx = await burnerWc.writeContract({ address: MEM, abi: [{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "uint256" }] }], functionName: "mint", args: ["cloud-twap-demo"] });
const rec = await pub.waitForTransactionReceipt({ hash: mintTx });
const ev = rec.logs.find((l) => l.address.toLowerCase() === MEM && l.topics.length === 3);
const agentId = parseInt(ev.topics[1], 16);
console.log(`  ✓ minted agent #${agentId} (owned by the burner)`);

// 3) seal a tiny 2-chunk rh-eth TWAP plan into the agent (encrypted, burner-keyed)
const { OnchainMemory } = await import(pathToFileURL(`${homedir()}/Desktop/hero-agent/src/memory/onchain.mjs`));
const mem = new OnchainMemory({ agentId, privateKey: burnerPk });
const now = Date.now();
const plan = {
  planId: "twap-cloud-" + Math.random().toString(36).slice(2, 6),
  route: "rh-eth", tokenOut: HERO_RH, recipient: RECIPIENT, fee: 10000, slippageBps: 2000, holdMin: 1000000,
  enabled: true, createdAt: new Date(now).toISOString(),
  chunks: [
    { amountIn: parseEther("0.00002").toString(), notBefore: new Date(now + 60_000).toISOString() },
    { amountIn: parseEther("0.00002").toString(), notBefore: new Date(now + 6 * 60_000).toISOString() },
  ],
};
await mem.append([{ role: "system", text: "twap::" + JSON.stringify(plan) }]);
console.log(`  ✓ sealed plan ${plan.planId}: 2 × 0.00002 ETH → HERO to ${RECIPIENT.slice(0, 8)}… (chunk1 +1min, chunk2 +6min)`);

// 4) point the worker at this agent
const wp = `${homedir()}/Desktop/hero-agent/worker/wrangler.jsonc`;
const wj = readFileSync(wp, "utf8").replace(/("AGENT_IDS":\s*)"[^"]*"/, `$1"${agentId}"`);
writeFileSync(wp, wj);
console.log(`  ✓ wrangler.jsonc AGENT_IDS = "${agentId}"`);

console.log(`\nDONE. Now deploy the worker:`);
console.log(`  npx wrangler secret put AGENT_PRIVATE_KEY < ${BURNER_KEYFILE}`);
console.log(`  npx wrangler secret put RUN_SECRET     # paste any random string`);
console.log(`  npm run deploy`);
console.log(`AGENT_ID=${agentId}`);
