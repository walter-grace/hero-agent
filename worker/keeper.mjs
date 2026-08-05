// Backstop keeper for the on-chain HeroTwapKeeper (tier 3). The contract is permissionless — anyone
// can call executeDueChunk for a reward — but we run this as a GUARANTEED keeper so plans always get
// executed even if no third-party bot shows up. It iterates the contract's plans, and for each due
// one, quotes the swap and calls executeDueChunk(id, quotedOut). Earns the keeper reward (in the
// plan's input token) minus gas. Enabled only when KEEPER_ADDRESS is set on the worker.
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RH_CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"; // RH QuoterV2
const QUOTER_ABI = [{ name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable", inputs: [{ name: "p", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] }];
const KEEPER_ABI = parseAbi([
  "function nextPlanId() view returns (uint256)",
  "function dueNow(uint256) view returns (bool)",
  "function plans(uint256) view returns (address owner, address tokenIn, address tokenOut, uint24 fee, uint128 chunkIn, uint32 chunks, uint32 filled, uint32 intervalSecs, uint64 nextRunAt, uint16 slippageBps, uint128 minChunkOut, uint128 keeperReward, bool active)",
  "function executeDueChunk(uint256 id, uint256 quotedOut)",
]);

export async function pollKeeper(env, { log = () => {} } = {}) {
  if (!env.KEEPER_ADDRESS || !env.AGENT_PRIVATE_KEY) return { checked: 0, executed: 0 };
  const rpc = env.RH_RPC || RH_CHAIN.rpcUrls.default.http[0];
  const pub = createPublicClient({ chain: RH_CHAIN, transport: http(rpc, { retryCount: 8, retryDelay: 2000 }) });
  const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY);
  const wc = createWalletClient({ account, chain: RH_CHAIN, transport: http(rpc, { retryCount: 8, retryDelay: 2000 }) });
  const KEEPER = env.KEEPER_ADDRESS;

  const nextId = await pub.readContract({ address: KEEPER, abi: KEEPER_ABI, functionName: "nextPlanId" }).catch(() => 0n);
  let checked = 0, executed = 0;
  for (let id = 1n; id < nextId; id++) {
    let due = false;
    try { due = await pub.readContract({ address: KEEPER, abi: KEEPER_ABI, functionName: "dueNow", args: [id] }); } catch {}
    if (!due) continue;
    checked++;
    try {
      const p = await pub.readContract({ address: KEEPER, abi: KEEPER_ABI, functionName: "plans", args: [id] });
      const [, tokenIn, tokenOut, fee, chunkIn] = p;
      // fresh quote for this chunk (staticcall the QuoterV2)
      const { result } = await pub.simulateContract({ account: account.address, address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn: chunkIn, fee, sqrtPriceLimitX96: 0n }] });
      const quotedOut = result[0];
      const tx = await wc.writeContract({ address: KEEPER, abi: KEEPER_ABI, functionName: "executeDueChunk", args: [id, quotedOut] });
      await pub.waitForTransactionReceipt({ hash: tx });
      executed++;
      log(`keeper: executed plan ${id} chunk → ${tx}`);
    } catch (e) { log(`keeper: plan ${id} skipped: ${String(e.shortMessage || e.message).slice(0, 80)}`); }
  }
  return { checked, executed };
}
