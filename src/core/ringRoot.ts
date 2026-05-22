/**
 * Compute a "ring root" — a deterministic identifier for a ring config.
 * Used as the on-chain anchor reference and embedded in the commit
 * trailer so verifiers can re-fetch the exact ring set.
 *
 * Format mimics IPFS CIDs (bafkrei...) for visual familiarity but is
 * actually just a deterministic hash of the ring members. A future
 * version can swap in a real CID by pinning the ring config to IPFS.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { RingConfig } from "./storage.js";

const PREFIX = "bafkrei";

export function computeRingRoot(ring: RingConfig): string {
  const canonical = JSON.stringify({
    name: ring.name,
    context: ring.context,
    members: ring.members
      .slice()
      .sort((a, b) => a.publicKey.localeCompare(b.publicKey))
      .map((m) => ({ github: m.github, publicKey: m.publicKey })),
  });
  const hash = sha256(new TextEncoder().encode(canonical));
  // base32-ish friendly slice
  const hex = bytesToHex(hash);
  return PREFIX + hex.slice(0, 52);
}

export function shortKeyImage(keyImage: string): string {
  if (keyImage.startsWith("ki_")) return keyImage.slice(0, 12);
  return "ki_" + keyImage.slice(0, 8);
}
