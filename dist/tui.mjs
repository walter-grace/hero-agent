var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/vault.mjs
var vault_exports = {};
__export(vault_exports, {
  deleteSecret: () => deleteSecret,
  listSecrets: () => listSecrets,
  loadHeroEnv: () => loadHeroEnv,
  openVault: () => openVault,
  secrets: () => secrets,
  setSecret: () => setSecret,
  vaultLogin: () => vaultLogin,
  vaultToken: () => vaultToken
});
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { webcrypto } from "node:crypto";
import { keccak256, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
async function vaultLogin({ privateKey, token, tokenPath = TOKEN_PATH } = {}) {
  let address, kHex;
  if (token) {
    const m = String(token).trim().match(/^hvt1\.(0x[0-9a-fA-F]{40})\.(0x[0-9a-f]{64})$/);
    if (!m) throw new Error("That doesn't look like a vault token (hvt1.<address>.<key>).");
    address = m[1];
    kHex = m[2];
  } else if (privateKey) {
    const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
    const sig = await account.signMessage({ message: VAULT_MSG });
    address = account.address;
    kHex = keccak256(sig);
  } else {
    throw new Error("Pass a private key (--key-file) or a token from the web UI (--token).");
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ v: 1, address, k: kHex }, null, 2) + "\n");
  chmodSync(tokenPath, 384);
  return { address, tokenPath };
}
function vaultToken(tokenPath = TOKEN_PATH) {
  if (process.env.HERO_VAULT_TOKEN) {
    const m = process.env.HERO_VAULT_TOKEN.match(/^hvt1\.(0x[0-9a-fA-F]{40})\.(0x[0-9a-f]{64})$/);
    if (m) return { address: m[1], k: m[2] };
  }
  if (!existsSync(tokenPath)) return null;
  try {
    const j = JSON.parse(readFileSync(tokenPath, "utf8"));
    return j?.k ? j : null;
  } catch {
    return null;
  }
}
async function aesKey(kHex) {
  return webcrypto.subtle.importKey("raw", hexToBytes(kHex), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function dec(kHex, b64) {
  const blob = Buffer.from(b64, "base64");
  if (blob[0] !== 1) throw new Error("unrecognized vault blob");
  const pt = new Uint8Array(await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: blob.subarray(1, 13) }, await aesKey(kHex), blob.subarray(13)));
  return JSON.parse(Buffer.from(pt).toString("utf8"));
}
async function enc(kHex, obj) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(kHex), Buffer.from(JSON.stringify(obj), "utf8")));
  const out = new Uint8Array(13 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return Buffer.from(out).toString("base64");
}
async function api(op, wallet, extra = {}) {
  const r = await fetch(`${BASE}/api/vault`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, wallet, ...extra })
  });
  if (r.status === 503) throw new Error("Vault storage is temporarily unavailable.");
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) throw new Error("This token can't open the vault (was it rotated?). Re-run vault login.");
  if (!r.ok) throw new Error(j.error || `vault ${op} failed`);
  return j;
}
async function openVault({ tokenPath = TOKEN_PATH } = {}) {
  const t = vaultToken(tokenPath);
  if (!t) throw new Error(`No vault token. Run \`hero-agent vault login\` first (or set HERO_VAULT_TOKEN).`);
  const authToken = keccak256(t.k);
  const j = await api("get", t.address, { authToken });
  const vault = j.blob ? await dec(t.k, j.blob) : {};
  return {
    address: t.address,
    vault,
    async save(next) {
      const blob = await enc(t.k, next);
      await api("put", t.address, { authToken, blob });
      return next;
    }
  };
}
async function secrets({ tokenPath, purpose = "" } = {}) {
  const { vault, save } = await openVault({ tokenPath });
  const env = vault.envVars && typeof vault.envVars === "object" ? { ...vault.envVars } : {};
  try {
    const log = Array.isArray(vault.credLog) ? vault.credLog : [];
    log.push({ label: "env", host: "vault", purpose: String(purpose || "secrets() pull").slice(0, 200), harness: "sdk", at: (/* @__PURE__ */ new Date()).toISOString(), result: "released", count: Object.keys(env).length });
    if (log.length > 500) log.splice(0, log.length - 500);
    await save({ ...vault, credLog: log });
  } catch {
  }
  return env;
}
async function loadHeroEnv({ tokenPath, overwrite = false, purpose } = {}) {
  const env = await secrets({ tokenPath, purpose: purpose || "loadHeroEnv()" });
  const loaded = [];
  for (const [k, v] of Object.entries(env)) {
    if (!overwrite && process.env[k] !== void 0) continue;
    process.env[k] = String(v);
    loaded.push(k);
  }
  return loaded;
}
async function setSecret(name, value, { tokenPath } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Secret names must look like ENV_VARS.");
  const { vault, save } = await openVault({ tokenPath });
  const envVars = { ...vault.envVars || {}, [name]: String(value) };
  await save({ ...vault, envVars });
}
async function deleteSecret(name, { tokenPath } = {}) {
  const { vault, save } = await openVault({ tokenPath });
  const envVars = { ...vault.envVars || {} };
  delete envVars[name];
  await save({ ...vault, envVars });
}
async function listSecrets({ tokenPath } = {}) {
  const { vault } = await openVault({ tokenPath });
  return Object.keys(vault.envVars || {}).sort();
}
var BASE, TOKEN_PATH, VAULT_MSG;
var init_vault = __esm({
  "src/vault.mjs"() {
    BASE = process.env.HERO_RUN_URL || "https://herorunai.com";
    TOKEN_PATH = process.env.HERO_VAULT_TOKEN_FILE || join(homedir(), ".hero-agent", "vault-token.json");
    VAULT_MSG = `Hero Run key vault v2
Only sign this on herorunai.com. It derives the key to every API key and connector credential you have saved. Never sign it on any other site.
Origin: herorunai.com`;
  }
});

// src/memory/room.mjs
var room_exports = {};
__export(room_exports, {
  PUBKEY_MARK: () => PUBKEY_MARK,
  ROOMKEY_MARK: () => ROOMKEY_MARK,
  ROOM_MARK: () => ROOM_MARK,
  makeRoomKey: () => makeRoomKey,
  openRoom: () => openRoom,
  pubkeyOf: () => pubkeyOf,
  sealRoom: () => sealRoom,
  unwrapKey: () => unwrapKey,
  wrapKey: () => wrapKey
});
import { createECDH, createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function pubkeyOf(privHex) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privHex.replace(/^0x/, ""), "hex"));
  return ecdh.getPublicKey("hex", "uncompressed");
}
function wrapKey(memberPubHex, roomKey) {
  const eph = createECDH("secp256k1");
  eph.generateKeys();
  const shared = eph.computeSecret(Buffer.from(memberPubHex, "hex"));
  const kek = h32(shared);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([c.update(roomKey), c.final()]);
  return { ephPub: eph.getPublicKey("hex", "uncompressed"), iv: iv.toString("hex"), ct: Buffer.concat([ct, c.getAuthTag()]).toString("hex") };
}
function unwrapKey(privHex, wrap) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privHex.replace(/^0x/, ""), "hex"));
  const shared = ecdh.computeSecret(Buffer.from(wrap.ephPub, "hex"));
  const kek = h32(shared);
  const blob = Buffer.from(wrap.ct, "hex");
  const ct = blob.subarray(0, blob.length - 16), tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(wrap.iv, "hex"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function sealRoom(roomKey, entriesJsonGz) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", roomKey, iv);
  const ct = Buffer.concat([c.update(entriesJsonGz), c.final(), c.getAuthTag()]);
  return Buffer.concat([Buffer.from([ROOM_MARK]), iv, ct]);
}
function openRoom(roomKey, blob) {
  if (blob[0] !== ROOM_MARK) throw new Error("not a room blob");
  const iv = blob.subarray(1, 13), body = blob.subarray(13);
  const ct = body.subarray(0, body.length - 16), tag = body.subarray(body.length - 16);
  const d = createDecipheriv("aes-256-gcm", roomKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
var ROOM_MARK, PUBKEY_MARK, ROOMKEY_MARK, h32, makeRoomKey;
var init_room = __esm({
  "src/memory/room.mjs"() {
    ROOM_MARK = 3;
    PUBKEY_MARK = "pubkey::";
    ROOMKEY_MARK = "roomkey::";
    h32 = (buf) => createHash("sha256").update(buf).digest();
    makeRoomKey = () => randomBytes(32);
  }
});

// src/memory/onchain.mjs
var onchain_exports = {};
__export(onchain_exports, {
  OnchainMemory: () => OnchainMemory
});
import { gzipSync, gunzipSync } from "node:zlib";
import { keccak256 as keccak2562, toBytes, toHex, encodePacked, encodeFunctionData, createWalletClient, createPublicClient, http, defineChain } from "viem";
import { privateKeyToAccount as privateKeyToAccount2 } from "viem/accounts";
var MEM_ADDR, RH_RPC, KEY_MSG, KEY_MSG_V1, ROOT_MARK, ABI, rhChain, OnchainMemory;
var init_onchain = __esm({
  "src/memory/onchain.mjs"() {
    init_room();
    MEM_ADDR = process.env.HERO_MEM_ADDR || "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";
    RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
    KEY_MSG = `Hero Run Agent Memory key v2
Only sign this on herorunai.com. It derives the private key to your agent memory. Never sign it on any other site.
Contract: ${MEM_ADDR}
Chain: 4663`;
    KEY_MSG_V1 = `Hero Agent Memory encryption key v1
Contract: ${MEM_ADDR}
Chain: 4663`;
    ROOT_MARK = "root::";
    ABI = [
      { name: "checkpoint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "agentId", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
      { name: "mint", type: "function", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }], outputs: [] }
    ];
    rhChain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RH_RPC] } } });
    OnchainMemory = class {
      constructor({ agentId, privateKey = process.env.AGENT_PRIVATE_KEY, roomKey = null }) {
        if (!privateKey) throw new Error("On-chain memory needs AGENT_PRIVATE_KEY (a wallet with a little RH gas).");
        if (agentId == null) throw new Error("On-chain memory needs an agentId (mint one first).");
        this.agentId = BigInt(agentId);
        this.account = privateKeyToAccount2(privateKey.startsWith("0x") ? privateKey : "0x" + privateKey);
        this.wallet = createWalletClient({ account: this.account, chain: rhChain, transport: http(RH_RPC) });
        this.pub = createPublicClient({ chain: rhChain, transport: http(RH_RPC) });
        this._key = null;
        this._keyV1 = null;
        this.roomKey = roomKey;
      }
      async _cryptoKey() {
        if (this._key) return this._key;
        const sig = await this.account.signMessage({ message: KEY_MSG });
        const raw = toBytes(keccak2562(toBytes(sig)));
        const { webcrypto: webcrypto2 } = await import("node:crypto");
        this._key = await webcrypto2.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
        return this._key;
      }
      // v1 key, derived lazily only when a pre-v2 blob is encountered on read.
      async _cryptoKeyV1() {
        if (this._keyV1) return this._keyV1;
        const sig = await this.account.signMessage({ message: KEY_MSG_V1 });
        const raw = toBytes(keccak2562(toBytes(sig)));
        const { webcrypto: webcrypto2 } = await import("node:crypto");
        this._keyV1 = await webcrypto2.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
        return this._keyV1;
      }
      // Canonical blob format shared with the web SDK and the hosted MCP server, so memory written on
      // any surface is readable on every other one from the same wallet: byte 0 = marker
      // (0 = plaintext gzip, 1 = passphrase/PBKDF2, 2 = wallet-derived AES-GCM), then IV[12], then
      // ciphertext. We write 2 (wallet-derived); using 1 here would collide with the passphrase marker
      // and make this agent's memory unreadable on herorunai.com and in Claude Code via MCP.
      async _seal(entries) {
        const { webcrypto: webcrypto2 } = await import("node:crypto");
        const key = await this._cryptoKey();
        const iv = webcrypto2.getRandomValues(new Uint8Array(12));
        const gz = gzipSync(Buffer.from(JSON.stringify({ v: 1, at: (/* @__PURE__ */ new Date()).toISOString(), entries })));
        const ct = new Uint8Array(await webcrypto2.subtle.encrypt({ name: "AES-GCM", iv }, key, gz));
        return Buffer.concat([Buffer.from([2]), Buffer.from(iv), Buffer.from(ct)]);
      }
      async _open(blob) {
        const { webcrypto: webcrypto2 } = await import("node:crypto");
        let doc;
        if (blob[0] === 0) doc = JSON.parse(gunzipSync(Buffer.from(blob.subarray(1))).toString());
        else if (blob[0] === ROOM_MARK) {
          if (!this.roomKey) throw new Error("sealed");
          doc = JSON.parse(gunzipSync(openRoom(this.roomKey, Buffer.from(blob))).toString());
          doc.__room = true;
        } else if (blob[0] !== 2) throw new Error("sealed");
        else {
          const iv = blob.subarray(1, 13), ct = blob.subarray(13);
          let pt;
          try {
            pt = await webcrypto2.subtle.decrypt({ name: "AES-GCM", iv }, await this._cryptoKey(), ct);
          } catch {
            pt = await webcrypto2.subtle.decrypt({ name: "AES-GCM", iv }, await this._cryptoKeyV1(), ct);
          }
          doc = JSON.parse(gunzipSync(Buffer.from(pt)).toString());
        }
        const entries = Array.isArray(doc) ? doc : doc.entries || [];
        const at = Array.isArray(doc) ? void 0 : doc.at;
        const room = !Array.isArray(doc) && doc.__room ? { room: true } : null;
        return entries.map((e) => ({ ...at ? { at } : {}, ...room || {}, ...e }));
      }
      // PUBLIC append: marker-0 gzip, no encryption. The multiplayer channel — any wallet the owner
      // has approved on the NFT can write these, and ANYONE (hero-sdk publicEntries, other members on
      // other wallets, the world) can read them without a key. Private entries stay marker-2 and
      // owner-only; a room chooses its visibility per entry, not per agent.
      // ROOM append: marker-3, encrypted with the shared room key. Only members (holders of a
      // roomkey:: wrap) can read these; the contract's approval still gates the write itself.
      async appendRoom(entries) {
        if (!this.roomKey) throw new Error("No room key \u2014 recover it from your roomkey:: wrap first.");
        const gz = gzipSync(Buffer.from(JSON.stringify({ v: 1, at: (/* @__PURE__ */ new Date()).toISOString(), entries })));
        const data = toHex(sealRoom(this.roomKey, gz));
        const call2 = encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] });
        return this.wallet.sendTransaction({ to: MEM_ADDR, data: call2 });
      }
      async appendPublic(entries) {
        const gz = gzipSync(Buffer.from(JSON.stringify({ v: 1, at: (/* @__PURE__ */ new Date()).toISOString(), entries })));
        const data = toHex(Buffer.concat([Buffer.from([0]), gz]));
        const call2 = encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] });
        return this.wallet.sendTransaction({ to: MEM_ADDR, data: call2 });
      }
      async append(entries) {
        const data = toHex(await this._seal(entries));
        const call2 = encodeFunctionData({ abi: ABI, functionName: "checkpoint", args: [this.agentId, data] });
        return this.wallet.sendTransaction({ to: MEM_ADDR, data: call2 });
      }
      // Verified reads: a port of the browser SDK's recall() (hero-foundry-web/lib/agent-memory.js).
      // Checkpoint(uint256 indexed agentId, uint64 indexed era, uint64 seq, uint64 prevBlock,
      //            bytes32 prevHash, bytes32 newHash, bytes data): agentId + era are indexed (topics),
      // so the event DATA words are seq(0) prevBlock(1) prevHash(2) newHash(3) offset(4) len bytes….
      // The walk starts from the contract's head, follows prevBlock backwards one block at a time
      // (⚠️ Orbit: block numbers in events are ArbSys numbers, which is why headOf/prevBlock are the
      // source of truth, never eth_blockNumber), rebuilds the keccak chain over the raw blob of every
      // checkpoint (sealed or not), and refuses to return entries if any link or the final head
      // mismatches. Decrypt failures on individual blobs are tolerated; tamper is not.
      async raw() {
        return (await this._all()).filter((e) => !(e.role === "agent" && e.text.startsWith(ROOT_MARK)));
      }
      async _head() {
        const sel = keccak2562(toBytes("headOf(uint256)")).slice(0, 10);
        const res = await this.pub.request({ method: "eth_call", params: [{ to: MEM_ADDR, data: sel + this.agentId.toString(16).padStart(64, "0") }, "latest"] });
        const b = (res || "0x").replace(/^0x/, "").padEnd(256, "0");
        return {
          hash: "0x" + b.slice(0, 64),
          count: Number(BigInt("0x" + (b.slice(64, 128) || "0"))),
          lastBlock: Number(BigInt("0x" + (b.slice(128, 192) || "0"))),
          era: Number(BigInt("0x" + (b.slice(192, 256) || "0")))
        };
      }
      async _all() {
        const T = keccak2562(toBytes("Checkpoint(uint256,uint64,uint64,uint64,bytes32,bytes32,bytes)"));
        const agentTopic = "0x" + this.agentId.toString(16).padStart(64, "0");
        const head = await this._head();
        if (head.count === 0) return [];
        const eraTopic = "0x" + BigInt(head.era).toString(16).padStart(64, "0");
        const raw = [];
        let block = head.lastBlock;
        for (let i = 0; i < head.count && block > 0; i++) {
          const hexBlk = "0x" + block.toString(16);
          let logs = [];
          for (let attempt = 0; attempt < 4 && !logs.length; attempt++) {
            if (attempt) await new Promise((r) => setTimeout(r, 1e3 * attempt));
            logs = await this.pub.request({ method: "eth_getLogs", params: [{ address: MEM_ADDR, topics: [T, agentTopic, eraTopic], fromBlock: hexBlk, toBlock: hexBlk }] }).catch(() => []);
          }
          if (!logs.length) throw new Error(`Memory read: missing checkpoint at RH block ${block} (RPC gap).`);
          logs.sort((a, b) => parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
          raw.unshift(...logs.map((l) => {
            const d = (l.data || "0x").slice(2);
            const off = parseInt(d.slice(4 * 64, 5 * 64), 16) * 2;
            const len = parseInt(d.slice(off, off + 64), 16) * 2;
            return {
              seqNo: Number(BigInt("0x" + d.slice(0, 64))),
              prevBlock: Number(BigInt("0x" + d.slice(64, 128))),
              newHash: "0x" + d.slice(192, 256),
              data: "0x" + d.slice(off + 64, off + 64 + len)
            };
          }));
          block = raw[0].prevBlock;
        }
        let h = "0x" + "0".repeat(64);
        for (const c of raw) {
          if (keccak2562(encodePacked(["bytes32", "bytes"], [h, c.data])) !== c.newHash) throw new Error(`Memory read: hash chain mismatch at checkpoint seq ${c.seqNo}.`);
          h = c.newHash;
        }
        if (h !== head.hash) throw new Error("Memory read: chain head mismatch (walk incomplete or contract head moved).");
        const out = [];
        let seq = 0;
        for (const c of raw) {
          try {
            const entries = await this._open(Buffer.from(c.data.slice(2), "hex"));
            for (const e of entries) out.push({ ...e, seq: ++seq });
          } catch {
          }
        }
        return out;
      }
      async getRoot() {
        const roots = (await this._all()).filter((e) => e.role === "agent" && e.text.startsWith(ROOT_MARK));
        const last = roots[roots.length - 1];
        return last ? { text: last.text.slice(ROOT_MARK.length), seq: last.seq } : null;
      }
      async setRoot(text) {
        return this.append([{ role: "agent", text: ROOT_MARK + text }]);
      }
      async sinceRoot() {
        const r = await this.getRoot();
        const seq = r?.seq || 0;
        return (await this.raw()).filter((e) => e.seq > seq);
      }
      label() {
        return `robinhood-chain:agent#${this.agentId}`;
      }
    };
  }
});

// src/tui/index.jsx
import React3 from "react";
import { render } from "ink";
import { readFileSync as readFileSync3 } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname as dirname2, join as join3 } from "node:path";

// src/tui/app.jsx
import React2, { useState as useState2, useEffect as useEffect2, useRef, useCallback } from "react";
import { Box as Box2, Text as Text2, Static, useInput, useApp, useStdout } from "ink";

// src/tui/ui.jsx
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

// src/tui/theme.mjs
var BRASS = "#d4a94e";
var MINERAL = "#7fa893";
var STEEL = "#6fa8bc";
var STONE = "#8a8578";
var EMBER = "#c25e4c";
var PAPER = "#e8e4da";
var STOPS = [
  [212, 169, 78],
  // brass
  [127, 168, 147],
  // mineral
  [111, 168, 188]
  // steel
];
var lerp = (a, b, t) => Math.round(a + (b - a) * t);
var hex = (r, g, b) => `#${(1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1)}`;
function gradient(text, phase = 0) {
  const n = Math.max(1, text.length - 1);
  return [...text].map((ch, i) => {
    let t = (i / n + phase) % 2;
    if (t > 1) t = 2 - t;
    const seg = t < 0.5 ? 0 : 1;
    const u = (t - seg * 0.5) * 2;
    const [a, b] = [STOPS[seg], STOPS[seg + 1]];
    return { ch, color: hex(lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)) };
  });
}

// src/tui/ui.jsx
import { jsx, jsxs } from "react/jsx-runtime";
var LOGO = [
  "\u2588 \u2588 \u2588\u2580\u2580 \u2588\u2580\u2588 \u2588\u2580\u2588   \u2588\u2580\u2588 \u2588 \u2588 \u2588\u2584 \u2588",
  "\u2588\u2580\u2588 \u2588\u2588\u2584 \u2588\u2580\u2584 \u2588\u2584\u2588   \u2588\u2580\u2584 \u2588\u2584\u2588 \u2588 \u2580\u2588"
];
function Banner({ animated = true, version: version2 = "" }) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!animated) return;
    const t = setInterval(() => setPhase((p) => (p + 0.04) % 2), 90);
    return () => clearInterval(t);
  }, [animated]);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginBottom: 1, children: [
    LOGO.map((line, i) => /* @__PURE__ */ jsx(Text, { children: gradient(line, phase + i * 0.12).map((s, j) => /* @__PURE__ */ jsx(Text, { color: s.color, children: s.ch }, j)) }, i)),
    /* @__PURE__ */ jsxs(Text, { color: STONE, children: [
      "fund open-source AI by using it \xB7 herorunai.com",
      version2 ? /* @__PURE__ */ jsxs(Text, { color: STONE, children: [
        " \xB7 v",
        version2
      ] }) : null
    ] })
  ] });
}
var FRAMES = ["\u28FE", "\u28FD", "\u28FB", "\u28BF", "\u287F", "\u28DF", "\u28EF", "\u28F7"];
var VERBS = ["Routing", "Reasoning", "Composing", "Distilling", "Forging", "Weighing", "Polishing"];
function Thinking({ startedAt, note }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, []);
  const secs = ((Date.now() - startedAt) / 1e3).toFixed(0);
  const verb = note || VERBS[Math.floor(tick / 26) % VERBS.length];
  return /* @__PURE__ */ jsxs(Box, { children: [
    /* @__PURE__ */ jsxs(Text, { color: BRASS, children: [
      FRAMES[tick % FRAMES.length],
      " "
    ] }),
    /* @__PURE__ */ jsxs(Text, { color: PAPER, children: [
      verb,
      "\u2026 "
    ] }),
    /* @__PURE__ */ jsxs(Text, { color: STONE, children: [
      "(",
      secs,
      "s \xB7 esc to cancel)"
    ] })
  ] });
}
function inline(text, keyBase) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return /* @__PURE__ */ jsx(Text, { bold: true, color: PAPER, children: p.slice(2, -2) }, `${keyBase}-${i}`);
    if (p.startsWith("`") && p.endsWith("`")) return /* @__PURE__ */ jsx(Text, { color: BRASS, children: p.slice(1, -1) }, `${keyBase}-${i}`);
    return /* @__PURE__ */ jsx(Text, { children: p }, `${keyBase}-${i}`);
  });
}
function Md({ text }) {
  const lines = String(text || "").split("\n");
  const out = [];
  let inCode = false, codeLines = [], codeLang = "";
  const flushCode = (key) => {
    out.push(
      /* @__PURE__ */ jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: STONE, paddingX: 1, marginY: 0, children: [
        codeLang ? /* @__PURE__ */ jsx(Text, { color: STONE, children: codeLang }) : null,
        codeLines.map((c, i) => /* @__PURE__ */ jsx(Text, { color: STEEL, children: c || " " }, i))
      ] }, key)
    );
    codeLines = [];
    codeLang = "";
  };
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("```")) {
      if (inCode) flushCode(`code-${i}`);
      else codeLang = line.trim().slice(3);
      inCode = !inCode;
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      out.push(/* @__PURE__ */ jsx(Text, { bold: true, color: MINERAL, children: h[2] }, i));
      return;
    }
    const b = line.match(/^(\s*)[-*]\s+(.*)/);
    if (b) {
      out.push(/* @__PURE__ */ jsxs(Text, { children: [
        b[1],
        /* @__PURE__ */ jsx(Text, { color: BRASS, children: "\u2022 " }),
        inline(b[2], i)
      ] }, i));
      return;
    }
    const n = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (n) {
      out.push(/* @__PURE__ */ jsxs(Text, { children: [
        n[1],
        /* @__PURE__ */ jsxs(Text, { color: BRASS, children: [
          n[2],
          ". "
        ] }),
        inline(n[3], i)
      ] }, i));
      return;
    }
    out.push(/* @__PURE__ */ jsx(Text, { children: line ? inline(line, i) : " " }, i));
  });
  if (inCode && codeLines.length) flushCode("code-tail");
  return /* @__PURE__ */ jsx(Box, { flexDirection: "column", children: out });
}
function UserLine({ text }) {
  return /* @__PURE__ */ jsxs(Box, { marginTop: 1, children: [
    /* @__PURE__ */ jsx(Text, { color: STONE, children: "> " }),
    /* @__PURE__ */ jsx(Text, { color: PAPER, children: text })
  ] });
}
function AssistantBlock({ text, meta }) {
  const tpsColor = meta?.tps == null ? STONE : meta.tps > 40 ? "#7fbf7f" : meta.tps > 12 ? BRASS : EMBER;
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginTop: 1, children: [
    /* @__PURE__ */ jsxs(Box, { children: [
      /* @__PURE__ */ jsx(Text, { color: MINERAL, children: "\u273B " }),
      /* @__PURE__ */ jsx(Box, { flexDirection: "column", flexGrow: 1, children: /* @__PURE__ */ jsx(Md, { text }) })
    ] }),
    meta ? /* @__PURE__ */ jsxs(Text, { color: STONE, children: [
      "  ",
      meta.model,
      meta.cost ? ` \xB7 ${meta.cost}` : "",
      ` \xB7 ${meta.secs}s`,
      meta.tps != null ? /* @__PURE__ */ jsxs(Text, { color: tpsColor, children: [
        " \xB7 ",
        meta.tps.toFixed(0),
        " tok/s"
      ] }) : null
    ] }) : null
  ] });
}
function Chip({ children }) {
  return /* @__PURE__ */ jsxs(Text, { bold: true, backgroundColor: BRASS, color: "#1a1712", children: [
    " ",
    children,
    " "
  ] });
}
function SysBlock({ title, lines, error }) {
  if (error) {
    return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: EMBER, paddingX: 1, marginTop: 1, children: [
      title ? /* @__PURE__ */ jsxs(Text, { bold: true, color: EMBER, children: [
        "\u2717 ",
        title
      ] }) : null,
      (lines || []).map((l, i) => typeof l === "string" ? /* @__PURE__ */ jsx(Text, { color: PAPER, children: l }, i) : /* @__PURE__ */ jsx(React.Fragment, { children: l }, i))
    ] });
  }
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", marginTop: 1, children: [
    title ? /* @__PURE__ */ jsxs(Text, { bold: true, color: STEEL, children: [
      "\u25C6 ",
      title
    ] }) : null,
    (lines || []).map((l, i) => /* @__PURE__ */ jsx(Box, { paddingLeft: 2, children: typeof l === "string" ? /* @__PURE__ */ jsx(Text, { color: PAPER, children: l }) : l }, i))
  ] });
}
function Picker({ title, items, filter, sel }) {
  const shown = items.slice(0, 9);
  return /* @__PURE__ */ jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: BRASS, paddingX: 1, children: [
    /* @__PURE__ */ jsx(Text, { bold: true, color: BRASS, children: title }),
    /* @__PURE__ */ jsx(Text, { color: STONE, children: filter ? `filter: ${filter}` : "type to filter \xB7 \u2191\u2193 \xB7 enter \xB7 esc" }),
    shown.map((it, i) => /* @__PURE__ */ jsxs(Text, { color: i === sel ? BRASS : PAPER, inverse: i === sel, children: [
      ` ${it.label} `,
      it.hint ? /* @__PURE__ */ jsxs(Text, { color: i === sel ? void 0 : STONE, children: [
        " ",
        it.hint
      ] }) : null
    ] }, it.value ?? it.label)),
    items.length > 9 ? /* @__PURE__ */ jsxs(Text, { color: STONE, children: [
      "\u2026 ",
      items.length - 9,
      " more, keep typing"
    ] }) : null
  ] });
}

// src/tui/api.mjs
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, readdirSync, existsSync as existsSync2, chmodSync as chmodSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
import { exec as _exec } from "node:child_process";
import { readFile as _readFile, writeFile as _writeFile } from "node:fs/promises";
import { resolve as _resolvePath } from "node:path";
var BASE2 = process.env.HERO_RUN_BASE || "https://herorunai.com";
var DIR = join2(homedir2(), ".hero-agent");
var KEY_FILE = join2(DIR, "hero-run-key.txt");
var SETTINGS_FILE = join2(DIR, "tui.json");
function loadKey() {
  if (process.env.HERO_RUN_KEY) return process.env.HERO_RUN_KEY.trim();
  try {
    return readFileSync2(KEY_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}
function saveKey(key) {
  mkdirSync2(DIR, { recursive: true });
  writeFileSync2(KEY_FILE, key.trim() + "\n", { mode: 384 });
  chmodSync2(KEY_FILE, 384);
  return KEY_FILE;
}
async function vaultBootKey() {
  try {
    const V = await Promise.resolve().then(() => (init_vault(), vault_exports));
    if (!V.vaultToken()) return null;
    const env = await V.secrets({ purpose: "hero TUI boot" });
    return env.HERO_RUN_KEY?.trim() || null;
  } catch {
    return null;
  }
}
async function vaultOps() {
  return Promise.resolve().then(() => (init_vault(), vault_exports));
}
async function keyInfo(key) {
  const r = await fetch(`${BASE2}/api/keys/info`, { headers: { "x-api-key": key } });
  if (!r.ok) throw new Error(r.status === 401 ? "That key is not valid." : `key info failed (${r.status})`);
  return r.json();
}
function loadSettings() {
  try {
    return JSON.parse(readFileSync2(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  mkdirSync2(DIR, { recursive: true });
  writeFileSync2(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}
async function listModels(key) {
  const r = await fetch(`${BASE2}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || `models failed (${r.status})`);
  return d.data.map((m) => m.id);
}
async function streamChat({ key, model, messages, maxTokens = 1200, signal, onDelta }) {
  const t0 = Date.now();
  const r = await fetch(`${BASE2}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, stream_options: { include_usage: true } }),
    signal
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error?.message || `request failed (${r.status})`);
  }
  const reader = r.body.getReader();
  const dec2 = new TextDecoder();
  let buf = "", text = "", meta = {};
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec2.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      let d;
      try {
        d = JSON.parse(payload);
      } catch {
        continue;
      }
      if (d.error) throw new Error(d.error.message || "run failed");
      const delta = d.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      if (d.usage) meta = { usage: d.usage, ...d.x_hero };
    }
  }
  return { text, seconds: (Date.now() - t0) / 1e3, resolvedModel: meta.resolved_model || model, charged: meta.charged_hero ?? null, usage: meta.usage || null, gateway: meta.gateway };
}
var RH_RPC2 = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
var MEM_ADDR2 = process.env.HERO_MEM_ADDR || "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";
function walletKeyFile() {
  if (process.env.HERO_AGENT_KEY_FILE) return process.env.HERO_AGENT_KEY_FILE;
  try {
    const dir = join2(DIR, "keys");
    const f = readdirSync(dir).filter((x) => x.endsWith(".key")).sort()[0];
    return f ? join2(dir, f) : null;
  } catch {
    return null;
  }
}
function hasWallet() {
  const f = walletKeyFile();
  return !!(f && existsSync2(f));
}
async function rpc(method, params) {
  const r = await fetch(RH_RPC2, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}
var pad = (v) => BigInt(v).toString(16).padStart(64, "0");
var _sel = null;
async function sels() {
  if (_sel) return _sel;
  const { keccak256: keccak2563, toBytes: toBytes2 } = await import("viem");
  const s = (sig) => keccak2563(toBytes2(sig)).slice(0, 10);
  _sel = { nextId: s("nextId()"), ownerOf: s("ownerOf(uint256)"), labelOf: s("labelOf(uint256)"), headOf: s("headOf(uint256)"), balanceOf: s("balanceOf(address)") };
  return _sel;
}
var call = (data) => rpc("eth_call", [{ to: MEM_ADDR2, data }, "latest"]);
async function walletInfo() {
  const kf = walletKeyFile();
  if (!kf) return null;
  const { privateKeyToAccount: privateKeyToAccount3 } = await import("viem/accounts");
  const raw = readFileSync2(kf, "utf8").trim();
  const account = privateKeyToAccount3(raw.startsWith("0x") ? raw : "0x" + raw);
  const wei = BigInt(await rpc("eth_getBalance", [account.address, "latest"]));
  return { address: account.address, eth: Number(wei) / 1e18, keyFile: kf };
}
async function listAgents(address, { maxScan = 400 } = {}) {
  const S = await sels();
  const nextId = Number(BigInt(await call(S.nextId)));
  const want = Number(BigInt(await call(S.balanceOf + pad(address)).catch(() => "0x0")));
  const me = address.toLowerCase();
  const out = [];
  const floor = Math.max(1, nextId - maxScan);
  for (let id = nextId - 1; id >= floor && (!want || out.length < want); id -= 8) {
    const ids = [];
    for (let j = id; j > id - 8 && j >= floor; j--) ids.push(j);
    const owners = await Promise.all(ids.map((i) => call(S.ownerOf + pad(i)).then((r) => "0x" + r.slice(-40)).catch(() => null)));
    const mine = ids.filter((_, k) => owners[k] && owners[k].toLowerCase() === me);
    const detail = await Promise.all(mine.map(async (i) => {
      let label = "", count = 0;
      try {
        const r = (await call(S.labelOf + pad(i))).replace(/^0x/, "");
        const len = Number(BigInt("0x" + r.slice(64, 128)));
        label = Buffer.from(r.slice(128, 128 + len * 2), "hex").toString("utf8");
      } catch {
      }
      try {
        count = Number(BigInt("0x" + (await call(S.headOf + pad(i))).replace(/^0x/, "").slice(64, 128)));
      } catch {
      }
      return { id: i, label, count };
    }));
    out.push(...detail);
  }
  return out.sort((a, b) => a.id - b.id);
}
async function memoryFor(agentId, { roomKey = null } = {}) {
  const { OnchainMemory: OnchainMemory2 } = await Promise.resolve().then(() => (init_onchain(), onchain_exports));
  const kf = walletKeyFile();
  const priv = kf && existsSync2(kf) ? readFileSync2(kf, "utf8").trim() : "0x" + randomBytes2(32).toString("hex");
  return new OnchainMemory2({ agentId, privateKey: priv.startsWith("0x") ? priv : "0x" + priv, ...roomKey ? { roomKey } : {} });
}
async function readMemory(agentId, { limit = 20 } = {}) {
  const mem = await memoryFor(agentId);
  const entries = await mem.raw();
  return entries.slice(-limit);
}
async function writeMemory(agentId, entries, { isPublic = false } = {}) {
  const mem = await memoryFor(agentId);
  const hash = isPublic ? await mem.appendPublic(entries) : await mem.append(entries);
  await mem.pub.waitForTransactionReceipt({ hash }).catch(() => {
  });
  return hash;
}
async function readChannel(agentId) {
  const room = await Promise.resolve().then(() => (init_room(), room_exports));
  const kf = walletKeyFile();
  const plain = await memoryFor(agentId);
  const entries = await plain.raw();
  let roomKey = null, membership = "none";
  if (kf && existsSync2(kf)) {
    const raw = readFileSync2(kf, "utf8").trim();
    const priv = raw.startsWith("0x") ? raw : "0x" + raw;
    const { privateKeyToAccount: privateKeyToAccount3 } = await import("viem/accounts");
    const me = privateKeyToAccount3(priv).address.toLowerCase();
    const wraps = entries.filter((e) => e.text?.startsWith(room.ROOMKEY_MARK)).map((e) => {
      try {
        return JSON.parse(e.text.slice(room.ROOMKEY_MARK.length));
      } catch {
        return null;
      }
    }).filter(Boolean).reverse();
    for (const wrap of wraps.filter((x) => String(x.to || "").toLowerCase() === me)) {
      try {
        roomKey = room.unwrapKey(priv, wrap);
        membership = "member";
        break;
      } catch {
        membership = "foreign";
      }
    }
  }
  if (!roomKey) return { entries, membership };
  const mem = await memoryFor(agentId, { roomKey });
  return { entries: await mem.raw(), membership };
}
async function sendChannel(agentId, text) {
  const { membership } = await readChannel(agentId);
  const room = membership === "member";
  const kf = walletKeyFile();
  if (!kf) throw new Error("Sending needs a wallet key. Set HERO_AGENT_KEY_FILE or run: hero-agent wallet new");
  const { privateKeyToAccount: privateKeyToAccount3 } = await import("viem/accounts");
  const raw = readFileSync2(kf, "utf8").trim();
  const from = privateKeyToAccount3(raw.startsWith("0x") ? raw : "0x" + raw).address;
  const entry = [{ role: "agent", text: "msg::" + JSON.stringify({ from, text, at: (/* @__PURE__ */ new Date()).toISOString() }) }];
  let mem;
  if (room) {
    const r = await Promise.resolve().then(() => (init_room(), room_exports));
    const plain = await memoryFor(agentId);
    const entries = await plain.raw();
    const priv = raw.startsWith("0x") ? raw : "0x" + raw;
    const wrap = entries.filter((e) => e.text?.startsWith(r.ROOMKEY_MARK)).map((e) => {
      try {
        return JSON.parse(e.text.slice(r.ROOMKEY_MARK.length));
      } catch {
        return null;
      }
    }).filter(Boolean).reverse().find((x) => String(x.to || "").toLowerCase() === from.toLowerCase());
    mem = await memoryFor(agentId, { roomKey: r.unwrapKey(priv, wrap) });
    const hash2 = await mem.appendRoom(entry);
    await mem.pub.waitForTransactionReceipt({ hash: hash2 }).catch(() => {
    });
    return { mode: "room", hash: hash2 };
  }
  mem = await memoryFor(agentId);
  const hash = await mem.appendPublic(entry);
  await mem.pub.waitForTransactionReceipt({ hash }).catch(() => {
  });
  return { mode: "public", hash };
}
var sh = (cmd, cwd) => new Promise((res) => {
  if (/\bsudo\b/.test(cmd)) return res("REFUSED: sudo is unavailable (no TTY for a password). Re-run without sudo against paths the user owns.");
  _exec(cmd, { cwd, timeout: 3e4, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
    if (err?.killed) return res("TIMED OUT after 30s: that command is too heavy. Use targeted scans instead, e.g. `du -xh -d 2 ~ 2>/dev/null | sort -hr | head` for directories or `find ~/Desktop ~/Downloads -type f -size +200M -exec du -h {} + 2>/dev/null | sort -hr | head` for files. Never scan / or run du per-file across the whole home directory.");
    res(`exit ${err?.code ?? 0}
--- stdout ---
${String(stdout).slice(0, 4e3)}
--- stderr ---
${String(stderr).slice(0, 2e3)}`);
  });
});
function localTools(cwd) {
  return [
    {
      needsApproval: true,
      def: { type: "function", function: {
        name: "shell",
        description: "Run a shell command on the user's machine (30s timeout) and return stdout/stderr/exit code.",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] }
      } },
      run: ({ cmd }) => sh(String(cmd || ""), cwd)
    },
    {
      needsApproval: false,
      def: { type: "function", function: {
        name: "read_file",
        description: "Read a text file (absolute path or relative to the working directory).",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
      } },
      run: async ({ path }) => (await _readFile(_resolvePath(cwd, String(path)), "utf8")).slice(0, 8e3)
    },
    {
      needsApproval: true,
      def: { type: "function", function: {
        name: "write_file",
        description: "Write or overwrite a text file (absolute path or relative to the working directory).",
        parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }
      } },
      run: async ({ path, content }) => {
        await _writeFile(_resolvePath(cwd, String(path)), String(content ?? ""));
        return `wrote ${path} (${String(content ?? "").length} bytes)`;
      }
    },
    {
      needsApproval: false,
      def: { type: "function", function: {
        name: "web_search",
        description: "Search the live web for current information.",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      } },
      run: null
      /* filled by agentTurn: routed through /v1 sonar on the same key */
    }
  ];
}
async function agentTurn({ key, model, messages, cwd, onTool, approve, signal, maxSteps = 6 }) {
  const tools = localTools(cwd);
  tools.find((t) => t.def.function.name === "web_search").run = async ({ query }) => {
    const r = await fetch(`${BASE2}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "perplexity/sonar-pro", max_tokens: 700, messages: [{ role: "user", content: String(query || "") }] }),
      signal
    });
    const d = await r.json();
    if (!r.ok) return `search failed: ${d.error?.message || r.status}`;
    return d.choices?.[0]?.message?.content || "(no results)";
  };
  const defs = tools.map((t) => t.def);
  const msgs = [...messages];
  let cost = 0, steps = 0;
  const call2 = async (body) => {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(18e4)]) : AbortSignal.timeout(18e4);
        return await fetch(`${BASE2}/v1/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: sig });
      } catch (e) {
        if (e.name === "AbortError" && signal?.aborted) throw e;
        lastErr = e;
        await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
      }
    }
    throw new Error(`network: ${lastErr?.cause?.code || lastErr?.message || "fetch failed"} (3 attempts)`);
  };
  for (let hop = 0; hop <= maxSteps; hop++) {
    const last = hop === maxSteps;
    const r = await call2({ model, messages: msgs, max_tokens: 1600, ...last ? {} : { tools: defs } });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || `request failed (${r.status})`);
    const msg = d.choices?.[0]?.message || {};
    cost += Number(msg.x_hero?.charged_hero || d.x_hero?.charged_hero || 0);
    if (!msg.tool_calls?.length) return { text: (msg.content || "").trim(), costHero: cost, steps, model: msg.x_hero?.resolved_model || d.x_hero?.resolved_model };
    msgs.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
    for (const call3 of msg.tool_calls) {
      const tool = tools.find((t) => t.def.function.name === call3.function.name);
      let args = {};
      try {
        args = JSON.parse(call3.function.arguments || "{}");
      } catch {
      }
      steps++;
      onTool?.(call3.function.name, args);
      let out;
      if (!tool) out = `unknown tool: ${call3.function.name}`;
      else if (tool.needsApproval && !await approve(call3.function.name, args)) out = "The user declined this action. Continue without it, or explain what you need.";
      else out = await tool.run(args).catch((e) => `tool error: ${e.message}`);
      msgs.push({ role: "tool", tool_call_id: call3.id, content: String(out).slice(0, 6e3) });
    }
  }
}
async function cerebrasModels() {
  const j = await (await fetch(`${BASE2}/api/models`)).json();
  return (j.models || []).filter((m) => m.kind === "text" && (m.gateways || []).includes("Cerebras")).map((m) => ({ id: m.id, hero: m.hero }));
}

// src/tui/universe.mjs
var UNIVERSE_MODEL = process.env.HERO_UNIVERSE_MODEL || "auto";
var TEACHER_SYS = `You are the Universe: the teacher that holds everything the frontier knows. A student agent (a small model) just attempted a task in a user's terminal, with tools. Distill ONE durable lesson that would make the student better at FUTURE tasks.
Rules:
- Generalize. A lesson is a transferable rule, never task-specific trivia.
- Imperative voice, under 50 words, starting with "When".
- Prefer lessons about method: tool choice, verification, avoiding waste, honesty about uncertainty.
- If the attempt was already close to optimal and no durable lesson exists, reply with exactly: NO_LESSON`;
async function universeReview({ key, task, trace, answer, model = UNIVERSE_MODEL, signal }) {
  const toolLines = (trace || []).map((t) => `- ${t.name}(${JSON.stringify(t.args).slice(0, 140)})${t.note ? ` \u2192 ${t.note}` : ""}`).join("\n") || "(no tools used)";
  const r = await fetch(`${BASE2}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal,
    body: JSON.stringify({ model, max_tokens: 200, messages: [
      { role: "system", content: TEACHER_SYS },
      { role: "user", content: `TASK: ${task}

TOOL TRACE:
${toolLines}

STUDENT'S FINAL ANSWER:
${String(answer || "").slice(0, 1500)}` }
    ] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error?.message || `universe review failed (${r.status})`);
  const text = (d.choices?.[0]?.message?.content || "").trim();
  const cost = Number(d.choices?.[0]?.message?.x_hero?.charged_hero || d.x_hero?.charged_hero || 0);
  if (!text || text.includes("NO_LESSON")) return { lesson: null, cost };
  return { lesson: text.replace(/^lesson::\s*/i, "").trim(), cost };
}
async function mintLesson(agentId, lesson) {
  return writeMemory(agentId, [{ role: "agent", text: `lesson:: ${lesson}` }]);
}
async function recallLessons(agentId, { max = 12 } = {}) {
  try {
    const entries = await readMemory(agentId, { limit: 80 });
    const texts = [];
    for (const e of entries || []) {
      for (const m of String(e?.text || "").matchAll(/lesson::\s*([^\n]+)/g)) texts.push(m[1].trim());
    }
    return [...new Set(texts)].slice(-max);
  } catch {
    return [];
  }
}
function lessonsBlock(lessons) {
  if (!lessons?.length) return "";
  return `

=== LESSONS you have earned from past attempts (follow them) ===
${lessons.map((l) => `- ${l}`).join("\n")}`;
}

// src/tui/app.jsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var COMMANDS = [
  { name: "/help", desc: "commands and keys" },
  { name: "/model", desc: "pick the model (auto routes per call)" },
  { name: "/models", desc: "list every model on the network" },
  { name: "/balance", desc: "key balance and wallet gas" },
  { name: "/agents", desc: "your on-chain agents" },
  { name: "/agent", desc: "set the working agent: /agent 26" },
  { name: "/recall", desc: "read the agent's recent memory" },
  { name: "/remember", desc: "mint a note (or the last exchange) to memory" },
  { name: "/channel", desc: "read a channel: /channel 25" },
  { name: "/send", desc: "message a channel: /send 25 hello" },
  { name: "/stats", desc: "this session: turns, tokens, speed, spend" },
  { name: "/key", desc: "set a new hr_live_ inference key" },
  { name: "/vault", desc: "wallet secrets: ls \xB7 set N=V \xB7 get N \xB7 rm N \xB7 login <token>" },
  { name: "/tools", desc: "toggle agent mode (shell, files, web search with y/n approval)" },
  { name: "/auto", desc: "auto-approve every tool, no prompts (this session)" },
  { name: "/turbo", desc: "pick any Cerebras-served model at wafer speed" },
  { name: "/learn", desc: "Universe reviews the last turn, mints a lesson:: to your agent (auto = every turn)" },
  { name: "/clear", desc: "clear the conversation" },
  { name: "/exit", desc: "leave" }
];
var SPARK = " \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588";
var sparkline = (vals, width = 24) => {
  const v = vals.slice(-width);
  if (!v.length) return "";
  const max = Math.max(...v, 1);
  return v.map((x) => SPARK[Math.min(8, Math.round(x / max * 8))]).join("");
};
var fmtHero = (n) => n == null ? "?" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`;
function App({ version: version2 }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns || 80;
  const [items, setItems] = useState2([]);
  const idRef = useRef(0);
  const push = useCallback((it) => setItems((prev) => [...prev, { id: ++idRef.current, ...it }]), []);
  const settings = useRef(loadSettings());
  const [key, setKey] = useState2(loadKey);
  const [model, setModel] = useState2(settings.current.model || "auto");
  const [agentId, setAgentId] = useState2(settings.current.agentId || null);
  const [bal, setBal] = useState2(null);
  const [spent, setSpent] = useState2(0);
  const convo = useRef([]);
  const [input, setInput] = useState2("");
  const [cursor, setCursor] = useState2(0);
  const histRef = useRef({ list: [], idx: -1, draft: "" });
  const [live, setLive] = useState2(null);
  const [thinking, setThinking] = useState2(null);
  const statsRef = useRef({ turns: 0, tokens: 0, seconds: 0, tps: [] });
  const abortRef = useRef(null);
  const [overlay, setOverlay] = useState2(null);
  const [setup, setSetup] = useState2(!loadKey());
  const [toolsOn, setToolsOn] = useState2(true);
  const [pendingTool, setPendingTool] = useState2(null);
  const alwaysRef = useRef(/* @__PURE__ */ new Set());
  const autoRef = useRef(false);
  const preTurboRef = useRef(null);
  const lastTurnRef = useRef(null);
  const lessonsRef = useRef({ list: [], loadedFor: null });
  const learnAutoRef = useRef(false);
  const slashOpen = !setup && !overlay && input.startsWith("/") && !input.includes(" ");
  const slashItems = slashOpen ? COMMANDS.filter((c) => c.name.startsWith(input.trim())) : [];
  const [slashSel, setSlashSel] = useState2(0);
  useEffect2(() => {
    setSlashSel(0);
  }, [input]);
  const refreshBal = useCallback(async (k = key) => {
    if (!k) return;
    try {
      const info = await keyInfo(k);
      setBal(info.balance ?? info.remaining ?? null);
    } catch {
    }
  }, [key]);
  useEffect2(() => {
    refreshBal();
  }, [refreshBal]);
  useEffect2(() => {
    process.stdout.write("\x1B[?2004h");
    return () => process.stdout.write("\x1B[?2004l");
  }, []);
  useEffect2(() => {
    let live2 = true;
    (async () => {
      try {
        const cur = loadKey();
        const curBal = cur ? (await keyInfo(cur).catch(() => null))?.balance ?? null : null;
        if (live2 && curBal != null) setBal(curBal);
        if (cur && (curBal == null || curBal >= 2e3)) return;
        const vk = await vaultBootKey();
        if (!live2 || !vk || vk === cur) return;
        const vBal = (await keyInfo(vk).catch(() => null))?.balance ?? null;
        if (vBal == null || curBal != null && vBal <= curBal) return;
        setKey(vk);
        setSetup(false);
        setBal(vBal);
        sys("vault", cur ? `Saved key is nearly empty (${fmtHero(curBal)} $HERO) \u2014 switched to your wallet vault key: ${fmtHero(vBal)} $HERO ready.` : "HERO_RUN_KEY loaded from your wallet vault. Zero local config.");
      } catch {
      }
    })();
    return () => {
      live2 = false;
    };
  }, []);
  const sys = useCallback((title, lines, error = false) => push({ kind: "sys", title, lines: Array.isArray(lines) ? lines : [String(lines)], error }), [push]);
  const ask = useCallback(async (prompt) => {
    convo.current.push({ role: "user", content: prompt });
    push({ kind: "user", text: prompt });
    const startedAt = Date.now();
    setThinking({ startedAt });
    setLive("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (toolsOn) {
        if (agentId && lessonsRef.current.loadedFor !== agentId) {
          lessonsRef.current = { list: await recallLessons(agentId).catch(() => []), loadedFor: agentId };
          if (lessonsRef.current.list.length) sys("universe", `${lessonsRef.current.list.length} earned lesson(s) loaded from agent #${agentId}.`);
        }
        const turnTrace = [];
        lastTurnRef.current = { task: prompt, trace: turnTrace, answer: "" };
        const sysPrompt = lessonsBlock(lessonsRef.current.list) + `

You are Hero, a terminal agent on the user's macOS machine. Working directory: ${process.cwd()}. You have tools: shell (run commands, 30s limit), read_file, write_file, web_search. LOOK instead of guessing: when asked about files, the system, or anything on this machine, use the tools. Shell discipline: append 2>/dev/null to noisy commands; for disk usage prefer du -xh -d 2 and targeted find with -size +200M; NEVER scan / or the whole home tree file-by-file; no sudo. Be concise; answer in markdown; never invent command output.`;
        const out2 = await agentTurn({
          key,
          model,
          cwd: process.cwd(),
          signal: ctrl.signal,
          messages: [{ role: "system", content: sysPrompt }, ...convo.current.slice(-24)],
          onTool: (name, args) => {
            turnTrace.push({ name, args });
            push({ kind: "sys", title: null, lines: [`\xB7 ${name}(${JSON.stringify(args).slice(0, 90)})`], error: false });
            setThinking({ startedAt: Date.now(), note: name });
          },
          approve: (name, args) => new Promise((resolveA) => {
            if (autoRef.current || alwaysRef.current.has(name)) return resolveA(true);
            setPendingTool({ name, args, resolve: resolveA });
          })
        });
        convo.current.push({ role: "assistant", content: out2.text });
        const secs = (Date.now() - startedAt) / 1e3;
        const st2 = statsRef.current;
        st2.turns += 1;
        st2.seconds += secs;
        push({
          kind: "assistant",
          text: out2.text,
          meta: { model: out2.model || model, cost: out2.costHero ? `${fmtHero(out2.costHero)} $HERO` : "", secs: secs.toFixed(1), tps: null }
        });
        if (out2.costHero) {
          setSpent((s) => s + out2.costHero);
          setBal((b) => b == null ? b : Math.max(0, b - out2.costHero));
        }
        lastTurnRef.current.answer = out2.text;
        if (learnAutoRef.current && agentId) {
          universeReview({ key, task: prompt, trace: turnTrace, answer: out2.text }).then(async ({ lesson, cost }) => {
            if (cost) {
              setSpent((s) => s + cost);
              setBal((b) => b == null ? b : Math.max(0, b - cost));
            }
            if (!lesson) return;
            const hash = await mintLesson(agentId, lesson);
            lessonsRef.current.list.push(lesson);
            sys("universe", [`Lesson minted to agent #${agentId}:`, `  ${lesson}`, `tx ${hash.slice(0, 14)}\u2026`]);
          }).catch(() => {
          });
        }
        return;
      }
      let first = true;
      const out = await streamChat({
        key,
        model,
        messages: convo.current.slice(-24),
        signal: ctrl.signal,
        maxTokens: settings.current.maxTokens || 1200,
        onDelta: (d) => {
          if (first) {
            setThinking(null);
            first = false;
          }
          setLive((t) => (t ?? "") + d);
        }
      });
      convo.current.push({ role: "assistant", content: out.text });
      const toks = out.usage?.completion_tokens || 0;
      const tps = toks && out.seconds > 0 ? toks / out.seconds : null;
      const st = statsRef.current;
      st.turns += 1;
      st.tokens += toks;
      st.seconds += out.seconds;
      if (tps) st.tps.push(tps);
      push({
        kind: "assistant",
        text: out.text,
        meta: { model: out.resolvedModel, cost: out.charged != null ? `${fmtHero(out.charged)} $HERO` : "", secs: out.seconds.toFixed(1), tps }
      });
      if (out.charged) {
        setSpent((s) => s + out.charged);
        setBal((b) => b == null ? b : Math.max(0, b - out.charged));
      }
    } catch (e) {
      if (e.name === "AbortError") sys("cancelled", "Response cancelled. The partial answer is discarded.", false);
      else if (String(e.message).match(/balance|credit|insufficient|402|empty/i)) {
        const vk = await vaultBootKey().catch(() => null);
        const vBal = vk && vk !== key ? (await keyInfo(vk).catch(() => null))?.balance ?? null : null;
        if (vBal != null && vBal >= 2e3) {
          setKey(vk);
          setBal(vBal);
          sys("vault", `That key is out of credits \u2014 switched to your wallet vault key (${fmtHero(vBal)} $HERO). Send that again.`);
        } else sys("inference error", e.message + `  \xB7  top up at ${BASE2}/keys`, true);
      } else sys("inference error", e.message, true);
      convo.current.pop();
    } finally {
      setThinking(null);
      setLive(null);
      abortRef.current = null;
    }
  }, [key, model, toolsOn, agentId, push, sys]);
  const runCommand = useCallback(async (raw) => {
    const [cmd, ...args] = raw.trim().split(/\s+/);
    const arg = args.join(" ");
    const withSpin = async (note, fn) => {
      setThinking({ startedAt: Date.now(), note });
      try {
        return await fn();
      } finally {
        setThinking(null);
      }
    };
    switch (cmd) {
      case "/help":
        sys("Hero Run terminal", [
          ...COMMANDS.map((c) => `${c.name.padEnd(10)} ${c.desc}`),
          "",
          "enter sends \xB7 esc cancels a response \xB7 \u2191\u2193 input history",
          "chat is paid per call from your hr_live_ key, no subscription"
        ]);
        break;
      case "/stats": {
        const st = statsRef.current;
        const avg = st.seconds > 0 ? st.tokens / st.seconds : 0;
        sys("session", [
          `turns    ${st.turns}`,
          `tokens   ${st.tokens.toLocaleString()}`,
          `time     ${st.seconds.toFixed(1)}s in inference`,
          `speed    ${avg.toFixed(1)} tok/s avg   ${sparkline(st.tps)}`,
          `spend    ${fmtHero(spent)} $HERO this session`
        ]);
        break;
      }
      case "/exit":
        exit();
        setTimeout(() => process.exit(0), 30);
        break;
      case "/clear":
        convo.current = [];
        setItems([]);
        sys("cleared", "Conversation reset (the model forgets; your minted memories do not).");
        break;
      case "/key":
        setSetup(true);
        break;
      case "/model": {
        if (arg) {
          setModel(arg);
          saveSettings({ model: arg });
          sys("model", `Model set to ${arg}.`);
          break;
        }
        await withSpin("Fetching models", async () => {
          const ids = ["auto", ...(await listModels(key)).filter((m) => m !== "auto")];
          setOverlay({
            title: "Pick a model",
            filter: "",
            sel: 0,
            all: ids.map((m) => ({ label: m, value: m, hint: m === "auto" ? "routes per call" : "" })),
            onPick: (v) => {
              setModel(v);
              saveSettings({ model: v });
              sys("model", `Model set to ${v}.`);
            }
          });
        }).catch((e) => sys("models", e.message, true));
        break;
      }
      case "/models":
        await withSpin("Fetching models", async () => {
          const ids = await listModels(key);
          const lines = [];
          let line = "";
          for (const id of ids) {
            if (line && (line + "  " + id).length > Math.max(40, cols - 8)) {
              lines.push(line);
              line = id;
            } else line = line ? line + "  " + id : id;
          }
          if (line) lines.push(line);
          sys(`${ids.length} models \xB7 /model to pick`, lines);
        }).catch((e) => sys("models", e.message, true));
        break;
      case "/balance":
        await withSpin("Checking balances", async () => {
          const info = await keyInfo(key).catch(() => null);
          const wal = await walletInfo().catch(() => null);
          sys("balance", [
            info ? `key      ${fmtHero(info.balance ?? info.remaining)} $HERO remaining${info.spent != null ? ` (${fmtHero(info.spent)} spent)` : ""}` : "key      unreadable",
            wal ? `wallet   ${wal.address}` : "wallet   none configured (HERO_AGENT_KEY_FILE)",
            wal ? `gas      ${wal.eth.toFixed(6)} ETH on Robinhood Chain (~${Math.floor(wal.eth / 4e-6)} memory writes)` : "",
            `session  ${fmtHero(spent)} $HERO spent`
          ].filter(Boolean));
          if (info) setBal(info.balance ?? info.remaining ?? null);
        });
        break;
      case "/agents":
        await withSpin("Walking the contract", async () => {
          const wal = await walletInfo();
          if (!wal) return sys("agents", "No wallet key. Set HERO_AGENT_KEY_FILE or run: hero-agent wallet new", true);
          const list = await listAgents(wal.address);
          if (!list.length) return sys("agents", "This wallet owns no agents yet. Mint one: hero-agent wallet mint-agent");
          sys(`${list.length} agents on ${wal.address.slice(0, 8)}\u2026`, list.map((a) => `#${String(a.id).padEnd(4)} ${(a.label || "unlabeled").padEnd(24)} ${a.count} checkpoints${a.id === Number(agentId) ? "   \u2190 active" : ""}`));
        }).catch((e) => sys("agents", e.message, true));
        break;
      case "/agent": {
        const id = Number(String(arg).replace(/[^0-9]/g, ""));
        if (!Number.isFinite(id) || id < 1) {
          sys("agent", "Usage: /agent <id>", true);
          break;
        }
        setAgentId(id);
        saveSettings({ agentId: id });
        sys("agent", `Working agent is now #${id}. /recall reads it, /remember writes to it.`);
        break;
      }
      case "/recall":
        if (!agentId) {
          sys("recall", "Set an agent first: /agent <id>", true);
          break;
        }
        await withSpin("Reading the chain", async () => {
          const entries = await readMemory(agentId, { limit: Number(arg) || 15 });
          if (!entries.length) return sys(`agent #${agentId}`, "No memories yet.");
          sys(`agent #${agentId} \xB7 last ${entries.length}`, entries.map((e) => {
            const t = (e.text || "").replace(/\s+/g, " ");
            return `${(e.role || "?").padEnd(6)} ${t.length > 110 ? t.slice(0, 110) + "\u2026" : t}`;
          }));
        }).catch((e) => sys("recall", e.message, true));
        break;
      case "/remember": {
        if (!agentId) {
          sys("remember", "Set an agent first: /agent <id>", true);
          break;
        }
        const lastQ = [...convo.current].reverse().find((m) => m.role === "user");
        const lastA = [...convo.current].reverse().find((m) => m.role === "assistant");
        const entries = arg ? [{ role: "user", text: "note::" + arg }] : lastQ && lastA ? [{ role: "user", text: lastQ.content }, { role: "agent", text: lastA.content }] : null;
        if (!entries) {
          sys("remember", "Nothing to save yet. Chat first, or /remember <note>.", true);
          break;
        }
        await withSpin("Minting to Robinhood Chain", async () => {
          const hash = await writeMemory(agentId, entries);
          sys("minted", [`${entries.length} entr${entries.length === 1 ? "y" : "ies"} sealed to agent #${agentId}.`, `tx ${hash}`]);
        }).catch((e) => sys("remember", e.message, true));
        break;
      }
      case "/channel": {
        const id = Number(arg || agentId);
        if (!Number.isFinite(id) || id < 1) {
          sys("channel", "Usage: /channel <agent id>", true);
          break;
        }
        await withSpin("Reading the channel", async () => {
          const { entries, membership } = await readChannel(id);
          const msgs = entries.filter((e) => e.text?.startsWith("msg::")).slice(-12).map((e) => {
            try {
              const m = JSON.parse(e.text.slice(5));
              return `${e.room ? "\u{1F512}" : "\xB7"} ${String(m.from).slice(0, 10)}  ${m.text.slice(0, 100)}`;
            } catch {
              return null;
            }
          }).filter(Boolean);
          sys(
            `channel #${id} \xB7 ${membership === "member" ? "group member \u{1F512}" : membership === "foreign" ? "invited on another key" : "public view"}`,
            msgs.length ? msgs : ["No messages yet. /send " + id + " <text>"]
          );
        }).catch((e) => sys("channel", e.message, true));
        break;
      }
      case "/send": {
        const id = Number(args[0]);
        const text = args.slice(1).join(" ");
        if (!Number.isFinite(id) || !text) {
          sys("send", "Usage: /send <agent id> <message>", true);
          break;
        }
        await withSpin("Writing on-chain", async () => {
          const r = await sendChannel(id, text);
          sys("sent", [`Message written to channel #${id} as ${r.mode === "room" ? "a members-only room entry \u{1F512}" : "a public entry"}.`, `tx ${r.hash}`]);
        }).catch((e) => sys("send", String(e.message).includes("not authorized") ? "The contract rejected the write. Ask the owner to approve your wallet." : e.message, true));
        break;
      }
      case "/learn": {
        if (rest[0] === "auto") {
          learnAutoRef.current = !learnAutoRef.current;
          sys("universe", learnAutoRef.current ? "Auto-learning ON: the Universe reviews every agent turn and mints what it teaches." : "Auto-learning off.");
          break;
        }
        const lt = lastTurnRef.current;
        if (!lt) {
          sys("universe", "Nothing to learn from yet \u2014 run an agent-mode turn first.", true);
          break;
        }
        if (!agentId) {
          sys("universe", "Pick a memory agent first: /agents then /agent <id>.", true);
          break;
        }
        await withSpin("The Universe reviews the attempt", async () => {
          const { lesson, cost } = await universeReview({ key, task: lt.task, trace: lt.trace, answer: lt.answer });
          if (cost) {
            setSpent((s) => s + cost);
            setBal((b) => b == null ? b : Math.max(0, b - cost));
          }
          if (!lesson) {
            sys("universe", "No durable lesson in that turn. The Hero did fine.");
            return;
          }
          const ok = await new Promise((resolveA) => setPendingTool({ name: "mint lesson", args: { lesson }, resolve: resolveA }));
          if (!ok) {
            sys("universe", "Lesson rejected at your gate. Nothing touched the chain.");
            return;
          }
          const hash = await mintLesson(agentId, lesson);
          lessonsRef.current.list.push(lesson);
          sys("universe", [`Lesson minted to agent #${agentId}:`, `  ${lesson}`, `tx ${hash.slice(0, 14)}\u2026 \xB7 the Hero starts every future session knowing this.`]);
        }).catch((e) => sys("universe", e.message, true));
        break;
      }
      case "/auto": {
        autoRef.current = !autoRef.current;
        sys("auto", autoRef.current ? "Auto mode ON: every tool runs without asking, shell included. /auto again to turn it off." : "Auto mode OFF: shell and write_file ask again.");
        break;
      }
      case "/turbo": {
        await withSpin("Fetching Cerebras models", async () => {
          const ms = await cerebrasModels();
          if (!ms.length) {
            sys("turbo", "The catalog lists no Cerebras-served models right now.", true);
            return;
          }
          const onTurbo = model.endsWith("@cerebras");
          setOverlay({
            title: "Turbo \u2014 Cerebras wafer speed",
            filter: "",
            sel: 0,
            all: [
              ...onTurbo ? [{ label: "turbo off", value: "__off", hint: `back to ${preTurboRef.current || "auto"}` }] : [],
              ...ms.map((m) => ({ label: `${m.id}@cerebras`, value: `${m.id}@cerebras`, hint: `\u2B21 ${Math.round(m.hero).toLocaleString()}` }))
            ],
            onPick: (v) => {
              if (v === "__off") {
                const backTo = preTurboRef.current || "auto";
                setModel(backTo);
                saveSettings({ model: backTo });
                sys("turbo", `Turbo off. Back to ${backTo}.`);
                return;
              }
              if (!model.endsWith("@cerebras")) preTurboRef.current = model;
              setModel(v);
              saveSettings({ model: v });
              sys("turbo", `Turbo ON: ${v} (~sub-second first token). /turbo \u2192 "turbo off" to restore.`);
            }
          });
        }).catch((e) => sys("turbo", e.message, true));
        break;
      }
      case "/tools": {
        setToolsOn((t) => !t);
        sys("tools", toolsOn ? "Agent mode OFF. Plain streamed chat, no tools." : "Agent mode ON. shell and write_file ask before running; reads and web search are automatic.");
        break;
      }
      case "/vault": {
        const sub = args[0];
        const V = await vaultOps();
        const mask = (v) => v.length <= 8 ? "\u2022\u2022\u2022\u2022" : v.slice(0, 4) + "\u2026" + v.slice(-2);
        try {
          if (sub === "ls" || !sub) {
            const names = await V.listSecrets();
            sys("vault", names.length ? names : ["(empty \u2014 /vault set NAME=value)"]);
          } else if (sub === "set") {
            const pairs = args.slice(1).filter((p) => p.includes("="));
            if (!pairs.length) {
              sys("vault", "Usage: /vault set NAME=value [NAME2=value2]", true);
              break;
            }
            for (const p of pairs) {
              const i = p.indexOf("=");
              await V.setSecret(p.slice(0, i), p.slice(i + 1));
            }
            sys("vault", pairs.map((p) => `\u2713 ${p.slice(0, p.indexOf("="))} sealed to the wallet vault`));
          } else if (sub === "get") {
            if (!args[1]) {
              sys("vault", "Usage: /vault get NAME", true);
              break;
            }
            const env = await V.secrets({ purpose: `hero TUI /vault get ${args[1]}` });
            if (!(args[1] in env)) {
              sys("vault", `${args[1]} is not in the vault.`, true);
              break;
            }
            sys("vault", [`${args[1]} = ${env[args[1]]}`, "(shown in scrollback \u2014 /clear when done)"]);
          } else if (sub === "rm") {
            if (!args[1]) {
              sys("vault", "Usage: /vault rm NAME", true);
              break;
            }
            await V.deleteSecret(args[1]);
            sys("vault", `\u2713 removed ${args[1]}`);
          } else if (sub === "login") {
            if (!args[1]) {
              sys("vault", ["Usage: /vault login <hvt1.\u2026 token>", `Mint one at ${BASE2}/locker \u2192 Environment \u2192 Connect a machine.`], true);
              break;
            }
            const { address } = await V.vaultLogin({ token: args[1] });
            sys("vault", [`\u2713 machine logged in for ${mask(address)}`, "This token decrypts your vault. It cannot sign, spend, or mint."]);
          } else sys("vault", "Subcommands: ls \xB7 set NAME=value \xB7 get NAME \xB7 rm NAME \xB7 login <token>", true);
        } catch (e) {
          sys("vault", e.message, true);
        }
        break;
      }
      default:
        sys(cmd, "Unknown command. /help lists everything.", true);
    }
  }, [key, model, agentId, spent, exit, sys, push]);
  const pasteRef = useRef(null);
  useInput((ch, k) => {
    {
      let chunk = ch || "";
      if (pasteRef.current !== null || chunk.includes("[200~")) {
        if (pasteRef.current === null) {
          pasteRef.current = "";
          chunk = chunk.split("[200~").slice(1).join("[200~");
        }
        let done = false;
        const end = chunk.indexOf("[201~");
        if (end >= 0) {
          pasteRef.current += chunk.slice(0, end).replace(/\x1b$/, "");
          done = true;
        } else pasteRef.current += chunk;
        if (done) {
          const text = pasteRef.current.replace(/\x1b\[?20[01]~?/g, "").replace(/[\r\n]+/g, " ").replace(/[\x00-\x1f]/g, "").trim();
          pasteRef.current = null;
          if (text) {
            setInput((v) => v.slice(0, cursor) + text + v.slice(cursor));
            setCursor((c) => c + text.length);
          }
        }
        return;
      }
    }
    if (pendingTool) {
      const c = (ch || "").toLowerCase();
      if (c === "y" || k.return) {
        pendingTool.resolve(true);
        setPendingTool(null);
      } else if (c === "a") {
        alwaysRef.current.add(pendingTool.name);
        pendingTool.resolve(true);
        setPendingTool(null);
      } else if (c === "n" || k.escape) {
        pendingTool.resolve(false);
        setPendingTool(null);
      }
      return;
    }
    if (overlay) {
      const filtered = overlay.all.filter((it) => it.label.toLowerCase().includes(overlay.filter.toLowerCase()));
      if (k.escape) return setOverlay(null);
      if (k.return) {
        const pick = filtered[overlay.sel];
        setOverlay(null);
        if (pick) overlay.onPick(pick.value);
        return;
      }
      if (k.upArrow) return setOverlay({ ...overlay, sel: Math.max(0, overlay.sel - 1) });
      if (k.downArrow) return setOverlay({ ...overlay, sel: Math.min(Math.min(filtered.length, 9) - 1, overlay.sel + 1) });
      if (k.backspace || k.delete) return setOverlay({ ...overlay, filter: overlay.filter.slice(0, -1), sel: 0 });
      if (ch && !k.ctrl && !k.meta) return setOverlay({ ...overlay, filter: overlay.filter + ch, sel: 0 });
      return;
    }
    if (k.escape) {
      if (abortRef.current) abortRef.current.abort();
      return;
    }
    if (thinking || live != null) return;
    if (slashOpen && slashItems.length) {
      if (k.upArrow) return setSlashSel((s) => Math.max(0, s - 1));
      if (k.downArrow) return setSlashSel((s) => Math.min(slashItems.length - 1, s + 1));
      if (k.tab) {
        const c = slashItems[slashSel];
        setInput(c.name + " ");
        setCursor(c.name.length + 1);
        return;
      }
    }
    if (k.return) {
      const value = (slashOpen && slashItems.length && input.trim() !== slashItems[slashSel].name ? slashItems[slashSel].name : input).trim();
      if (!value) return;
      setInput("");
      setCursor(0);
      if (setup) {
        submitSetup(value);
        return;
      }
      const h = histRef.current;
      h.list.push(value);
      h.idx = -1;
      h.draft = "";
      if (value.startsWith("/")) runCommand(value);
      else ask(value);
      return;
    }
    if (k.upArrow || k.downArrow) {
      const h = histRef.current;
      if (!h.list.length) return;
      if (k.upArrow) {
        if (h.idx === -1) {
          h.draft = input;
          h.idx = h.list.length - 1;
        } else h.idx = Math.max(0, h.idx - 1);
      } else {
        if (h.idx === -1) return;
        h.idx = h.idx + 1 > h.list.length - 1 ? -1 : h.idx + 1;
      }
      const v = h.idx === -1 ? h.draft : h.list[h.idx];
      setInput(v);
      setCursor(v.length);
      return;
    }
    if (k.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (k.rightArrow) return setCursor((c) => Math.min(input.length, c + 1));
    if (k.ctrl && ch === "a") return setCursor(0);
    if (k.ctrl && ch === "e") return setCursor(input.length);
    if (k.ctrl && ch === "u") {
      setInput("");
      setCursor(0);
      return;
    }
    if (k.backspace || k.delete) {
      if (cursor === 0) return;
      setInput((v) => v.slice(0, cursor - 1) + v.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }
    if (ch && !k.ctrl && !k.meta) {
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) {
        const before = ch.slice(0, nl);
        const value = (input.slice(0, cursor) + before + input.slice(cursor)).trim();
        setInput("");
        setCursor(0);
        if (!value) return;
        if (setup) {
          submitSetup(value);
          return;
        }
        const h = histRef.current;
        h.list.push(value);
        h.idx = -1;
        h.draft = "";
        if (value.startsWith("/")) runCommand(value);
        else ask(value);
        return;
      }
      const clean = ch.replace(/[\x00-\x1f]/g, "");
      if (!clean) return;
      setInput((v) => v.slice(0, cursor) + clean + v.slice(cursor));
      setCursor((c) => c + clean.length);
    }
  });
  const submitSetup = useCallback(async (candidate) => {
    candidate = candidate.trim();
    if (!candidate.startsWith("hr_")) {
      sys("key", "That does not look like an hr_live_ key. Mint one at " + BASE2 + "/keys", true);
      return;
    }
    setThinking({ startedAt: Date.now(), note: "Checking the key" });
    try {
      const info = await keyInfo(candidate);
      const path = saveKey(candidate);
      setKey(candidate);
      setSetup(false);
      setBal(info.balance ?? info.remaining ?? null);
      sys("welcome", [
        `Key saved to ${path} (0600).`,
        `${fmtHero(info.balance ?? info.remaining)} $HERO ready. Every reply is paid per call, no subscription.`,
        "Say something, or /help."
      ]);
    } catch (e) {
      sys("key", e.message, true);
    } finally {
      setThinking(null);
    }
  }, [sys]);
  const bannerInHistory = items.length > 0;
  const filteredOverlay = overlay ? overlay.all.filter((it) => it.label.toLowerCase().includes(overlay.filter.toLowerCase())) : [];
  return /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", children: [
    /* @__PURE__ */ jsx2(Static, { items, children: (it) => {
      if (it.kind === "user") return /* @__PURE__ */ jsx2(UserLine, { text: it.text }, it.id);
      if (it.kind === "assistant") return /* @__PURE__ */ jsx2(AssistantBlock, { text: it.text, meta: it.meta }, it.id);
      return /* @__PURE__ */ jsx2(SysBlock, { title: it.title, lines: it.lines, error: it.error }, it.id);
    } }),
    !bannerInHistory && /* @__PURE__ */ jsx2(Banner, { animated: true, version: version2 }),
    !bannerInHistory && !setup && /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", borderStyle: "round", borderColor: MINERAL, paddingX: 1, marginBottom: 1, children: [
      /* @__PURE__ */ jsxs2(Text2, { children: [
        /* @__PURE__ */ jsx2(Chip, { children: "HERO" }),
        /* @__PURE__ */ jsx2(Text2, { color: PAPER, children: " Chat is paid in $HERO per call and funds one frontier open training run." })
      ] }),
      /* @__PURE__ */ jsx2(Text2, { color: STONE, children: "  /help commands \xB7 /model pick a brain \xB7 /agents your on-chain memory" })
    ] }),
    setup && /* @__PURE__ */ jsxs2(Box2, { flexDirection: "column", borderStyle: "round", borderColor: BRASS, paddingX: 1, marginBottom: 1, children: [
      /* @__PURE__ */ jsx2(Text2, { bold: true, color: BRASS, children: "Connect your inference key" }),
      /* @__PURE__ */ jsxs2(Text2, { color: PAPER, children: [
        "Paste an hr_live_ key and press enter. Mint one at ",
        BASE2,
        "/keys."
      ] }),
      /* @__PURE__ */ jsx2(Text2, { color: STONE, children: "Saved to ~/.hero-agent/hero-run-key.txt, permissions 0600, never sent anywhere but herorunai.com." })
    ] }),
    live != null && live !== "" && /* @__PURE__ */ jsxs2(Box2, { marginTop: 1, children: [
      /* @__PURE__ */ jsx2(Text2, { color: MINERAL, children: "\u273B " }),
      /* @__PURE__ */ jsx2(Box2, { flexDirection: "column", flexGrow: 1, children: /* @__PURE__ */ jsx2(Md, { text: live }) })
    ] }),
    thinking && /* @__PURE__ */ jsx2(Box2, { marginTop: 1, children: /* @__PURE__ */ jsx2(Thinking, { startedAt: thinking.startedAt, note: thinking.note }) }),
    overlay && /* @__PURE__ */ jsx2(Picker, { title: overlay.title, items: filteredOverlay, filter: overlay.filter, sel: overlay.sel }),
    pendingTool && /* @__PURE__ */ jsxs2(Box2, { borderStyle: "round", borderColor: BRASS, paddingX: 1, marginTop: 1, flexDirection: "column", children: [
      /* @__PURE__ */ jsxs2(Text2, { bold: true, color: BRASS, children: [
        pendingTool.name,
        " wants to run"
      ] }),
      /* @__PURE__ */ jsxs2(Text2, { color: PAPER, wrap: "truncate-end", children: [
        "  ",
        pendingTool.name === "shell" ? String(pendingTool.args.cmd || "") : pendingTool.args.lesson ? String(pendingTool.args.lesson) : JSON.stringify(pendingTool.args).slice(0, 200)
      ] }),
      /* @__PURE__ */ jsx2(Text2, { color: STONE, children: "  (y)es once \xB7 (a)lways this session \xB7 (n)o" })
    ] }),
    !overlay && /* @__PURE__ */ jsxs2(Box2, { borderStyle: "round", borderColor: thinking ? BRASS : STONE, paddingX: 1, marginTop: 1, children: [
      /* @__PURE__ */ jsxs2(Text2, { color: BRASS, children: [
        setup ? "key \u203A" : "\u203A",
        " "
      ] }),
      /* @__PURE__ */ jsxs2(Text2, { wrap: "truncate-start", children: [
        setup ? "\u2022".repeat(Math.max(0, cursor)) : input.slice(0, cursor),
        /* @__PURE__ */ jsx2(Text2, { inverse: true, children: setup ? input[cursor] ? "\u2022" : " " : input[cursor] || " " }),
        setup ? "\u2022".repeat(Math.max(0, input.length - cursor - 1)) : input.slice(cursor + 1)
      ] })
    ] }),
    slashOpen && slashItems.length > 0 && /* @__PURE__ */ jsx2(Box2, { flexDirection: "column", paddingLeft: 2, children: slashItems.slice(0, 8).map((c, i) => /* @__PURE__ */ jsxs2(Text2, { color: i === slashSel ? BRASS : STONE, inverse: i === slashSel, children: [
      ` ${c.name.padEnd(10)} `,
      /* @__PURE__ */ jsx2(Text2, { color: i === slashSel ? void 0 : STONE, children: c.desc })
    ] }, c.name)) }),
    /* @__PURE__ */ jsx2(Box2, { marginTop: 1, children: /* @__PURE__ */ jsxs2(Text2, { color: STONE, children: [
      model,
      bal != null ? ` \xB7 \u2B21 ${fmtHero(bal)} $HERO` : "",
      agentId ? ` \xB7 agent #${agentId}` : "",
      spent > 0 ? ` \xB7 session ${fmtHero(spent)}` : "",
      toolsOn ? autoRef.current ? " \xB7 tools(auto)" : " \xB7 tools" : "",
      hasWallet() ? "" : " \xB7 no wallet (memory off)",
      cols >= 90 ? " \xB7 enter send \xB7 esc cancel \xB7 /help" : ""
    ] }) })
  ] });
}

// src/tui/index.jsx
import { jsx as jsx3 } from "react/jsx-runtime";
var here = dirname2(fileURLToPath(import.meta.url));
var version = "";
for (const p of [join3(here, "../../package.json"), join3(here, "../package.json")]) {
  try {
    version = JSON.parse(readFileSync3(p, "utf8")).version;
    break;
  } catch {
  }
}
var argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(`hero ${version}`);
  process.exit(0);
}
if (argv.includes("--smoke")) {
  const { unmount } = render(/* @__PURE__ */ jsx3(Banner, { animated: false, version }));
  setTimeout(() => {
    unmount();
    process.exit(0);
  }, 200);
} else {
  render(/* @__PURE__ */ jsx3(App, { version }), { exitOnCtrlC: true });
}
