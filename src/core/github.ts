/**
 * github.com/{user}.keys integration.
 *
 * GitHub exposes a user's public SSH keys at:
 *   https://github.com/<user>.keys
 *
 * For LSAG over secp256k1 we need a compressed secp256k1 point per
 * member. SSH keys may be ed25519 or RSA, so for product purposes we
 * deterministically derive a secp256k1 keypoint from the canonical
 * SSH key material.
 *
 * NOTE: This derivation is product-grade for demonstration only.
 * Production deployment should either:
 *   (a) standardize on ed25519 SSH keys + LSAG over edwards25519, or
 *   (b) ask each contributor to publish a dedicated secp256k1 ghost
 *       key alongside their SSH key.
 */

import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";

export interface GithubKey {
  raw: string;
  type: string;       // ssh-rsa / ssh-ed25519 / ecdsa-sha2-*
  fingerprint: string;
}

export async function fetchGithubKeys(username: string): Promise<GithubKey[]> {
  const url = `https://github.com/${encodeURIComponent(username)}.keys`;
  const res = await fetch(url, {
    headers: { "User-Agent": "gitghost-cli/0.1.0" },
  });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  return lines.map((raw) => {
    const parts = raw.split(/\s+/);
    const type = parts[0] ?? "ssh-key";
    const fp = bytesToHex(sha256(new TextEncoder().encode(raw))).slice(0, 16);
    return { raw, type, fingerprint: fp };
  });
}

/**
 * Derive a deterministic compressed secp256k1 public key from
 * a github username + ssh key fingerprint. This is reproducible:
 * anyone can verify the same derivation given the same inputs.
 */
export function deriveGhostPublicKey(
  username: string,
  fingerprint: string
): Uint8Array {
  const seed = new TextEncoder().encode(
    `gitghost.v1.derive|${username}|${fingerprint}`
  );
  // hash twice to map into scalar range
  let scalarBytes = sha256(seed);
  for (let i = 0; i < 8; i++) {
    try {
      const sk = secp256k1.utils.normPrivateKeyToScalar(scalarBytes);
      const pk = secp256k1.ProjectivePoint.BASE.multiply(sk).toRawBytes(true);
      return pk;
    } catch {
      scalarBytes = sha256(scalarBytes);
    }
  }
  throw new Error(`unable to derive ghost public key for ${username}`);
}
