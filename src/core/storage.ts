/**
 * Local storage paths and helpers.
 *
 * Layout (created in repo root):
 *   .gitghost/
 *     identity.json      local secret key + pubkey
 *     ring.json          current ring config (members + cached keys)
 *     anchors.json       local index of submitted anchors
 */

import fs from "node:fs";
import path from "node:path";
import { generateKeypair, publicKeyFromSecret } from "./lsag.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export const GHOST_DIR = ".gitghost";
export const IDENTITY_FILE = "identity.json";
export const RING_FILE = "ring.json";
export const ANCHORS_FILE = "anchors.json";
export const GITIGNORE_FILE = ".gitignore";

/**
 * The .gitignore file we drop inside `.gitghost/` on init.
 *
 * We deliberately ignore ONLY the secret-bearing files:
 *   - identity.json holds your secp256k1 secret key. It MUST NEVER be committed.
 *
 * Everything else in `.gitghost/` (ring.json, anchors.json) is meant to be
 * checked in so collaborators and verifiers can re-run `gitghost verify`.
 */
const GHOST_GITIGNORE = `# created by \`gitghost init\` - do NOT remove these lines.
# identity.json contains your secret key. Committing it would deanonymize
# you and let anyone else sign as you. ring.json + anchors.json ARE meant
# to be committed.
identity.json
*.identity.json
`;

export interface Identity {
  version: 1;
  secret: string;     // hex
  publicKey: string;  // hex
  createdAt: number;
}

export interface RingMember {
  github: string;
  publicKey: string;  // hex (compressed secp256k1 derived from github source)
  source: "github" | "local" | "manual";
  fetchedAt: number;
}

export interface RingConfig {
  version: 1;
  name: string;
  context: string;             // hex - canonical context bytes
  members: RingMember[];
  createdAt: number;
}

export interface AnchorRecord {
  commit: string;
  ringName: string;
  ringRoot: string;
  keyImage: string;
  baseTx?: string;
  baseBlock?: number;
  signedAt: number;
}

export interface AnchorsFile {
  version: 1;
  anchors: AnchorRecord[];
}

/* ------------------------------------------------------------------ */

export function ghostPath(repoRoot: string, file?: string): string {
  return file ? path.join(repoRoot, GHOST_DIR, file) : path.join(repoRoot, GHOST_DIR);
}

export function ensureGhostDir(repoRoot: string): void {
  const dir = ghostPath(repoRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  ensureGhostGitignore(repoRoot);
}

/**
 * Write or refresh `.gitghost/.gitignore` so that the secret-bearing
 * `identity.json` is never accidentally committed. Idempotent: safe to call
 * on every operation that touches the ghost dir.
 *
 * If a user has already authored their own `.gitghost/.gitignore`, we leave
 * it alone but make sure `identity.json` is one of its rules; if not, we
 * append the missing rule rather than overwriting the file.
 */
export function ensureGhostGitignore(repoRoot: string): void {
  const file = ghostPath(repoRoot, GITIGNORE_FILE);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, GHOST_GITIGNORE, "utf8");
    return;
  }
  const existing = fs.readFileSync(file, "utf8");
  // Look for a rule that ignores identity.json. We accept any of:
  //   identity.json | /identity.json | *identity.json | **/identity.json
  const hasRule = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some(
      (l) =>
        l === "identity.json" ||
        l === "/identity.json" ||
        l === "*identity.json" ||
        l === "**/identity.json"
    );
  if (!hasRule) {
    const sep = existing.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(
      file,
      `${existing}${sep}# added by gitghost: never commit your secret key\nidentity.json\n`,
      "utf8"
    );
  }
}

export function isInitialized(repoRoot: string): boolean {
  return (
    fs.existsSync(ghostPath(repoRoot, IDENTITY_FILE)) &&
    fs.existsSync(ghostPath(repoRoot, RING_FILE))
  );
}

/* ------------------------------------------------------------------ */
/* identity                                                           */
/* ------------------------------------------------------------------ */

export function loadOrCreateIdentity(repoRoot: string): Identity {
  ensureGhostDir(repoRoot);
  const file = ghostPath(repoRoot, IDENTITY_FILE);
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Identity;
  }
  const kp = generateKeypair();
  const ident: Identity = {
    version: 1,
    secret: bytesToHex(kp.secret),
    publicKey: bytesToHex(kp.publicKey),
    createdAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(ident, null, 2), { mode: 0o600 });
  // POSIX systems honor `mode: 0o600` on write; Windows ignores it. On
  // Windows the file inherits the parent ACL which is typically wider than
  // the user's intent. We try `chmod` defensively (no-op on Windows) and
  // surface a one-time hint so the user can lock it down via filesystem ACL
  // if they care.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore - rare on POSIX, expected on Windows */
  }
  if (process.platform === "win32") {
    // Stash a marker so we don't repeat the warning on every reload.
    const markerFile = ghostPath(repoRoot, ".identity-perm-warned");
    if (!fs.existsSync(markerFile)) {
      console.log(
        "[ghost] note: on Windows, identity.json permissions follow your folder ACL."
      );
      console.log(
        "[ghost]       lock it down with `icacls .gitghost\\identity.json /inheritance:r /grant:r %USERNAME%:F`"
      );
      try {
        fs.writeFileSync(markerFile, String(Date.now()));
      } catch {
        /* non-fatal */
      }
    }
  }
  return ident;
}

export function loadIdentity(repoRoot: string): Identity | null {
  const file = ghostPath(repoRoot, IDENTITY_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Identity;
}

export function identityPublicKey(ident: Identity): Uint8Array {
  // Re-derive to ensure consistency with the secret in case file was migrated
  return publicKeyFromSecret(hexToBytes(ident.secret));
}

/* ------------------------------------------------------------------ */
/* ring                                                               */
/* ------------------------------------------------------------------ */

export function loadRing(repoRoot: string): RingConfig | null {
  const file = ghostPath(repoRoot, RING_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as RingConfig;
}

export function saveRing(repoRoot: string, ring: RingConfig): void {
  ensureGhostDir(repoRoot);
  fs.writeFileSync(
    ghostPath(repoRoot, RING_FILE),
    JSON.stringify(ring, null, 2)
  );
}

export function createEmptyRing(name: string, context: string): RingConfig {
  return {
    version: 1,
    name,
    context,
    members: [],
    createdAt: Date.now(),
  };
}

/* ------------------------------------------------------------------ */
/* anchors                                                            */
/* ------------------------------------------------------------------ */

export function loadAnchors(repoRoot: string): AnchorsFile {
  const file = ghostPath(repoRoot, ANCHORS_FILE);
  if (!fs.existsSync(file)) return { version: 1, anchors: [] };
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnchorsFile;
}

export function appendAnchor(repoRoot: string, anchor: AnchorRecord): void {
  ensureGhostDir(repoRoot);
  const data = loadAnchors(repoRoot);
  data.anchors = data.anchors.filter((a) => a.commit !== anchor.commit);
  data.anchors.push(anchor);
  fs.writeFileSync(
    ghostPath(repoRoot, ANCHORS_FILE),
    JSON.stringify(data, null, 2)
  );
}

/**
 * Look up an anchor by full or short commit SHA.
 *
 * The query must be at least 4 hex chars to keep prefix collisions unlikely.
 * Exact match wins; otherwise the first stored record whose commit STARTS
 * WITH the query is returned. We never match in the opposite direction
 * (i.e. we don't treat `"ab"` stored as matching query `"abcd"`), because
 * stored commits are always full 40-char SHAs from `git rev-parse`.
 */
export function findAnchor(
  repoRoot: string,
  commit: string
): AnchorRecord | null {
  const q = (commit ?? "").trim().toLowerCase();
  if (q.length < 4) return null;
  const data = loadAnchors(repoRoot);
  // Exact match first.
  const exact = data.anchors.find((a) => a.commit.toLowerCase() === q);
  if (exact) return exact;
  // Strict prefix: query is a prefix of stored commit.
  return (
    data.anchors.find((a) => a.commit.toLowerCase().startsWith(q)) ?? null
  );
}
