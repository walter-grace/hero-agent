// Worker-native on-chain memory client for the jobs cron. Same protocol as src/memory/onchain.mjs and
// the browser SDK (byte-for-byte: envelope {v,at,entries} gzip'd, marker 0/2, AES-GCM with a key
// derived from the agent wallet's signature, hash-chained checkpoints on Robinhood Chain) — but built
// for the Cloudflare Workers runtime: global crypto.subtle instead of node:crypto, fflate instead of
// node:zlib. Exposes { raw(), append() } so src/jobs.mjs runDue() works unchanged.
import { keccak256, toBytes, toHex, hexToBytes, encodePacked, encodeFunctionData, createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";

const ROOT_MARK = "root::";
const ABI = [{ name: "checkpoint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] }];
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

export class WorkerMemory {
  constructor({ agentId, privateKey, memAddr = "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc", rpc = "https://rpc.mainnet.chain.robinhood.com" }) {
    if (!privateKey) throw new Error("AGENT_PRIVATE_KEY required");
    if (agentId == null) throw new Error("agentId required");
    this.agentId = BigInt(agentId);
    this.memAddr = memAddr;
    this.KEY_MSG = `Hero Run Agent Memory key v2\nOnly sign this on herorunai.com. It derives the private key to your agent memory. Never sign it on any other site.\nContract: ${memAddr}\nChain: 4663`;
    this.KEY_MSG_V1 = `Hero Agent Memory encryption key v1\nContract: ${memAddr}\nChain: 4663`;
    const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
    this.account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : "0x" + privateKey);
    this.wallet = createWalletClient({ account: this.account, chain, transport: http(rpc, { retryCount: 8, retryDelay: 2000 }) });
    this.pub = createPublicClient({ chain, transport: http(rpc, { retryCount: 8, retryDelay: 2000 }) });
    this._key = null; this._keyV1 = null;
  }
  label() { return `onchain(rh):agent#${this.agentId}`; }
  async _mkKey(msg) { const sig = await this.account.signMessage({ message: msg }); return crypto.subtle.importKey("raw", toBytes(keccak256(toBytes(sig))), "AES-GCM", false, ["encrypt", "decrypt"]); }
  async _cryptoKey() { return this._key ??= await this._mkKey(this.KEY_MSG); }
  async _cryptoKeyV1() { return this._keyV1 ??= await this._mkKey(this.KEY_MSG_V1); }

  async _seal(entries) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const gz = gzipSync(strToU8(JSON.stringify({ v: 1, at: new Date().toISOString(), entries })));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this._cryptoKey(), gz));
    return cat(new Uint8Array([2]), iv, ct); // marker 2 = wallet-derived AES-GCM
  }
  async _open(blob) {
    let doc;
    if (blob[0] === 0) doc = JSON.parse(strFromU8(gunzipSync(blob.subarray(1))));
    else if (blob[0] !== 2) throw new Error("sealed");
    else {
      const iv = blob.subarray(1, 13), ct = blob.subarray(13);
      let pt;
      try { pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await this._cryptoKey(), ct); }
      catch { pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await this._cryptoKeyV1(), ct); }
      doc = JSON.parse(strFromU8(gunzipSync(new Uint8Array(pt))));
    }
    const entries = Array.isArray(doc) ? doc : (doc.entries || []);
    const at = Array.isArray(doc) ? undefined : doc.at;
    return at ? entries.map((e) => ({ at, ...e })) : entries;
  }

  async _head() {
    const sel = keccak256(toBytes("headOf(uint256)")).slice(0, 10);
    const res = await this.pub.request({ method: "eth_call", params: [{ to: this.memAddr, data: sel + this.agentId.toString(16).padStart(64, "0") }, "latest"] });
    const b = (res || "0x").replace(/^0x/, "").padEnd(256, "0");
    return { hash: "0x" + b.slice(0, 64), count: Number(BigInt("0x" + (b.slice(64, 128) || "0"))), lastBlock: Number(BigInt("0x" + (b.slice(128, 192) || "0"))), era: Number(BigInt("0x" + (b.slice(192, 256) || "0"))) };
  }
  async _all() {
    const T = keccak256(toBytes("Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes)"));
    const agentTopic = "0x" + this.agentId.toString(16).padStart(64, "0");
    const head = await this._head();
    if (head.count === 0) return [];
    const eraTopic = "0x" + BigInt(head.era).toString(16).padStart(64, "0");
    const raw = [];
    let block = head.lastBlock;
    for (let i = 0; i < head.count && block > 0; i++) {
      const hexBlk = "0x" + block.toString(16);
      let logs = [];
      for (let a = 0; a < 4 && !logs.length; a++) {
        if (a) await new Promise((r) => setTimeout(r, 1000 * a));
        logs = await this.pub.request({ method: "eth_getLogs", params: [{ address: this.memAddr, topics: [T, agentTopic, eraTopic], fromBlock: hexBlk, toBlock: hexBlk }] }).catch(() => []);
      }
      if (!logs.length) throw new Error(`missing checkpoint at RH block ${block}`);
      logs.sort((a, b) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
      raw.unshift(...logs.map((l) => {
        const d = (l.data || "0x").slice(2);
        const off = parseInt(d.slice(4 * 64, 5 * 64), 16) * 2;
        const len = parseInt(d.slice(off, off + 64), 16) * 2;
        return { seqNo: Number(BigInt("0x" + d.slice(0, 64))), prevBlock: Number(BigInt("0x" + d.slice(64, 128))), newHash: "0x" + d.slice(192, 256), data: "0x" + d.slice(off + 64, off + 64 + len) };
      }));
      block = raw[0].prevBlock;
    }
    let h = "0x" + "0".repeat(64);
    for (const c of raw) { if (keccak256(encodePacked(["bytes32", "bytes"], [h, c.data])) !== c.newHash) throw new Error(`hash chain mismatch at seq ${c.seqNo}`); h = c.newHash; }
    if (h !== head.hash) throw new Error("chain head mismatch");
    const out = []; let seq = 0;
    for (const c of raw) { try { for (const e of await this._open(hexToBytes(c.data))) out.push({ ...e, seq: ++seq }); } catch {} }
    return out;
  }
  async raw() { return (await this._all()).filter((e) => !(e.role === "agent" && String(e.text).startsWith(ROOT_MARK))); }
  async append(entries) {
    const data = toHex(await this._seal(entries));
    return this.wallet.sendTransaction({ to: this.memAddr, data: encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] }) });
  }
}
