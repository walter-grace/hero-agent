// Secrets from your wallet, not your filesystem.
//
// Instead of .env files full of plaintext keys, your secrets live in the Hero vault: AES-256-GCM
// sealed under a key derived from ONE wallet signature, stored server-side as ciphertext the server
// cannot read. This module lets any Node process open that vault and load its environment.
//
// The capability split is the point:
//   - wallet PRIVATE KEY   → can sign, spend, mint. Never needed at runtime for secrets.
//   - vault TOKEN (kHex)   → can decrypt the vault. CANNOT move funds, sign, or mint.
// You derive the token once (web UI "Connect a machine", or `hero-agent vault login` with a key
// file) and the runtime box holds only the token. A compromised box leaks your secrets, which are
// rotatable, not your wallet, which is not.
//
//   import { loadHeroEnv } from "hero-agent/src/vault.mjs";
//   await loadHeroEnv();                    // process.env now has your vault's variables
//
//   const s = await secrets();              // or read them without touching process.env
//   openai.apiKey = s.OPENAI_API_KEY;
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { webcrypto } from "node:crypto";
import { keccak256, hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.HERO_RUN_URL || "https://herorunai.com";
const TOKEN_PATH = process.env.HERO_VAULT_TOKEN_FILE || join(homedir(), ".hero-agent", "vault-token.json");

// Must match lib/key-vault.js in the web app byte-for-byte — same signature, same key, same vault.
const VAULT_MSG = `Hero Run key vault v2
Only sign this on herorunai.com. It derives the key to every API key and connector credential you have saved. Never sign it on any other site.
Origin: herorunai.com`;

// ---- token management ----

// Derive the vault token from a private key (used ONCE, at login) and persist it 0600.
// After this, the private key is not needed for secrets — delete it from the box if you like.
export async function vaultLogin({ privateKey, token, tokenPath = TOKEN_PATH } = {}) {
  let address, kHex;
  if (token) {
    // Token minted in the web UI ("Connect a machine") — the private key NEVER touches this box.
    const m = String(token).trim().match(/^hvt1\.(0x[0-9a-fA-F]{40})\.(0x[0-9a-f]{64})$/);
    if (!m) throw new Error("That doesn't look like a vault token (hvt1.<address>.<key>).");
    address = m[1]; kHex = m[2];
  } else if (privateKey) {
    const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
    const sig = await account.signMessage({ message: VAULT_MSG });
    address = account.address; kHex = keccak256(sig);
  } else {
    throw new Error("Pass a private key (--key-file) or a token from the web UI (--token).");
  }
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ v: 1, address, k: kHex }, null, 2) + "\n");
  chmodSync(tokenPath, 0o600);
  return { address, tokenPath };
}

export function vaultToken(tokenPath = TOKEN_PATH) {
  if (process.env.HERO_VAULT_TOKEN) {
    const m = process.env.HERO_VAULT_TOKEN.match(/^hvt1\.(0x[0-9a-fA-F]{40})\.(0x[0-9a-f]{64})$/);
    if (m) return { address: m[1], k: m[2] };
  }
  if (!existsSync(tokenPath)) return null;
  try { const j = JSON.parse(readFileSync(tokenPath, "utf8")); return j?.k ? j : null; } catch { return null; }
}

// ---- vault I/O (same wire format as the web app + MCP) ----

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
  const out = new Uint8Array(13 + ct.length); out[0] = 1; out.set(iv, 1); out.set(ct, 13);
  return Buffer.from(out).toString("base64");
}
async function api(op, wallet, extra = {}) {
  const r = await fetch(`${BASE}/api/vault`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, wallet, ...extra }),
  });
  if (r.status === 503) throw new Error("Vault storage is temporarily unavailable.");
  const j = await r.json().catch(() => ({}));
  if (r.status === 403) throw new Error("This token can't open the vault (was it rotated?). Re-run vault login.");
  if (!r.ok) throw new Error(j.error || `vault ${op} failed`);
  return j;
}

// Open the vault: returns { vault, save } where save(next) re-seals and uploads.
export async function openVault({ tokenPath = TOKEN_PATH } = {}) {
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
    },
  };
}

// ---- the public surface ----

// All env vars from the vault as a plain object. Logs one access-log entry (visible on /locker).
export async function secrets({ tokenPath, purpose = "" } = {}) {
  const { vault, save } = await openVault({ tokenPath });
  const env = vault.envVars && typeof vault.envVars === "object" ? { ...vault.envVars } : {};
  // Append to the same access log the credential locker uses, so /locker shows SDK pulls too.
  try {
    const log = Array.isArray(vault.credLog) ? vault.credLog : [];
    log.push({ label: "env", host: "vault", purpose: String(purpose || "secrets() pull").slice(0, 200), harness: "sdk", at: new Date().toISOString(), result: "released", count: Object.keys(env).length });
    if (log.length > 500) log.splice(0, log.length - 500);
    await save({ ...vault, credLog: log });
  } catch { /* logging must never block the secrets themselves */ }
  return env;
}

// Merge the vault's env vars into process.env (existing values win unless overwrite).
export async function loadHeroEnv({ tokenPath, overwrite = false, purpose } = {}) {
  const env = await secrets({ tokenPath, purpose: purpose || "loadHeroEnv()" });
  const loaded = [];
  for (const [k, v] of Object.entries(env)) {
    if (!overwrite && process.env[k] !== undefined) continue;
    process.env[k] = String(v);
    loaded.push(k);
  }
  return loaded;
}

export async function setSecret(name, value, { tokenPath } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Secret names must look like ENV_VARS.");
  const { vault, save } = await openVault({ tokenPath });
  const envVars = { ...(vault.envVars || {}), [name]: String(value) };
  await save({ ...vault, envVars });
}

export async function deleteSecret(name, { tokenPath } = {}) {
  const { vault, save } = await openVault({ tokenPath });
  const envVars = { ...(vault.envVars || {}) };
  delete envVars[name];
  await save({ ...vault, envVars });
}

export async function listSecrets({ tokenPath } = {}) {
  const { vault } = await openVault({ tokenPath });
  return Object.keys(vault.envVars || {}).sort();
}
