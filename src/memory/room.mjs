// Group-private rooms: the missing third visibility.
//
//   marker 2  = owner-only (wallet-derived AES key)         — private to one wallet
//   marker 0  = plaintext                                    — public to the world
//   marker 3  = ROOM (this file)                             — shared among members, hidden from all else
//
// Scheme: one random 32-byte room key encrypts entries (AES-256-GCM). The room key is distributed
// ON-CHAIN: for each member it is wrapped to their secp256k1 public key via ECIES (ephemeral ECDH →
// sha256 of the shared secret → AES-256-GCM). A member recovers the room key from their wrap using
// nothing but their wallet's private key, so the chain is the whole channel — no DMs, no key
// ceremony, and revocation composes with the contract's approval (a removed member keeps old
// entries they could already read — that is how encryption works — but never sees a NEW room key
// after a rotation).
//
// Wallet keys ARE secp256k1 keys, which is what makes this work with zero new key material: the
// same key that signs transactions unwraps room keys. Deriving the public key from the private one
// is trivial; the reverse is the hard direction, which is why members must PUBLISH their pubkey
// once (an address is a hash of it — unrecoverable alone).
import { createECDH, createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const ROOM_MARK = 3;                       // blob marker for room-encrypted checkpoints
export const PUBKEY_MARK = "pubkey::";            // public entry: a member's published pubkey
export const ROOMKEY_MARK = "roomkey::";          // public entry: the room key wrapped to one member

const h32 = (buf) => createHash("sha256").update(buf).digest();

export function pubkeyOf(privHex) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privHex.replace(/^0x/, ""), "hex"));
  return ecdh.getPublicKey("hex", "uncompressed"); // 65 bytes, 04 || X || Y
}

export const makeRoomKey = () => randomBytes(32);

/** ECIES wrap: ephemeral keypair -> ECDH with the member's pubkey -> AES-GCM the room key. */
export function wrapKey(memberPubHex, roomKey) {
  const eph = createECDH("secp256k1");
  eph.generateKeys();
  const shared = eph.computeSecret(Buffer.from(memberPubHex, "hex"));
  const kek = h32(shared);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, iv);
  const ct = Buffer.concat([c.update(roomKey), c.final()]);
  return { ephPub: eph.getPublicKey("hex", "uncompressed"), iv: iv.toString("hex"), ct: Buffer.concat([ct, c.getAuthTag()]).toString("hex") };
}

/** Member side: their wallet private key + the wrap -> the room key. */
export function unwrapKey(privHex, wrap) {
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(Buffer.from(privHex.replace(/^0x/, ""), "hex"));
  const shared = ecdh.computeSecret(Buffer.from(wrap.ephPub, "hex"));
  const kek = h32(shared);
  const blob = Buffer.from(wrap.ct, "hex");
  const ct = blob.subarray(0, blob.length - 16), tag = blob.subarray(blob.length - 16);
  const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(wrap.iv, "hex"));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]); // throws on tamper — a wrong key never "succeeds quietly"
}

/** Seal entries with the room key -> marker-3 blob. Mirrors the marker-2 layout exactly. */
export function sealRoom(roomKey, entriesJsonGz) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", roomKey, iv);
  const ct = Buffer.concat([c.update(entriesJsonGz), c.final(), c.getAuthTag()]);
  return Buffer.concat([Buffer.from([ROOM_MARK]), iv, ct]);
}

export function openRoom(roomKey, blob) {
  if (blob[0] !== ROOM_MARK) throw new Error("not a room blob");
  const iv = blob.subarray(1, 13), body = blob.subarray(13);
  const ct = body.subarray(0, body.length - 16), tag = body.subarray(body.length - 16);
  const d = createDecipheriv("aes-256-gcm", roomKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
