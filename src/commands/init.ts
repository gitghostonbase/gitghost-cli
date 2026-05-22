/**
 * gitghost init [ring-name]
 *
 * Bootstraps the .gitghost directory in the current repo:
 *   - generates a local secp256k1 identity (your secret key)
 *   - creates a ring config with the given name
 *   - context bytes are derived from the ring name + repo root
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { openRepo } from "../core/git.js";
import {
  createEmptyRing,
  ensureGhostDir,
  isInitialized,
  loadOrCreateIdentity,
  saveRing,
} from "../core/storage.js";
import * as ui from "../utils/ui.js";

export async function initCommand(name: string | undefined): Promise<void> {
  const ringName = (name ?? "default").trim();
  if (!ringName) {
    ui.error("ring name cannot be empty");
    process.exitCode = 1;
    return;
  }

  const repo = await openRepo();
  ensureGhostDir(repo.root);

  if (isInitialized(repo.root)) {
    ui.error(".gitghost already initialized in this repo");
    ui.dim("delete .gitghost/ to start over");
    process.exitCode = 1;
    return;
  }

  ui.info("initializing gitghost...");
  const identity = loadOrCreateIdentity(repo.root);
  ui.success(`identity created  ${ui.shortHex(identity.publicKey, 10, 6)}`);
  ui.dim(".gitghost/.gitignore written - secret key will NOT be committed");

  // Sanity check: if identity.json is already tracked by git (e.g. user ran
  // gitghost in an existing repo where they previously committed it), warn
  // loudly. The user must `git rm --cached` it themselves; we do not touch
  // their git index.
  try {
    const tracked = await repo.git.raw([
      "ls-files",
      "--error-unmatch",
      ".gitghost/identity.json",
    ]);
    if (tracked && tracked.trim().length > 0) {
      ui.error("WARNING: .gitghost/identity.json is tracked by git!");
      ui.dim("your secret key is already in version history.");
      ui.dim("run: git rm --cached .gitghost/identity.json");
      ui.dim("then rotate by deleting .gitghost/identity.json and re-running init.");
    }
  } catch {
    // ls-files --error-unmatch exits non-zero when the file is NOT tracked.
    // That is the happy path; nothing to do.
  }

  const context = bytesToHex(
    sha256(new TextEncoder().encode(`gitghost.v1.context|${ringName}`))
  );

  const ring = createEmptyRing(ringName, context);
  saveRing(repo.root, ring);
  ui.success(`ring '${ringName}' created`);

  ui.dim("");
  ui.dim("next:");
  console.log("  gitghost ring add <github-username>");
  console.log("  gitghost commit -m \"your message\"");
}
