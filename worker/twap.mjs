// Durable TWAP executor: continues an AI buy plan from on-chain memory after the tab is gone.
//
// The /twap page's auto mode runs a plan from an in-browser session wallet and dies with the tab.
// Durable mode hands the SAME burner pattern to your own worker: the plan is checkpointed into an
// agent's encrypted memory (`twap::` entry), the session wallet's key goes into YOUR Cloudflare
// worker as a secret, and every cron tick executes the next due chunk and checkpoints the result
// back (`twaprun::`). Close the laptop; the buys keep landing in your main wallet.
//
// EXPERIMENTAL and deliberately conservative: Base USDC→token via KyberSwap only, ONE chunk per
// tick per agent (pacing), every result on-chain, and it stops the moment a chunk errors twice.
// Test with tiny amounts first. The session wallet should only ever hold this run's funds.
import { createWalletClient, createPublicClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// Robinhood Chain execution: Uniswap is the chain's primary public AMM (v2/v3/v4 + UniswapX are
// live, chain id 4663) — we swap through the same SwapRouter02/QuoterV2 the /twap page uses,
// against our own HERO/WETH 1% pool. Native ETH in, router wraps, no approvals needed.
const RH_CHAIN = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } } };
const RH_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2"; // SwapRouter02
const RH_QUOTER = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7"; // QuoterV2
const RH_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const RH_QUOTER_ABI = [{ name: "quoteExactInputSingle", type: "function", stateMutability: "nonpayable", inputs: [{ name: "p", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }] }];
const RH_ROUTER_ABI = [{ name: "exactInputSingle", type: "function", stateMutability: "payable", inputs: [{ name: "p", type: "tuple", components: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "fee", type: "uint24" }, { name: "recipient", type: "address" }, { name: "amountIn", type: "uint256" }, { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" }] }], outputs: [{ type: "uint256" }] }];

export const TWAP_MARK = "twap::";
export const TWAPRUN_MARK = "twaprun::";
export const TWAPCLAIM_MARK = "twapclaim::"; // pre-execution lease: written BEFORE a swap, verified readable
const CLAIM_TTL_MS = 10 * 60_000; // a claim with no fill after this long is presumed crashed and expires
const KYBER = "https://aggregator-api.kyberswap.com/base/api/v1";
// KyberSwap's API rejects "bot" traffic: it wants a browser-looking UA and an Origin.
const KYBER_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", Origin: "https://kyberswap.com" };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const HERO_BASE = "0x9250532be90cc24e77a7cb160c4092c607242ba3";
const HERO_RH = "0xbA221e393645901C962Ad21E4e7FA097d550B67c";
const RH_RPC = "https://rpc.mainnet.chain.robinhood.com";
const BAL_ABI = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

// Skin-in-the-game gate: durable TWAP only executes while the PLAN'S RECIPIENT (the user's main
// wallet, where every buy lands) holds at least `holdMin` $HERO across Base + RH. Checked before
// every chunk, not once at setup — dump the stake mid-run and the cron stops spending. v1 is a
// held-balance gate (nothing locked); v2 is a real staking escrow with slashing.
export async function heroHoldingsOf(address, { baseRpc = "https://mainnet.base.org", rhRpc = RH_RPC } = {}) {
  const basePub = createPublicClient({ chain: base, transport: http(baseRpc) });
  const read = (pub, token) => pub.readContract({ address: token, abi: BAL_ABI, functionName: "balanceOf", args: [address] }).catch(() => 0n);
  const rhPub = createPublicClient({ transport: http(rhRpc) });
  const [a, b] = await Promise.all([read(basePub, HERO_BASE), read(rhPub, HERO_RH)]);
  return Number((a + b) / 10n ** 18n);
}

export function parseTwapPlans(entries) {
  const plans = new Map(), runs = [], claims = [];
  for (const e of entries || []) {
    if (typeof e.text !== "string") continue;
    if (e.text.startsWith(TWAP_MARK)) { try { const p = JSON.parse(e.text.slice(TWAP_MARK.length)); if (p.planId) plans.set(p.planId, p); } catch {} }
    else if (e.text.startsWith(TWAPRUN_MARK)) { try { const r = JSON.parse(e.text.slice(TWAPRUN_MARK.length)); if (r.planId) runs.push(r); } catch {} }
    else if (e.text.startsWith(TWAPCLAIM_MARK)) { try { const c = JSON.parse(e.text.slice(TWAPCLAIM_MARK.length)); if (c.planId) claims.push(c); } catch {} }
  }
  return { plans, runs, claims };
}

// The next chunk that is due: first index with no successful run, whose notBefore has passed.
// Two failed attempts on the same chunk disables the plan (fail-stop, never fail-spend).
export function nextDueChunk(plan, runs, now = Date.now()) {
  if (plan.enabled === false) return null;
  const mine = runs.filter((r) => r.planId === plan.planId);
  for (let i = 0; i < (plan.chunks || []).length; i++) {
    const attempts = mine.filter((r) => r.i === i);
    if (attempts.some((r) => r.ok)) continue;             // chunk done
    if (attempts.filter((r) => !r.ok).length >= 2) return { halt: true, i }; // fail-stop
    const nb = Date.parse(plan.chunks[i].notBefore || 0) || 0;
    if (now < nb) return null;                            // not yet — pacing
    return { i };
  }
  return null; // plan complete
}

async function kyber(path, init) {
  const r = await fetch(`${KYBER}${path}`, { ...init, headers: { ...KYBER_HEADERS, "Content-Type": "application/json", ...(init?.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.code !== 0) throw new Error(`KyberSwap ${path} ${r.status}: ${d.message || JSON.stringify(d).slice(0, 120)}`);
  return d.data;
}

// One chunk on Robinhood Chain: native ETH → token through our Uniswap v3 pool, quoted first, with
// a hard slippage floor. The pool is THIN — the wide default slippage mirrors the /twap page, and
// the amountOutMinimum still floors every fill so a manipulated pool fails the swap instead of
// filling badly with nobody watching.
export async function executeChunkRh({ plan, i, privateKey, rpc = RH_CHAIN.rpcUrls.default.http[0], slippageBps = 2000 }) {
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain: RH_CHAIN, transport: http(rpc) });
  const wc = createWalletClient({ account, chain: RH_CHAIN, transport: http(rpc) });
  const amountIn = BigInt(plan.chunks[i].amountIn); // wei
  const fee = plan.fee || 10000;
  const { result } = await pub.simulateContract({ account: account.address, address: RH_QUOTER, abi: RH_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn: RH_WETH, tokenOut: plan.tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
  const out = result[0];
  const minOut = out - (out * BigInt(plan.slippageBps || slippageBps)) / 10000n;
  const data = encodeFunctionData({ abi: RH_ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: RH_WETH, tokenOut: plan.tokenOut, fee, recipient: plan.recipient, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
  const tx = await wc.sendTransaction({ to: RH_ROUTER, data, value: amountIn });
  await pub.waitForTransactionReceipt({ hash: tx });
  return { tx, amountOut: out.toString() };
}

// Execute one chunk: quote → build → send from the session wallet, HERO straight to the recipient.
export async function executeChunk({ plan, i, privateKey, rpc = "https://mainnet.base.org", slippageBps = 100 }) {
  const account = privateKeyToAccount(privateKey);
  const pub = createPublicClient({ chain: base, transport: http(rpc) });
  const wc = createWalletClient({ account, chain: base, transport: http(rpc) });
  const chunk = plan.chunks[i];
  const amountIn = String(chunk.amountIn); // USDC base units (6dp), preformatted by the planner
  const route = await kyber(`/routes?tokenIn=${USDC}&tokenOut=${plan.tokenOut}&amountIn=${amountIn}`);
  const summary = route.routeSummary;
  const built = await kyber(`/route/build`, {
    method: "POST",
    body: JSON.stringify({ routeSummary: summary, sender: account.address, recipient: plan.recipient, slippageTolerance: slippageBps }),
  });
  // one-time unlimited approval to Kyber's router is the /twap page's own pattern; here we approve
  // exactly per-chunk to keep the burner's exposure at one chunk
  const ALLOW_ABI = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }];
  const current = await pub.readContract({ address: USDC, abi: ALLOW_ABI, functionName: "allowance", args: [account.address, built.routerAddress] }).catch(() => 0n);
  if (current < BigInt(amountIn)) {
    const allowanceData = `0x095ea7b3${built.routerAddress.slice(2).padStart(64, "0")}${BigInt(amountIn).toString(16).padStart(64, "0")}`;
    const approveTx = await wc.sendTransaction({ to: USDC, data: allowanceData });
    await pub.waitForTransactionReceipt({ hash: approveTx });
    // Public RPCs are load-balanced over replicas that can lag a block or two: the receipt being
    // in does NOT mean the next eth_call/estimateGas sees the new allowance. Poll until the
    // allowance actually reads back, or the swap's own simulation reverts TRANSFER_FROM_FAILED.
    for (let i = 0; i < 15; i++) {
      const a = await pub.readContract({ address: USDC, abi: ALLOW_ABI, functionName: "allowance", args: [account.address, built.routerAddress] }).catch(() => 0n);
      if (a >= BigInt(amountIn)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  // one bounded retry for the same replica-lag class of failure on the swap itself
  let tx;
  try {
    tx = await wc.sendTransaction({ to: built.routerAddress, data: built.data, value: 0n });
  } catch (e) {
    if (!/TRANSFER_FROM_FAILED|transfer amount exceeds allowance/i.test(e.message || "")) throw e;
    await new Promise((r) => setTimeout(r, 5000));
    tx = await wc.sendTransaction({ to: built.routerAddress, data: built.data, value: 0n });
  }
  await pub.waitForTransactionReceipt({ hash: tx });
  return { tx, amountOut: summary.amountOut };
}

// The per-agent tick: read plans from memory, run at most ONE due chunk, checkpoint the outcome.
export async function runTwapTick(mem, { privateKey, holdMin = 1_000_000, now = Date.now(), log = () => {} }) {
  const entries = await mem.raw().catch(() => []);
  const { plans, runs, claims } = parseTwapPlans(entries);
  let acted = 0;
  for (const plan of plans.values()) {
    const due = nextDueChunk(plan, runs, now);
    if (!due) continue;
    // the stake gate, re-checked EVERY chunk: recipient must still hold the minimum $HERO
    if (holdMin > 0) {
      const held = await heroHoldingsOf(plan.recipient).catch(() => 0);
      if (held < holdMin) { log(`twap ${plan.planId}: recipient holds ${held.toLocaleString()} $HERO < ${holdMin.toLocaleString()} required — chunk skipped, not spent.`); continue; }
    }
    if (due.halt) {
      log(`twap ${plan.planId}: chunk ${due.i} failed twice — halted. Recover funds from the session wallet on /twap.`);
      await mem.append([{ role: "system", text: TWAP_MARK + JSON.stringify({ ...plan, enabled: false, haltedAt: new Date(now).toISOString() }) }]);
      continue;
    }
    // CLAIM-THEN-VERIFY, the double-execution guard. The event log lives behind load-balanced RPCs
    // whose replicas can lag, so "no fill record visible" does NOT mean "not filled" (live test
    // caught a real 4-second double-fire this way). Before spending: (1) skip if a live claim for
    // this chunk already exists; (2) append our own claim; (3) RE-READ the log and require our own
    // claim to be visible — if we can't read our own write, the view is stale and we must not act;
    // (4) require ours to be the OLDEST live claim and the chunk still unfilled. Only then swap.
    const liveClaims = (cl) => cl.filter((c) => c.planId === plan.planId && c.i === due.i && now - (Date.parse(c.at) || 0) < CLAIM_TTL_MS);
    if (liveClaims(claims).length) { log(`twap ${plan.planId}: chunk ${due.i + 1} already claimed by another tick — skipped.`); continue; }
    const nonce = Math.random().toString(36).slice(2, 10);
    await mem.append([{ role: "system", text: TWAPCLAIM_MARK + JSON.stringify({ planId: plan.planId, i: due.i, nonce, at: new Date(now).toISOString() }) }]);
    // Re-read until our own claim is visible (read-your-write). Replicas usually catch up within
    // seconds; retry a few times before deferring the chunk to a later tick.
    let fresh, seen, mine;
    for (let attempt = 0; attempt < 4; attempt++) {
      fresh = parseTwapPlans(await mem.raw().catch(() => []));
      seen = liveClaims(fresh.claims);
      mine = seen.find((c) => c.nonce === nonce);
      if (mine) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (!mine) { log(`twap ${plan.planId}: stale read (own claim not visible after retries) — refusing to spend this tick.`); continue; }
    if (seen.some((c) => c.nonce !== nonce && (Date.parse(c.at) || 0) <= (Date.parse(mine.at) || 0))) { log(`twap ${plan.planId}: chunk ${due.i + 1} has an older claim — yielding.`); continue; }
    if (fresh.runs.some((r) => r.planId === plan.planId && r.i === due.i && r.ok)) { log(`twap ${plan.planId}: chunk ${due.i + 1} already filled — skipped.`); continue; }

    log(`twap ${plan.planId}: executing chunk ${due.i + 1}/${plan.chunks.length} (${plan.route || "base-usdc"})`);
    let rec;
    try {
      const exec = plan.route === "rh-eth" ? executeChunkRh : executeChunk;
      const { tx, amountOut } = await exec({ plan, i: due.i, privateKey });
      rec = { planId: plan.planId, i: due.i, ok: true, tx, amountOut, at: new Date(now).toISOString() };
      log(`  ✓ chunk ${due.i + 1} → ${tx}`);
    } catch (e) {
      rec = { planId: plan.planId, i: due.i, ok: false, error: String(e.message).slice(0, 300), at: new Date(now).toISOString() };
      log(`  ✗ chunk ${due.i + 1}: ${e.message}`);
    }
    await mem.append([{ role: "system", text: TWAPRUN_MARK + JSON.stringify(rec) }]);
    acted++;
    break; // one chunk per tick, across all plans: pacing and blast-radius control
  }
  return { plans: plans.size, acted };
}
