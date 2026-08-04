// File attachments as content-addressed memory. Every attachment is identified by its sha256, so the
// hash is the commitment and the bytes are verifiable wherever they live. Two storage paths:
//
//   inline  — small files ride the same encrypted, hash-chained checkpoint log as every other memory.
//             No bucket, no pinning service, nothing to lose the key to but your wallet. This is the
//             self-contained default for notes, docs, and small images.
//   pointer — larger files stay off-chain (R2/IPFS/Arweave); only {sha256, uri} goes on-chain. Keeps
//             permanent on-chain state and metadata small, which is the right call for big payloads.
//
// The manifest and hash verification work the same for both, so a file can move from inline to pointer
// without changing how it is referenced.
import { createHash } from "node:crypto";

export const FILE_MARK = "file::";
export const MAX_FILE_BYTES = 128 * 1024; // inline-on-chain ceiling; above this, use a pointer

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

export function makeFileEntry(buf, { name, mime } = {}) {
  if (buf.length > MAX_FILE_BYTES)
    throw new Error(`file is ${(buf.length / 1024).toFixed(0)}KB; the inline on-chain limit is ${MAX_FILE_BYTES / 1024}KB. Store it off-chain and attach a pointer with makeFilePointerEntry / attach --uri.`);
  const sha256 = sha256hex(buf);
  return { role: "system", text: FILE_MARK + JSON.stringify({
    name: name || "file", mime: mime || "application/octet-stream", size: buf.length, sha256,
    b64: buf.toString("base64"), at: new Date().toISOString(),
  }) };
}

// Content-addressed pointer to an off-chain payload (R2 key, ipfs:// CID, ar:// tx, https URL).
// The sha256 stays the identity and the tamper check; the uri is just where the bytes are pinned.
export function makeFilePointerEntry({ name, mime, size, sha256, uri } = {}) {
  if (!sha256 || !uri) throw new Error("a file pointer needs both sha256 and uri.");
  return { role: "system", text: FILE_MARK + JSON.stringify({
    name: name || "file", mime: mime || "application/octet-stream", size: size || 0, sha256, uri,
    at: new Date().toISOString(),
  }) };
}

// Manifest of attached files (metadata only, no bytes), newest-wins on repeated sha256.
export function parseFiles(entries) {
  const files = new Map();
  for (const e of entries || []) {
    if (typeof e.text !== "string" || !e.text.startsWith(FILE_MARK)) continue;
    try { const { b64, ...meta } = JSON.parse(e.text.slice(FILE_MARK.length)); if (meta.sha256) files.set(meta.sha256, meta); } catch {}
  }
  return files;
}

// Resolve one attachment by sha256 or by name. Inline files return verified bytes; pointer files
// return the uri to fetch from (bytes null, verify after you fetch by re-hashing to sha256).
export function extractFile(entries, ref) {
  for (const e of entries || []) {
    if (typeof e.text !== "string" || !e.text.startsWith(FILE_MARK)) continue;
    try {
      const f = JSON.parse(e.text.slice(FILE_MARK.length));
      if (f.sha256 !== ref && f.name !== ref) continue;
      const base = { name: f.name, mime: f.mime, size: f.size, sha256: f.sha256, at: f.at };
      if (f.b64) { const buf = Buffer.from(f.b64, "base64"); return { ...base, buf, external: false, verified: sha256hex(buf) === f.sha256 }; }
      if (f.uri) return { ...base, uri: f.uri, buf: null, external: true, verified: null };
      return { ...base, buf: null, external: false, verified: null };
    } catch {}
  }
  return null;
}
