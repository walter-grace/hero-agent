import { keccak256, toBytes } from "viem";
const ec = async (data) => (await (await fetch("https://rpc.mainnet.chain.robinhood.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc", data }, "latest"] }) })).json()).result;
const count = async () => {
  const r = await ec(keccak256(toBytes("headOf(uint256)")).slice(0, 10) + (7).toString(16).padStart(64, "0"));
  const b = (r || "0x").replace(/^0x/, "").padEnd(256, "0");
  return Number(BigInt("0x" + b.slice(64, 128)));
};
const deadline = Date.now() + 13 * 60 * 1000;
let last = await count();
console.log(`start: ${last} checkpoints`);
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 20000));
  const n = await count();
  if (n !== last) { console.log(`+${n - last} → ${n} checkpoints`); last = n; }
  if (n >= 4) { console.log("RUN COMPLETE (plan + 2 steps + done)"); process.exit(0); }
}
console.log(`timed out at ${last} checkpoints`);
