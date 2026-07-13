import { describe, it, expect } from "vitest";
import {
  createMeshIdentity,
  meshIdFromSignPublic,
  verifyKxBinding,
  sealMailbox,
  openMailbox,
  mailboxTag,
  currentEpoch,
  createTransportIdentity,
  verifyTransportKeypair,
  transportFingerprint,
  transportClientHello,
  transportServerAccept,
  transportClientDerive,
  sealTransport,
  openTransport,
} from "./index.js";

/** Run a full client↔host transport handshake and return the two derived session keys. */
function handshake(): { hostSecret: string; hostPublic: string; clientKey: string; serverKey: string } {
  const host = createTransportIdentity();
  const hello = transportClientHello();
  const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic: hello.ephemeralPublic });
  const clientKey = transportClientDerive({
    clientEphemeralSecret: hello.ephemeralSecret,
    hostPublic: host.publicKey,
    hostEphemeralPublic: accepted.hostEphemeralPublic,
  });
  return { hostSecret: host.secretKey, hostPublic: host.publicKey, clientKey, serverKey: accepted.sessionKey };
}

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

describe("transport session (docs/08)", () => {
  it("client and host derive the same session key from the handshake", () => {
    const { clientKey, serverKey } = handshake();
    expect(clientKey).toBe(serverKey);
    expect(clientKey).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });

  it("a fresh handshake yields a different key each time (ephemeral)", () => {
    const host = createTransportIdentity();
    const keyOf = () => {
      const hello = transportClientHello();
      return transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic: hello.ephemeralPublic })
        .sessionKey;
    };
    expect(keyOf()).not.toBe(keyOf());
  });

  it("a wrong host key breaks agreement (authenticates the host / defeats MITM)", () => {
    const hello = transportClientHello();
    const realHost = createTransportIdentity();
    const impostor = createTransportIdentity();
    const accepted = transportServerAccept({
      hostSecret: impostor.secretKey,
      clientEphemeralPublic: hello.ephemeralPublic,
    });
    // The client trusts the REAL host's public key (from the QR); an impostor's reply won't agree.
    const clientKey = transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: realHost.publicKey,
      hostEphemeralPublic: accepted.hostEphemeralPublic,
    });
    expect(clientKey).not.toBe(accepted.sessionKey);
  });

  it("seals and opens a frame round-trip with bound aad", () => {
    const { clientKey, serverKey } = handshake();
    const blob = sealTransport(clientKey, JSON.stringify({ hello: "world" }), "POST|/api/messages");
    expect(openTransport(serverKey, blob, "POST|/api/messages")).toBe('{"hello":"world"}');
  });

  it("rejects a frame opened under a different aad (no cross-route replay)", () => {
    const { clientKey, serverKey } = handshake();
    const blob = sealTransport(clientKey, "secret", "POST|/api/messages");
    expect(openTransport(serverKey, blob, "POST|/api/admin/kill-switch")).toBeNull();
  });

  it("rejects a tampered frame and a wrong key", () => {
    const { clientKey } = handshake();
    const other = handshake();
    const blob = sealTransport(clientKey, "secret", "aad");
    expect(openTransport(other.clientKey, blob, "aad")).toBeNull(); // wrong key
    // Flip the FIRST base64url char, not the last: every bit of char 0 maps to the first nonce byte,
    // so the tamper always changes the decoded bytes. (Tampering the last char was ~1/64k-flaky — its
    // trailing bits can be unused base64 padding, or already equal to the replacement.)
    const tampered = (blob[0] === "A" ? "B" : "A") + blob.slice(1);
    expect(openTransport(clientKey, tampered, "aad")).toBeNull(); // tampered
    expect(openTransport(clientKey, "!!!not-base64!!!", "aad")).toBeNull(); // malformed
  });

  it("fingerprint is stable per key, differs across keys, and is 5 emoji", () => {
    const a = createTransportIdentity();
    const b = createTransportIdentity();
    expect(transportFingerprint(a.publicKey)).toBe(transportFingerprint(a.publicKey));
    expect([...transportFingerprint(a.publicKey)].length).toBe(5);
    // Extremely unlikely to collide; guards against a constant/empty implementation.
    expect(transportFingerprint(a.publicKey)).not.toBe(transportFingerprint(b.publicKey));
  });
});

describe("verifyTransportKeypair (docs/20 #7)", () => {
  it("accepts a genuine keypair and rejects mismatched / malformed records", () => {
    const id = createTransportIdentity();
    const other = createTransportIdentity();
    expect(verifyTransportKeypair(id.publicKey, id.secretKey)).toBe(true);
    expect(verifyTransportKeypair(other.publicKey, id.secretKey)).toBe(false); // public ≠ derived
    expect(verifyTransportKeypair(id.publicKey, "AAAA")).toBe(false); // wrong-length secret
    expect(verifyTransportKeypair(id.publicKey, "!!!not-base64!!!")).toBe(false); // malformed
  });
});
