/**
 * Linkable Spontaneous Anonymous Group (LSAG) Signature
 * over secp256k1.
 *
 * Based on:
 *   Liu, Wei, Wong (2004) — "Linkable Spontaneous Anonymous Group Signature
 *   for Ad Hoc Groups" (IACR ePrint 2004/027)
 *   https://eprint.iacr.org/2004/027
 *
 * And the practical sketch from rot256:
 *   https://rot256.dev/post/git-ring/
 *
 * Properties:
 *   - Anonymity:    signer indistinguishable within ring
 *   - Linkability:  same key in same context produces same key image
 *   - Spontaneity:  no group manager, no setup ceremony
 *
 * Note: this implementation is for product demonstration. Keys are loaded from
 * github.com/{user}.keys (RSA / ed25519). For LSAG we operate on secp256k1 -
 * keys are derived deterministically from a seed for the demo. Production use
 * should perform proper hash-to-curve over the canonical key material.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils";

const CURVE = secp256k1;
const N = CURVE.CURVE.n;
const G = CURVE.ProjectivePoint.BASE;

export type Point = ReturnType<typeof CURVE.ProjectivePoint.fromHex>;

export interface RingSignature {
  c0: string;       // hex - first challenge
  s: string[];      // hex - response scalars
  keyImage: string; // hex - compressed point
}

/* ------------------------------------------------------------------ */
/* big-int helpers                                                    */
/* ------------------------------------------------------------------ */

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

function bigIntToBytes(n: bigint, length = 32): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function modN(n: bigint): bigint {
  const m = n % N;
  return m < 0n ? m + N : m;
}

function randomScalar(): bigint {
  while (true) {
    const k = bytesToBigInt(randomBytes(32));
    if (k > 0n && k < N) return k;
  }
}

/* ------------------------------------------------------------------ */
/* hash helpers                                                       */
/* ------------------------------------------------------------------ */

function hashToScalar(...parts: Uint8Array[]): bigint {
  const total = parts.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return modN(bytesToBigInt(sha256(buf)));
}

/**
 * Hash-to-point via try-and-increment.
 * Maps an arbitrary input to a deterministic curve point.
 * (For production: use RFC 9380 hash-to-curve. This is the
 * approach git-ring and the LSAG paper use.)
 */
function hashToPoint(input: Uint8Array): Point {
  let counter = 0;
  while (counter < 2 ** 16) {
    const h = sha256(
      Uint8Array.from([...input, ...bigIntToBytes(BigInt(counter), 4)])
    );
    // try as compressed-x with even y
    try {
      const candidate = new Uint8Array(33);
      candidate[0] = 0x02;
      candidate.set(h, 1);
      const p = CURVE.ProjectivePoint.fromHex(candidate);
      p.assertValidity();
      return p;
    } catch {
      counter++;
      continue;
    }
  }
  throw new Error("hash-to-point failed");
}

/* ------------------------------------------------------------------ */
/* keypair                                                            */
/* ------------------------------------------------------------------ */

export interface Keypair {
  secret: Uint8Array;       // 32-byte scalar
  publicKey: Uint8Array;    // 33-byte compressed
}

export function generateKeypair(): Keypair {
  const secret = randomBytes(32);
  const sk = modN(bytesToBigInt(secret));
  const pk = G.multiply(sk).toRawBytes(true);
  return { secret: bigIntToBytes(sk), publicKey: pk };
}

export function publicKeyFromSecret(secret: Uint8Array): Uint8Array {
  const sk = modN(bytesToBigInt(secret));
  return G.multiply(sk).toRawBytes(true);
}

/* ------------------------------------------------------------------ */
/* key image                                                          */
/*   I = sk * H_p(pk || context)                                      */
/* ------------------------------------------------------------------ */

export function computeKeyImage(
  secret: Uint8Array,
  publicKey: Uint8Array,
  context: Uint8Array
): Uint8Array {
  const sk = modN(bytesToBigInt(secret));
  const hp = hashToPoint(
    Uint8Array.from([...publicKey, ...context])
  );
  return hp.multiply(sk).toRawBytes(true);
}

/* ------------------------------------------------------------------ */
/* sign                                                               */
/* ------------------------------------------------------------------ */

export function sign(opts: {
  message: Uint8Array;
  ring: Uint8Array[];      // public keys (compressed)
  signerIndex: number;
  secret: Uint8Array;
  context: Uint8Array;     // ring identifier / scope
}): RingSignature {
  const { message, ring, signerIndex, secret, context } = opts;
  const n = ring.length;
  if (signerIndex < 0 || signerIndex >= n) {
    throw new Error("signerIndex out of range");
  }

  const sk = modN(bytesToBigInt(secret));
  const signerPub = ring[signerIndex];
  const expectedPub = G.multiply(sk).toRawBytes(true);
  if (!eq(signerPub, expectedPub)) {
    throw new Error("secret does not match signerIndex public key");
  }

  // key image
  const keyImage = computeKeyImage(secret, signerPub, context);
  const I = CURVE.ProjectivePoint.fromHex(keyImage);

  // hash-to-point of all ring members (cached)
  const Hp = ring.map((pk) =>
    hashToPoint(Uint8Array.from([...pk, ...context]))
  );

  const s: bigint[] = new Array(n).fill(0n);
  const c: bigint[] = new Array(n).fill(0n);

  // 1. random alpha for signer
  const alpha = randomScalar();

  // 2. compute signer's L,R
  const Ls = G.multiply(alpha);
  const Rs = Hp[signerIndex].multiply(alpha);

  // 3. challenge of next index
  const next = (signerIndex + 1) % n;
  c[next] = hashToScalar(
    message,
    Uint8Array.from([...keyImage]),
    Ls.toRawBytes(true),
    Rs.toRawBytes(true)
  );

  // 4. walk around the ring
  for (let step = 1; step < n; step++) {
    const i = (signerIndex + step) % n;
    s[i] = randomScalar();

    const Pi = CURVE.ProjectivePoint.fromHex(ring[i]);
    // L_i = s_i*G + c_i*P_i
    const Li = G.multiply(s[i]).add(Pi.multiply(c[i]));
    // R_i = s_i*Hp_i + c_i*I
    const Ri = Hp[i].multiply(s[i]).add(I.multiply(c[i]));

    const ni = (i + 1) % n;
    c[ni] = hashToScalar(
      message,
      Uint8Array.from([...keyImage]),
      Li.toRawBytes(true),
      Ri.toRawBytes(true)
    );
  }

  // 5. close the ring at signer
  s[signerIndex] = modN(alpha - c[signerIndex] * sk);

  return {
    c0: bytesToHex(bigIntToBytes(c[0])),
    s: s.map((si) => bytesToHex(bigIntToBytes(si))),
    keyImage: bytesToHex(keyImage),
  };
}

/* ------------------------------------------------------------------ */
/* verify                                                             */
/* ------------------------------------------------------------------ */

export function verify(opts: {
  message: Uint8Array;
  ring: Uint8Array[];
  context: Uint8Array;
  signature: RingSignature;
}): boolean {
  const { message, ring, context, signature } = opts;
  const n = ring.length;
  if (signature.s.length !== n) return false;

  const keyImage = hexToBytes(signature.keyImage);
  let I: Point;
  try {
    I = CURVE.ProjectivePoint.fromHex(keyImage);
    I.assertValidity();
  } catch {
    return false;
  }

  const Hp = ring.map((pk) =>
    hashToPoint(Uint8Array.from([...pk, ...context]))
  );

  const s = signature.s.map((hex) => bytesToBigInt(hexToBytes(hex)));
  let c = bytesToBigInt(hexToBytes(signature.c0));
  const c0 = c;

  for (let i = 0; i < n; i++) {
    const Pi = CURVE.ProjectivePoint.fromHex(ring[i]);
    const Li = G.multiply(s[i]).add(Pi.multiply(c));
    const Ri = Hp[i].multiply(s[i]).add(I.multiply(c));
    c = hashToScalar(
      message,
      keyImage,
      Li.toRawBytes(true),
      Ri.toRawBytes(true)
    );
  }
  return c === c0;
}

/* ------------------------------------------------------------------ */
/* serialization                                                      */
/* ------------------------------------------------------------------ */

export function serializeSignature(sig: RingSignature): string {
  // compact format: lsag1.<c0>.<s_joined>.<keyImage>
  return `lsag1.${sig.c0}.${sig.s.join("")}.${sig.keyImage}`;
}

export function parseSignature(input: string, ringSize: number): RingSignature {
  const parts = input.split(".");
  if (parts.length !== 4 || parts[0] !== "lsag1") {
    throw new Error("invalid LSAG signature format");
  }
  const [, c0, sJoined, keyImage] = parts;
  if (sJoined.length !== ringSize * 64) {
    throw new Error(`invalid s length: expected ${ringSize * 64}, got ${sJoined.length}`);
  }
  const s: string[] = [];
  for (let i = 0; i < ringSize; i++) {
    s.push(sJoined.slice(i * 64, (i + 1) * 64));
  }
  return { c0, s, keyImage };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
