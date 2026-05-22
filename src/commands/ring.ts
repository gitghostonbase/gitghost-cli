/**
 * gitghost ring <subcommand>
 *
 *   ring add <github-username>     pull keys from github.com/<user>.keys
 *   ring add-self                  add yourself (using your local identity)
 *   ring remove <github-username>  remove a member
 *   ring list                      show current ring + root hash
 */

import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import ora from "ora";
import { openRepo } from "../core/git.js";
import {
  loadRing,
  saveRing,
  loadIdentity,
  type RingConfig,
  type RingMember,
} from "../core/storage.js";
import {
  fetchGithubKeys,
  deriveGhostPublicKey,
} from "../core/github.js";
import { computeRingRoot } from "../core/ringRoot.js";
import * as ui from "../utils/ui.js";

function ensureRing(repoRoot: string): RingConfig {
  const ring = loadRing(repoRoot);
  if (!ring) {
    ui.error("no ring config found — run `gitghost init` first");
    process.exit(1);
  }
  return ring;
}

export async function ringAdd(username: string): Promise<void> {
  if (!username) {
    ui.error("usage: gitghost ring add <github-username>");
    process.exitCode = 1;
    return;
  }
  const cleaned = username.replace(/^@/, "").trim();
  const repo = await openRepo();
  const ring = ensureRing(repo.root);

  if (ring.members.some((m) => m.github.toLowerCase() === cleaned.toLowerCase())) {
    ui.error(`@${cleaned} is already in the ring`);
    process.exitCode = 1;
    return;
  }

  const spinner = ora({
    text: `pulling github.com/${cleaned}.keys`,
    color: "white",
    spinner: "dots",
  }).start();

  let keys;
  try {
    keys = await fetchGithubKeys(cleaned);
  } catch (e: any) {
    spinner.fail(`failed: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  if (keys.length === 0) {
    spinner.warn(`@${cleaned} has no public keys on github`);
    process.exitCode = 1;
    return;
  }

  spinner.succeed(`pulled ${keys.length} key(s) for @${cleaned}`);

  // Derive a deterministic secp256k1 ghost key from the user's first SSH key fingerprint
  const primary = keys[0];
  const ghostPub = deriveGhostPublicKey(cleaned, primary.fingerprint);

  const member: RingMember = {
    github: cleaned,
    publicKey: bytesToHex(ghostPub),
    source: "github",
    fetchedAt: Date.now(),
  };
  ring.members.push(member);
  saveRing(repo.root, ring);

  ui.success(`added @${cleaned}`);
  ui.kv("ssh type", primary.type);
  ui.kv("fingerprint", primary.fingerprint);
  ui.kv("ghost pub", ui.shortHex(member.publicKey, 10, 6));

  const root = computeRingRoot(ring);
  ui.dim("");
  ui.dim(`ring root: ${root}`);
  ui.dim(`ring size: ${ring.members.length}`);
}

export async function ringAddSelf(): Promise<void> {
  const repo = await openRepo();
  const ring = ensureRing(repo.root);
  const identity = loadIdentity(repo.root);
  if (!identity) {
    ui.error("no local identity — run `gitghost init` first");
    process.exitCode = 1;
    return;
  }

  if (ring.members.some((m) => m.publicKey === identity.publicKey)) {
    ui.error("your local identity is already in the ring");
    process.exitCode = 1;
    return;
  }

  const member: RingMember = {
    github: "self",
    publicKey: identity.publicKey,
    source: "local",
    fetchedAt: Date.now(),
  };
  ring.members.push(member);
  saveRing(repo.root, ring);

  ui.success(`added local identity ${ui.shortHex(identity.publicKey, 10, 6)}`);
  ui.dim(`ring size: ${ring.members.length}`);
}

export async function ringRemove(username: string): Promise<void> {
  const cleaned = (username ?? "").replace(/^@/, "").trim();
  if (!cleaned) {
    ui.error("usage: gitghost ring remove <github-username>");
    process.exitCode = 1;
    return;
  }
  const repo = await openRepo();
  const ring = ensureRing(repo.root);

  const before = ring.members.length;
  const removed = ring.members.find(
    (m) => m.github.toLowerCase() === cleaned.toLowerCase()
  );
  ring.members = ring.members.filter(
    (m) => m.github.toLowerCase() !== cleaned.toLowerCase()
  );
  if (ring.members.length === before || !removed) {
    ui.error(`@${cleaned} not in ring`);
    process.exitCode = 1;
    return;
  }
  saveRing(repo.root, ring);
  ui.success(`removed @${cleaned}`);
  ui.dim(`ring size: ${ring.members.length}`);

  // Removing your own identity from the ring means future commits will fail
  // signing (you are not in the ring you are signing into). Surface this
  // loudly so the user can re-add themselves if it was accidental.
  const identity = loadIdentity(repo.root);
  if (identity && removed.publicKey === identity.publicKey) {
    console.log();
    ui.error("you removed your own local identity from the ring.");
    ui.dim("future `gitghost commit` calls will fail until you re-join:");
    ui.dim("  gitghost ring add-self");
  }

  // Anonymity quality warning: tiny rings are essentially named.
  if (ring.members.length < 2) {
    console.log();
    ui.error("ring has fewer than 2 members - signing is no longer anonymous.");
  } else if (ring.members.length === 2) {
    console.log();
    ui.dim(
      "warning: a 2-member ring gives only 50% anonymity. consider adding more members."
    );
  }
}

export async function ringList(): Promise<void> {
  const repo = await openRepo();
  const ring = ensureRing(repo.root);
  ui.header(`ring · ${ring.name}`);
  ui.kv("members", String(ring.members.length));
  ui.kv("root", computeRingRoot(ring));
  ui.kv("context", ui.shortHex(ring.context, 10, 6));
  console.log();

  if (ring.members.length === 0) {
    ui.dim("no members yet — `gitghost ring add <user>`");
    return;
  }
  for (const m of ring.members) {
    const handle = m.github === "self" ? "(local identity)" : `@${m.github}`;
    ui.bullet(handle, ui.shortHex(m.publicKey, 10, 6));
  }
}
