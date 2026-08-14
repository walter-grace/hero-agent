// Gasless transactions: gas paid in $HERO through the HeroPaymaster (ERC-4337).
//
// SHIPPED AND LIVE:
//   - HeroPaymaster on RH mainnet (v0.7 EntryPoint): quotes + charges gas in $HERO atomically.
//   - Alchemy's RH endpoint is a full bundler (eth_supportedEntryPoints lists v0.6/v0.7/v0.8).
//   - This module: paymaster status/quotes, UserOperation assembly, bundler submission.
//
// THE HONEST BOUNDARY (why --gasless is staged, not finished):
//   A plain EOA can only BE the userop sender via EIP-7702 delegation, which the v0.8 EntryPoint
//   supports (eip7702Auth). Our paymaster binds to v0.7 at construction, so full EOA-gasless needs
//   either a redeploy against v0.8 plus a Simple7702Account delegate, or a pre-deployed v0.7 smart
//   account per user (which breaks AgentMemory's EOA-based write auth). Until the v0.8 alignment
//   lands, this module serves quotes and submits ops for accounts that already validate, and fails
//   with a REAL explanation instead of a fake success.
import { keccak256, toBytes, encodeAbiParameters, hexToBigInt } from "viem";

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const BUNDLER = process.env.RH_BUNDLER_RPC || "";       // e.g. Alchemy robinhood-mainnet URL
const BUNDLER_ORIGIN = process.env.RH_BUNDLER_ORIGIN || "https://herorunai.com"; // key allowlists origins
export const PAYMASTER = process.env.HERO_PAYMASTER || "0x6a294e35df76aaf5f230a63086cdfd7d26afc315";
export const ENTRYPOINT_07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function rpc(url, method, params, origin) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const chainCall = (to, data) => rpc(RPC, "eth_call", [{ to, data }, "latest"]);
const sel = (sig) => keccak256(toBytes(sig)).slice(0, 10);

// ---- paymaster reads (work today, no bundler needed) ----

export async function paymasterStatus() {
  const [rate, markup, deposit] = await Promise.all([
    chainCall(PAYMASTER, sel("heroPerEth()")).then(hexToBigInt),
    chainCall(PAYMASTER, sel("markupBps()")).then(hexToBigInt),
    rpc(RPC, "eth_call", [{ to: ENTRYPOINT_07, data: "0x70a08231" + PAYMASTER.slice(2).toLowerCase().padStart(64, "0") }, "latest"]).then(hexToBigInt),
  ]);
  return { paymaster: PAYMASTER, heroPerEth: rate, markupBps: Number(markup), entryPointDepositEth: Number(deposit) / 1e18 };
}

// What would this much gas cost in $HERO?
export async function quoteGasInHero(ethCostWei) {
  const q = await chainCall(PAYMASTER, sel("quote(uint256)") + BigInt(ethCostWei).toString(16).padStart(64, "0"));
  return hexToBigInt(q);
}

// ---- userop assembly + bundler submission (v0.7 packed format) ----

export function packUserOp({ sender, nonce = 0n, callData = "0x", callGasLimit = 400000n, verificationGasLimit = 400000n, preVerificationGas = 100000n, maxFeePerGas = 100000000n, maxPriorityFeePerGas = 0n, paymasterVerificationGasLimit = 100000n, paymasterPostOpGasLimit = 150000n, signature = "0x" }) {
  const pack2 = (a, b) => "0x" + a.toString(16).padStart(32, "0") + b.toString(16).padStart(32, "0");
  return {
    sender,
    nonce: "0x" + nonce.toString(16),
    callData,
    callGasLimit: "0x" + callGasLimit.toString(16),
    verificationGasLimit: "0x" + verificationGasLimit.toString(16),
    preVerificationGas: "0x" + preVerificationGas.toString(16),
    maxFeePerGas: "0x" + maxFeePerGas.toString(16),
    maxPriorityFeePerGas: "0x" + maxPriorityFeePerGas.toString(16),
    // v0.7 wire format: paymaster fields split out; bundler repacks paymasterAndData
    paymaster: PAYMASTER,
    paymasterVerificationGasLimit: "0x" + paymasterVerificationGasLimit.toString(16),
    paymasterPostOpGasLimit: "0x" + paymasterPostOpGasLimit.toString(16),
    paymasterData: "0x",
    signature,
  };
}

function needBundler() {
  if (!BUNDLER) throw new Error("Set RH_BUNDLER_RPC (an Alchemy robinhood-mainnet URL; the key's origin allowlist applies, RH_BUNDLER_ORIGIN overrides).");
}

export async function bundlerSupportedEntryPoints() {
  needBundler();
  return rpc(BUNDLER, "eth_supportedEntryPoints", [], BUNDLER_ORIGIN);
}

export async function estimateUserOpGas(userOp) {
  needBundler();
  return rpc(BUNDLER, "eth_estimateUserOperationGas", [userOp, ENTRYPOINT_07], BUNDLER_ORIGIN);
}

export async function sendUserOp(userOp) {
  needBundler();
  return rpc(BUNDLER, "eth_sendUserOperation", [userOp, ENTRYPOINT_07], BUNDLER_ORIGIN);
}
