// Seal a durable run that MUST use a tool, onto a fresh burner agent, then hand it to the cloud.
import { createWalletClient, createPublicClient, http, defineChain, parseEther, encodeFunctionData, keccak256, toBytes } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { readFileSync } from "node:fs";
import { WorkerMemory } from "./memory.mjs";
import { buildDurableTask } from "./hero-mode-durable.mjs";

const RH = defineChain({ id: 4663, name: "RH", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } });
const MEM = "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";
const funderKey = readFileSync(process.env.HOME + "/.hero-agent/keys/0xD02Abfb9F9c0F9bBF2F43eEe608cA9aEC8d08edb.key", "utf8").trim();
const apiKey = readFileSync(process.env.HOME + "/.hero-agent/hero-run-key.txt", "utf8").trim();

const pub = createPublicClient({ chain: RH, transport: http() });
const funder = privateKeyToAccount(funderKey.startsWith("0x") ? funderKey : "0x" + funderKey);
const burnerKey = generatePrivateKey();
const burner = privateKeyToAccount(burnerKey);
const fw = createWalletClient({ account: funder, chain: RH, transport: http() });
const bw = createWalletClient({ account: burner, chain: RH, transport: http() });

console.log("burner:", burner.address);
console.log("1) funding burner with RH gas…");
const fundTx = await fw.sendTransaction({ to: burner.address, value: parseEther("0.00006") });
await pub.waitForTransactionReceipt({ hash: fundTx });
console.log("   funded", fundTx);

console.log("2) minting an agent to the burner…");
const mintSel = keccak256(toBytes("mint(string)")).slice(0, 10);
const label = "tooltest";
const enc = (s) => { const b = Buffer.from(s, "utf8"); return "0000000000000000000000000000000000000000000000000000000000000020" + b.length.toString(16).padStart(64, "0") + Buffer.concat([b, Buffer.alloc((32 - b.length % 32) % 32)]).toString("hex"); };
const mintTx = await bw.sendTransaction({ to: MEM, data: mintSel + enc(label) });
const rec = await pub.waitForTransactionReceipt({ hash: mintTx });
const ev = rec.logs.find((l) => l.address.toLowerCase() === MEM && l.topics.length === 3);
const agentId = parseInt(ev.topics[1], 16);
console.log("   agent #" + agentId, mintTx);

console.log("3) sealing a plan whose first step CANNOT be answered without a tool…");
const mem = new WorkerMemory({ agentId, privateKey: burnerKey });
const { task, entry } = buildDurableTask({
  runId: "hm-tool-" + Math.random().toString(36).slice(2, 6),
  agentId,
  task: "Report the current top story on Hacker News and why it matters.",
  model: "auto",
  maxTokens: 400,
  maxSteps: 2,
  plan: [
    "Use your tools to fetch news.ycombinator.com and report the EXACT title of the current number one story, plus its point count.",
    "In one sentence, say why that story matters to someone building AI agents.",
  ],
  // Keyless Firecrawl only: nothing secret is written on-chain.
  tools: [{ id: "fc", name: "Firecrawl", url: "https://mcp.firecrawl.dev/v2/mcp", allowed: ["firecrawl_scrape", "firecrawl_search"] }],
  createdAt: new Date().toISOString(),
});
console.log("   sealed tools:", JSON.stringify(task.tools));
const sealTx = await mem.append([entry]);
console.log("   plan on-chain", sealTx);

console.log("4) registering with the cloud worker…");
const r = await fetch("https://herorunai.com/api/heromode/register", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ agentId, sessionKey: burnerKey, apiKey, recipient: funder.address }),
});
console.log("   ", JSON.stringify(await r.json()));
console.log("\nAGENT=" + agentId);
console.log("BURNER=" + burner.address);
