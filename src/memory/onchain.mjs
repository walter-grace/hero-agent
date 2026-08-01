// On-chain memory backend — the differentiator. Memories are AES-256-GCM encrypted with a key
// derived from the agent wallet's own signature, gzip'd, and written to the Agent Memory contract on
// Robinhood Chain. On-chain observers (and Hero Run) see only random bytes; only the wallet that
// holds AGENT_PRIVATE_KEY can decrypt. Raw checkpoints are immutable leaves; the ROOT index from
// compaction is just another (marked) checkpoint. Same interface as LocalMemory.
//
// Requires: AGENT_PRIVATE_KEY (a wallet you control, funded with a little RH gas) and `viem`.
// This mirrors the browser SDK the herorunai.com/agent page uses (lib/agent-memory.js), ported to
// Node. Reads walk the contract's checkpoint events; writes are one transaction each (~$0.003).
import { gzipSync, gunzipSync } from "node:zlib";
import { keccak256, toBytes, toHex, encodeFunctionData, createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const MEM_ADDR = process.env.HERO_MEM_ADDR || "0x881a9f7ed58b7655c3c04bb2f9ef2cffd233a5ef";
const RH_RPC = process.env.RH_RPC || "https://rpc.robinhood.com"; // override with a known-good RH RPC
const KEY_MSG = `Hero Agent Memory encryption key v1\nContract: ${MEM_ADDR}\nChain: 4663`;
const ROOT_MARK = "root::";
const ABI = [
  { name: "checkpoint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
  { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }], outputs: [] },
];
const rhChain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } });

export class OnchainMemory {
  constructor({ agentId, privateKey = process.env.AGENT_PRIVATE_KEY }) {
    if (!privateKey) throw new Error("On-chain memory needs AGENT_PRIVATE_KEY (a wallet with a little RH gas).");
    if (agentId == null) throw new Error("On-chain memory needs an agentId (mint one first).");
    this.agentId = BigInt(agentId);
    this.account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : "0x" + privateKey);
    this.wallet = createWalletClient({ account: this.account, chain: rhChain, transport: http(RH_RPC) });
    this.pub = createPublicClient({ chain: rhChain, transport: http(RH_RPC) });
    this._key = null;
  }
  async _cryptoKey() {
    if (this._key) return this._key;
    const sig = await this.account.signMessage({ message: KEY_MSG });
    const raw = toBytes(keccak256(toBytes(sig)));
    const { webcrypto } = await import("node:crypto");
    this._key = await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return this._key;
  }
  async _seal(entries) {
    const { webcrypto } = await import("node:crypto");
    const key = await this._cryptoKey();
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const gz = gzipSync(Buffer.from(JSON.stringify(entries)));
    const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gz));
    return Buffer.concat([Buffer.from([1]), Buffer.from(iv), Buffer.from(ct)]); // 1 = AES-GCM marker
  }
  async _open(blob) {
    const { webcrypto } = await import("node:crypto");
    if (blob[0] !== 1) throw new Error("sealed"); // not ours / unknown marker
    const key = await this._cryptoKey();
    const pt = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(1, 13) }, key, blob.subarray(13));
    return JSON.parse(gunzipSync(Buffer.from(pt)).toString());
  }
  async append(entries) {
    const data = toHex(await this._seal(entries));
    const call = encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] });
    return this.wallet.sendTransaction({ to: MEM_ADDR, data: call });
  }
  // NOTE: recall reads this agent's checkpoint events and decrypts. Kept simple (newest 500 blocks of
  // events for this agent); the browser SDK does full hash-chain verification — port that if you need
  // tamper-proof reads. Returns entries flattened with a running seq.
  async raw() { return (await this._all()).filter((e) => !(e.role === "agent" && e.text.startsWith(ROOT_MARK))); }
  async _all() {
    const T = keccak256(toBytes("Checkpoint(uint256,uint256,uint256,bytes)")); // event sig (see contract)
    const logs = await this.pub.getLogs({ address: MEM_ADDR, fromBlock: 0n, toBlock: "latest" }).catch(() => []);
    const out = [];
    let seq = 0;
    for (const l of logs) {
      try { const entries = await this._open(Buffer.from((l.data || "0x").slice(2), "hex")); for (const e of entries) out.push({ ...e, seq: ++seq }); }
      catch { /* not ours or sealed */ }
    }
    return out;
  }
  async getRoot() {
    const roots = (await this._all()).filter((e) => e.role === "agent" && e.text.startsWith(ROOT_MARK));
    const last = roots[roots.length - 1];
    return last ? { text: last.text.slice(ROOT_MARK.length), seq: last.seq } : null;
  }
  async setRoot(text) { return this.append([{ role: "agent", text: ROOT_MARK + text }]); }
  async sinceRoot() { const r = await this.getRoot(); const seq = r?.seq || 0; return (await this.raw()).filter((e) => e.seq > seq); }
  label() { return `robinhood-chain:agent#${this.agentId}`; }
}
