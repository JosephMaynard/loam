import { describe, it, expect } from "vitest";
import {
  createMeshIdentity,
  meshIdFromSignPublic,
  verifyKxBinding,
  sealMailbox,
  openMailbox,
  mailboxTag,
  currentEpoch,
} from "./index.js";

/** Build the `sender` shape sealMailbox expects from a full identity. */
function senderOf(id: ReturnType<typeof createMeshIdentity>) {
  return { signPublic: id.signPublic, signSecret: id.signSecret, kxPublic: id.kxPublic };
}

describe("mesh identity", () => {
  it("createMeshIdentity produces a self-certifying id and a valid kx binding", () => {
    const id = createMeshIdentity();
    expect(id.meshId).toMatch(/^mesh\.[a-z2-7]+$/);
    expect(meshIdFromSignPublic(id.signPublic)).toBe(id.meshId);
    expect(verifyKxBinding(id.signPublic, id.kxPublic, id.kxSig)).toBe(true);
  });

  it("verifyKxBinding is false for a mismatched kx", () => {
    const a = createMeshIdentity();
    const b = createMeshIdentity();
    // b's kx public against a's signing key + a's signature: unbound.
    expect(verifyKxBinding(a.signPublic, b.kxPublic, a.kxSig)).toBe(false);
    // a's real kx but b's signature: also invalid.
    expect(verifyKxBinding(a.signPublic, a.kxPublic, b.kxSig)).toBe(false);
  });

  it("distinct identities have distinct meshIds and mailbox tokens", () => {
    const a = createMeshIdentity();
    const b = createMeshIdentity();
    expect(a.meshId).not.toBe(b.meshId);
    expect(a.mailboxToken).not.toBe(b.mailboxToken);
    expect(mailboxTag(a.mailboxToken, 0)).not.toBe(mailboxTag(b.mailboxToken, 0));
  });
});

describe("sealed mailbox", () => {
  it("round-trips plaintext and authenticates the sender", () => {
    const alice = createMeshIdentity();
    const bob = createMeshIdentity();
    const aad = "toTag=abc|ttl=123|hop0=8";
    const blob = sealMailbox({
      recipientKxPublic: bob.kxPublic,
      sender: senderOf(alice),
      plaintext: "meet at the ridge at dawn",
      aad,
    });

    const opened = openMailbox({ blob, recipientKxSecret: bob.kxSecret, aad });
    expect(opened).not.toBeNull();
    expect(opened!.plaintext).toBe("meet at the ridge at dawn");
    expect(opened!.senderMeshId).toBe(alice.meshId);
    expect(opened!.senderSignPublic).toBe(alice.signPublic);
    expect(opened!.senderKxPublic).toBe(alice.kxPublic);
  });

  it("returns null for the wrong recipient key", () => {
    const alice = createMeshIdentity();
    const bob = createMeshIdentity();
    const eve = createMeshIdentity();
    const aad = "meta";
    const blob = sealMailbox({
      recipientKxPublic: bob.kxPublic,
      sender: senderOf(alice),
      plaintext: "secret",
      aad,
    });
    expect(openMailbox({ blob, recipientKxSecret: eve.kxSecret, aad })).toBeNull();
  });

  it("returns null when a byte of the blob is flipped", () => {
    const alice = createMeshIdentity();
    const bob = createMeshIdentity();
    const aad = "meta";
    const blob = sealMailbox({
      recipientKxPublic: bob.kxPublic,
      sender: senderOf(alice),
      plaintext: "secret",
      aad,
    });
    // Flip a character deep in the ciphertext region.
    const idx = blob.length - 5;
    const ch = blob[idx];
    const flipped = blob.slice(0, idx) + (ch === "A" ? "B" : "A") + blob.slice(idx + 1);
    expect(openMailbox({ blob: flipped, recipientKxSecret: bob.kxSecret, aad })).toBeNull();
  });

  it("returns null when opened with a different aad than sealed", () => {
    const alice = createMeshIdentity();
    const bob = createMeshIdentity();
    const blob = sealMailbox({
      recipientKxPublic: bob.kxPublic,
      sender: senderOf(alice),
      plaintext: "secret",
      aad: "toTag=abc|ttl=100",
    });
    expect(
      openMailbox({ blob, recipientKxSecret: bob.kxSecret, aad: "toTag=abc|ttl=999" }),
    ).toBeNull();
  });

  it("returns null for garbage / truncated blobs (no forged inner is openable)", () => {
    const bob = createMeshIdentity();
    expect(openMailbox({ blob: "", recipientKxSecret: bob.kxSecret, aad: "x" })).toBeNull();
    expect(openMailbox({ blob: "not-base64-@@@", recipientKxSecret: bob.kxSecret, aad: "x" })).toBeNull();
    expect(openMailbox({ blob: "AAAA", recipientKxSecret: bob.kxSecret, aad: "x" })).toBeNull();
    // A well-formed-length but random blob: valid base64url, right size, but no valid AEAD.
    const garbage = "A".repeat(120);
    expect(openMailbox({ blob: garbage, recipientKxSecret: bob.kxSecret, aad: "x" })).toBeNull();
  });

  it("handles empty plaintext and unicode", () => {
    const alice = createMeshIdentity();
    const bob = createMeshIdentity();
    const aad = "m";
    for (const pt of ["", "héllo 🌐 mesh"]) {
      const blob = sealMailbox({ recipientKxPublic: bob.kxPublic, sender: senderOf(alice), plaintext: pt, aad });
      const opened = openMailbox({ blob, recipientKxSecret: bob.kxSecret, aad });
      expect(opened?.plaintext).toBe(pt);
    }
  });
});

describe("routing tags", () => {
  it("mailboxTag is deterministic for the same (token, epoch)", () => {
    const id = createMeshIdentity();
    expect(mailboxTag(id.mailboxToken, 42)).toBe(mailboxTag(id.mailboxToken, 42));
  });

  it("mailboxTag differs across epochs", () => {
    const id = createMeshIdentity();
    expect(mailboxTag(id.mailboxToken, 42)).not.toBe(mailboxTag(id.mailboxToken, 43));
  });

  it("mailboxTag matches the sealed-schema tag shape (22 base64url chars)", () => {
    const id = createMeshIdentity();
    expect(mailboxTag(id.mailboxToken, 1)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("currentEpoch floors nowMs / windowMs", () => {
    expect(currentEpoch(0, 1000)).toBe(0);
    expect(currentEpoch(999, 1000)).toBe(0);
    expect(currentEpoch(1000, 1000)).toBe(1);
    expect(currentEpoch(86_400_000 * 3 + 5, 86_400_000)).toBe(3);
  });
});
