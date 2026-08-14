// Hero Run client for the TUI: inference over /v1 (paid in $HERO), plus the on-chain side
// (wallet, agents, memory, channels) through the same modules the rest of hero-agent uses.
// Everything here is plain async functions so the UI layer stays pure rendering.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const BASE = process.env.HERO_RUN_BASE || "https://herorunai.com";
const DIR = join(homedir(), ".hero-agent");
const KEY_FILE = join(DIR, "hero-run-key.txt");
const SETTINGS_FILE = join(DIR, "tui.json");

// ---- inference key (prepaid hr_live_, the only credential inference needs) ----
export function loadKey() {
  if (process.env.HERO_RUN_KEY) return process.env.HERO_RUN_KEY.trim();
  try { return readFileSync(KEY_FILE, "utf8").trim() || null; } catch { return null; }
}
export function saveKey(key) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(KEY_FILE, key.trim() + "\n", { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return KEY_FILE;
}
// ---- vault (secrets from your wallet; src/vault.mjs is the engine) ----
// Boot fallback: no env var, no key file, but a vault token on this machine → the TUI can fetch
// HERO_RUN_KEY from the wallet vault and skip the first-run wizard entirely.
export async function vaultBootKey() {
  try {
    const V = await import("../vault.mjs");
    if (!V.vaultToken()) return null;
    const env = await V.secrets({ purpose: "hero TUI boot" });
    return env.HERO_RUN_KEY?.trim() || null;
  } catch { return null; }
}
export async function vaultOps() { return import("../vault.mjs"); }

export async function keyInfo(key) {
  const r = await fetch(`${BASE}/api/keys/info`, { headers: { "x-api-key": key } });
  if (!r.ok) throw new Error(r.status === 401 ? "That key is not valid." : `key info failed (${r.status})`);
  return r.json();
}

// ---- settings (model + agent id persist across sessions; never key material) ----
export function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}
export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// ---- models ----
export async function listModels(key) {
  const r = await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
  const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error?.message || `models failed (${r.status})`);
  return d.data.map((m) => m.id);
}

// ---- streaming chat over the OpenAI-compatible endpoint ----
// onDelta fires per content chunk; the resolved model + $HERO charged ride the final usage frame.
export async function streamChat({ key, model, messages, maxTokens = 1200, signal, onDelta }) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages, stream: true, max_tokens: maxTokens, stream_options: { include_usage: true } }),
    signal,
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error?.message || `request failed (${r.status})`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", text = "", meta = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop();
    for (const f of frames) {
      const line = f.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      let d; try { d = JSON.parse(payload); } catch { continue; }
      if (d.error) throw new Error(d.error.message || "run failed");
      const delta = d.choices?.[0]?.delta?.content;
      if (delta) { text += delta; onDelta?.(delta); }
      if (d.usage) meta = { usage: d.usage, ...d.x_hero };
    }
  }
  return { text, seconds: (Date.now() - t0) / 1000, resolvedModel: meta.resolved_model || model, charged: meta.charged_hero ?? null, usage: meta.usage || null, gateway: meta.gateway };
}

// ---- wallet + chain (lazy: viem loads only when a chain command runs) ----
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const MEM_ADDR = process.env.HERO_MEM_ADDR || "0xce4dc968827a996f7bd5bbdb0fcb72348b18d0dc";

export function walletKeyFile() {
  if (process.env.HERO_AGENT_KEY_FILE) return process.env.HERO_AGENT_KEY_FILE;
  try {
    const dir = join(DIR, "keys");
    const f = readdirSync(dir).filter((x) => x.endsWith(".key")).sort()[0];
    return f ? join(dir, f) : null;
  } catch { return null; }
}
export function hasWallet() { const f = walletKeyFile(); return !!(f && existsSync(f)); }

async function rpc(method, params) {
  const r = await fetch(RH_RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}
const pad = (v) => BigInt(v).toString(16).padStart(64, "0");

let _sel = null;
async function sels() {
  if (_sel) return _sel;
  const { keccak256, toBytes } = await import("viem");
  const s = (sig) => keccak256(toBytes(sig)).slice(0, 10);
  _sel = { nextId: s("nextId()"), ownerOf: s("ownerOf(uint256)"), labelOf: s("labelOf(uint256)"), headOf: s("headOf(uint256)"), balanceOf: s("balanceOf(address)") };
  return _sel;
}
const call = (data) => rpc("eth_call", [{ to: MEM_ADDR, data }, "latest"]);

export async function walletInfo() {
  const kf = walletKeyFile();
  if (!kf) return null;
  const { privateKeyToAccount } = await import("viem/accounts");
  const raw = readFileSync(kf, "utf8").trim();
  const account = privateKeyToAccount(raw.startsWith("0x") ? raw : "0x" + raw);
  const wei = BigInt(await rpc("eth_getBalance", [account.address, "latest"]));
  return { address: account.address, eth: Number(wei) / 1e18, keyFile: kf };
}

// Newest-first scan through the contract's own getters. NEVER eth_getLogs from block 0 on
// Robinhood Chain: the RPC answers a capped range with an EMPTY result, not an error, and the
// wallet's agents silently read as none.
export async function listAgents(address, { maxScan = 400 } = {}) {
  const S = await sels();
  const nextId = Number(BigInt(await call(S.nextId)));
  const want = Number(BigInt(await call(S.balanceOf + pad(address)).catch(() => "0x0")));
  const me = address.toLowerCase();
  const out = [];
  const floor = Math.max(1, nextId - maxScan);
  // Batched newest-first: 8 ownerOf calls in flight keeps a 400-id scan under ~10s instead of
  // minutes, and the walk still stops the moment balanceOf says every agent is accounted for.
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
      } catch {}
      try { count = Number(BigInt("0x" + (await call(S.headOf + pad(i))).replace(/^0x/, "").slice(64, 128))); } catch {}
      return { id: i, label, count };
    }));
    out.push(...detail);
  }
  return out.sort((a, b) => a.id - b.id);
}

// Memory handle for an agent. With a wallet key it decrypts the owner's entries; without one it
// uses a throwaway key, which still reads public entries and verifies the hash chain (sealed
// blobs are skipped, exactly as a stranger should see them).
async function memoryFor(agentId, { roomKey = null } = {}) {
  const { OnchainMemory } = await import("../memory/onchain.mjs");
  const kf = walletKeyFile();
  const priv = kf && existsSync(kf) ? readFileSync(kf, "utf8").trim() : "0x" + randomBytes(32).toString("hex");
  return new OnchainMemory({ agentId, privateKey: priv.startsWith("0x") ? priv : "0x" + priv, ...(roomKey ? { roomKey } : {}) });
}

export async function readMemory(agentId, { limit = 20 } = {}) {
  const mem = await memoryFor(agentId);
  const entries = await mem.raw();
  return entries.slice(-limit);
}

export async function writeMemory(agentId, entries, { isPublic = false } = {}) {
  const mem = await memoryFor(agentId);
  const hash = isPublic ? await mem.appendPublic(entries) : await mem.append(entries);
  await mem.pub.waitForTransactionReceipt({ hash }).catch(() => {});
  return hash;
}

// Channels: read an agent as a conversation. Auto-detects group-room membership from this
// wallet's on-chain roomkey:: wrap (the CLI identity is the raw wallet key).
export async function readChannel(agentId) {
  const room = await import("../memory/room.mjs");
  const kf = walletKeyFile();
  const plain = await memoryFor(agentId);
  const entries = await plain.raw();
  let roomKey = null, membership = "none";
  if (kf && existsSync(kf)) {
    const raw = readFileSync(kf, "utf8").trim();
    const priv = raw.startsWith("0x") ? raw : "0x" + raw;
    const { privateKeyToAccount } = await import("viem/accounts");
    const me = privateKeyToAccount(priv).address.toLowerCase();
    const wraps = entries.filter((e) => e.text?.startsWith(room.ROOMKEY_MARK))
      .map((e) => { try { return JSON.parse(e.text.slice(room.ROOMKEY_MARK.length)); } catch { return null; } })
      .filter(Boolean).reverse();
    for (const wrap of wraps.filter((x) => String(x.to || "").toLowerCase() === me)) {
      try { roomKey = room.unwrapKey(priv, wrap); membership = "member"; break; }
      catch { membership = "foreign"; }
    }
  }
  if (!roomKey) return { entries, membership };
  const mem = await memoryFor(agentId, { roomKey });
  return { entries: await mem.raw(), membership };
}

export async function sendChannel(agentId, text) {
  const { membership } = await readChannel(agentId);
  const room = membership === "member";
  const kf = walletKeyFile();
  if (!kf) throw new Error("Sending needs a wallet key. Set HERO_AGENT_KEY_FILE or run: hero-agent wallet new");
  const { privateKeyToAccount } = await import("viem/accounts");
  const raw = readFileSync(kf, "utf8").trim();
  const from = privateKeyToAccount(raw.startsWith("0x") ? raw : "0x" + raw).address;
  const entry = [{ role: "agent", text: "msg::" + JSON.stringify({ from, text, at: new Date().toISOString() }) }];
  let mem;
  if (room) {
    const r = await import("../memory/room.mjs");
    const plain = await memoryFor(agentId);
    const entries = await plain.raw();
    const priv = raw.startsWith("0x") ? raw : "0x" + raw;
    const wrap = entries.filter((e) => e.text?.startsWith(r.ROOMKEY_MARK))
      .map((e) => { try { return JSON.parse(e.text.slice(r.ROOMKEY_MARK.length)); } catch { return null; } })
      .filter(Boolean).reverse().find((x) => String(x.to || "").toLowerCase() === from.toLowerCase());
    mem = await memoryFor(agentId, { roomKey: r.unwrapKey(priv, wrap) });
    const hash = await mem.appendRoom(entry);
    await mem.pub.waitForTransactionReceipt({ hash }).catch(() => {});
    return { mode: "room", hash };
  }
  mem = await memoryFor(agentId);
  const hash = await mem.appendPublic(entry);
  await mem.pub.waitForTransactionReceipt({ hash }).catch(() => {});
  return { mode: "public", hash };
}
