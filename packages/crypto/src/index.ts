/**
 * @loam/crypto — Phase 0 cryptographic identity + sealed-mailbox primitives for the
 * opportunistic mesh (docs/16). Pure JS, no native deps: runs byte-identically on the embedded
 * Node 18 (Android) runtime, Node 24, and an insecure-context PWA browser (only
 * `globalThis.crypto.getRandomValues`, via `@noble/*`). Nothing here is wired into a runtime path
 * yet — this is the isolated primitive from Phase 0.
 *
 * Primitives: Ed25519 (long-term signing identity), X25519 (sealed-mailbox ECDH), XChaCha20-Poly1305
 * (AEAD), HKDF-SHA256 (key/tag derivation). All from `@noble/*`, pinned to the Node-18-safe 1.x line.
 */

import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { randomBytes } from "@noble/hashes/utils";

/**
 * A self-sovereign mesh identity: an Ed25519 signing keypair (long-term identity), an X25519
 * agreement keypair (sealed-mailbox ECDH), a signature binding the two, and a secret mailbox token
 * used to derive rotating routing tags. All key material is base64url-encoded; `meshId` is the
 * self-certifying id derived from the signing public key.
 */
export interface MeshIdentity {
  /** "mesh." + base32(sha256(signPublic bytes)[0..15]), lowercase, no padding. */
  meshId: string;
  /** base64url, 32-byte Ed25519 public key. */
  signPublic: string;
  /** base64url, 32-byte Ed25519 seed (private) — caller stores server-side. */
  signSecret: string;
  /** base64url, 32-byte X25519 public key. */
  kxPublic: string;
  /** base64url, 32-byte X25519 private key. */
  kxSecret: string;
  /** base64url, 64-byte Ed25519 signature over ("loam.mesh.kxbind.v1" ‖ kxPublic bytes). */
  kxSig: string;
  /** base64url, 32 random bytes (secret; used for routing tags). */
  mailboxToken: string;
}

/** Domain-separation labels. Fixed byte strings so both ends produce identical envelopes. */
const KX_BIND_LABEL = "loam.mesh.kxbind.v1";
const SEAL_INFO = "loam.mesh.seal.v1";
const INNER_SIG_LABEL = "loam.mesh.inner.v1";
const TAG_INFO = "loam.mesh.tag.v1";

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

// ---------------------------------------------------------------------------
// Byte helpers (pure, dependency-free) — base64url, base32, big-endian, concat.
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64URL_ALPHABET.length; i++) table[B64URL_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Encode bytes as unpadded base64url. */
function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Decode unpadded (or padded) base64url. Throws on any invalid character. */
function b64urlDecode(str: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x3d) break; // '=' padding — tolerate and stop
    const value = code < 128 ? B64URL_LOOKUP[code] : -1;
    if (value < 0) throw new Error("invalid base64url");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(out);
}

const B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"; // RFC 4648 base32, lowercase

/** Encode bytes as unpadded lowercase base32 (RFC 4648). */
function base32Lower(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(buffer >> bits) & 0x1f];
      buffer &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return out;
}

/** Encode a non-negative integer as 8 big-endian bytes. */
function u64BE(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(Math.trunc(n));
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Concatenate byte arrays into a single Uint8Array. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * meshId = "mesh." + base32(sha256(signPublic bytes)[0..15]). Deterministic and self-certifying:
 * anyone can recompute it from the signing public key to verify an id ↔ key binding (no PKI).
 */
export function meshIdFromSignPublic(signPublic: string): string {
  const pub = b64urlDecode(signPublic);
  const digest = sha256(pub);
  return "mesh." + base32Lower(digest.slice(0, 16));
}

/**
 * Generate a fresh mesh identity: an Ed25519 signing keypair, an X25519 agreement keypair, a
 * signed binding of the agreement key to the signing key, and a random mailbox token.
 */
export function createMeshIdentity(): MeshIdentity {
  const signSecret = ed25519.utils.randomPrivateKey();
  const signPublic = ed25519.getPublicKey(signSecret);
  const kxSecret = x25519.utils.randomPrivateKey();
  const kxPublic = x25519.getPublicKey(kxSecret);

  const kxSig = ed25519.sign(concatBytes(utf8.encode(KX_BIND_LABEL), kxPublic), signSecret);
  const mailboxToken = randomBytes(32);

  const signPublicB64 = b64urlEncode(signPublic);
  return {
    meshId: meshIdFromSignPublic(signPublicB64),
    signPublic: signPublicB64,
    signSecret: b64urlEncode(signSecret),
    kxPublic: b64urlEncode(kxPublic),
    kxSecret: b64urlEncode(kxSecret),
    kxSig: b64urlEncode(kxSig),
    mailboxToken: b64urlEncode(mailboxToken),
  };
}

/**
 * Verify that `kxSig` is a valid Ed25519 signature by `signPublic` over
 * ("loam.mesh.kxbind.v1" ‖ kxPublic bytes) — i.e. the agreement key is genuinely bound to the
 * signing identity, defending against a carrier swapping in its own `kx`. Returns false on any error.
 */
export function verifyKxBinding(signPublic: string, kxPublic: string, kxSig: string): boolean {
  try {
    const message = concatBytes(utf8.encode(KX_BIND_LABEL), b64urlDecode(kxPublic));
    return ed25519.verify(b64urlDecode(kxSig), message, b64urlDecode(signPublic));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sealed mailbox
// ---------------------------------------------------------------------------

/**
 * Inner (sender-authenticated) payload sealed inside the envelope. `signPublic` is carried so the
 * recipient can both recover the sender's signing key and verify the inner signature — the meshId
 * (`from`) is only a hash of it and cannot be reversed.
 */
interface SealedInner {
  from: string; // sender meshId
  signPublic: string; // sender Ed25519 public key (base64url)
  fromKx: string; // sender X25519 public key (base64url)
  pt: string; // plaintext
  sig: string; // base64url Ed25519 signature (see innerSigMessage)
}

/** The exact bytes the sender signs / the recipient verifies for the inner payload. */
function innerSigMessage(from: string, fromKx: string, pt: string, aad: string): Uint8Array {
  return concatBytes(
    utf8.encode(INNER_SIG_LABEL),
    utf8.encode(from),
    utf8.encode(fromKx),
    utf8.encode(pt),
    utf8.encode(aad),
  );
}

/** Derive the XChaCha20-Poly1305 key from the ECDH shared secret (HKDF-SHA256). */
function sealKey(shared: Uint8Array, ePublic: Uint8Array, recipientKxPublic: Uint8Array): Uint8Array {
  const salt = concatBytes(ePublic, recipientKxPublic);
  return hkdf(sha256, shared, salt, utf8.encode(SEAL_INFO), 32);
}

/**
 * Seal a message so ONLY the holder of `recipientKxPublic`'s secret can open it, with the sender
 * authenticated to the recipient (sealed-sender). `aad` is cleartext relay metadata bound into both
 * the inner signature and the AEAD AAD, so a carrier can neither read the body nor tamper the metadata.
 *
 * Envelope: fresh ephemeral X25519 keypair; shared = X25519(eSec, recipientKxPublic);
 *   key = HKDF-SHA256(shared, salt=ePublic‖recipientKxPublic, info="loam.mesh.seal.v1");
 *   blob = base64url( ePublic(32) ‖ nonce(24) ‖ XChaCha20Poly1305(key, nonce, JSON(inner), aad) ).
 */
export function sealMailbox(input: {
  recipientKxPublic: string;
  sender: { signPublic: string; signSecret: string; kxPublic: string };
  plaintext: string;
  aad: string;
}): string {
  const recipientKxPublic = b64urlDecode(input.recipientKxPublic);
  const ephemeralSecret = x25519.utils.randomPrivateKey();
  const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
  const shared = x25519.getSharedSecret(ephemeralSecret, recipientKxPublic);
  const key = sealKey(shared, ephemeralPublic, recipientKxPublic);

  const from = meshIdFromSignPublic(input.sender.signPublic);
  const sig = ed25519.sign(
    innerSigMessage(from, input.sender.kxPublic, input.plaintext, input.aad),
    b64urlDecode(input.sender.signSecret),
  );
  const inner: SealedInner = {
    from,
    signPublic: input.sender.signPublic,
    fromKx: input.sender.kxPublic,
    pt: input.plaintext,
    sig: b64urlEncode(sig),
  };

  const nonce = randomBytes(24);
  const aadBytes = utf8.encode(input.aad);
  const ciphertext = xchacha20poly1305(key, nonce, aadBytes).encrypt(utf8.encode(JSON.stringify(inner)));

  return b64urlEncode(concatBytes(ephemeralPublic, nonce, ciphertext));
}

/**
 * Open and verify a sealed blob. Returns the authenticated sender identity + plaintext, or `null` on
 * ANY failure: malformed blob, decrypt/tag failure (wrong recipient key, tampered blob, or `aad` that
 * differs from the sealed one), an invalid inner sender signature, or a `from` that doesn't derive
 * from the enclosed signing key.
 */
export function openMailbox(input: {
  blob: string;
  recipientKxSecret: string;
  aad: string;
}): { senderMeshId: string; senderSignPublic: string; senderKxPublic: string; plaintext: string } | null {
  try {
    const raw = b64urlDecode(input.blob);
    if (raw.length < 32 + 24 + 16) return null; // ephemeral(32) + nonce(24) + AEAD tag(16) minimum
    const ephemeralPublic = raw.slice(0, 32);
    const nonce = raw.slice(32, 56);
    const ciphertext = raw.slice(56);

    const recipientKxSecret = b64urlDecode(input.recipientKxSecret);
    const recipientKxPublic = x25519.getPublicKey(recipientKxSecret);
    const shared = x25519.getSharedSecret(recipientKxSecret, ephemeralPublic);
    const key = sealKey(shared, ephemeralPublic, recipientKxPublic);

    const aadBytes = utf8.encode(input.aad);
    const plaintextBytes = xchacha20poly1305(key, nonce, aadBytes).decrypt(ciphertext);
    const inner = JSON.parse(utf8Decode.decode(plaintextBytes)) as Partial<SealedInner>;

    if (
      typeof inner.from !== "string" ||
      typeof inner.signPublic !== "string" ||
      typeof inner.fromKx !== "string" ||
      typeof inner.pt !== "string" ||
      typeof inner.sig !== "string"
    ) {
      return null;
    }

    // The meshId must derive from the enclosed signing key (defeats a swapped `from`).
    if (meshIdFromSignPublic(inner.signPublic) !== inner.from) return null;

    // The inner signature must be valid over the exact signed bytes (binds sender + body + aad).
    const ok = ed25519.verify(
      b64urlDecode(inner.sig),
      innerSigMessage(inner.from, inner.fromKx, inner.pt, input.aad),
      b64urlDecode(inner.signPublic),
    );
    if (!ok) return null;

    return {
      senderMeshId: inner.from,
      senderSignPublic: inner.signPublic,
      senderKxPublic: inner.fromKx,
      plaintext: inner.pt,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Routing tags
// ---------------------------------------------------------------------------

/**
 * Rotating routing tag derived from the secret mailbox token — computable only by the recipient and
 * the senders it hands the token to, never from public key material.
 * tag = base64url( HKDF-SHA256(mailboxToken, info="loam.mesh.tag.v1"‖u64BE(epoch))[0..15] ).
 */
export function mailboxTag(mailboxToken: string, epoch: number): string {
  const token = b64urlDecode(mailboxToken);
  const info = concatBytes(utf8.encode(TAG_INFO), u64BE(epoch));
  const derived = hkdf(sha256, token, undefined, info, 16);
  return b64urlEncode(derived);
}

/** epoch = floor(nowMs / windowMs). */
export function currentEpoch(nowMs: number, windowMs: number): number {
  return Math.floor(nowMs / windowMs);
}
