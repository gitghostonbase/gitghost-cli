/**
 * gitghost verify <commit-sha>
 *
 *   1. Read the commit message
 *   2. Parse the Ghost-* trailers
 *   3. Re-derive ring members + verify LSAG signature
 *   4. Check key image hasn't been seen before in this ring's anchor log
 *   5. Report verification result
 */

import { hexToBytes } from "@noble/hashes/utils";
import ora from "ora";
import { openRepo, parseGhostTrailers, stripGhostTrailers } from "../core/git.js";
import {
  loadRing,
  loadAnchors,
} from "../core/storage.js";
import {
  parseSignature,
  verify as verifyLsag,
} from "../core/lsag.js";
import { computeRingRoot, shortKeyImage } from "../core/ringRoot.js";
import * as ui from "../utils/ui.js";

export async function verifyCommand(commitArg: string): Promise<void> {
  if (!commitArg) {
    ui.error("usage: gitghost verify <commit-sha>");
    process.exitCode = 1;
    return;
  }

  const cleaned = commitArg.replace(/^ghost-/, "").trim();
  const repo = await openRepo();

  const spinner = ora({ text: "fetching commit...", color: "white" }).start();
  let fullSha: string;
  let body: string;
  try {
    fullSha = (await repo.git.revparse([cleaned])).trim();
    body = await repo.git.raw(["log", "-1", "--format=%B", fullSha]);
  } catch (e: any) {
    spinner.fail(`unknown commit: ${cleaned}`);
    process.exitCode = 1;
    return;
  }

  const trailers = parseGhostTrailers(body);
  if (!trailers.signature || !trailers.ringRoot || !trailers.keyImage) {
    spinner.fail("not a ghost commit (missing trailers)");
    process.exitCode = 1;
    return;
  }
  spinner.succeed("trailers parsed");

  const ring = loadRing(repo.root);
  if (!ring) {
    ui.error("no ring config — verifier needs the ring set");
    ui.dim("re-clone the .gitghost/ring.json from the project");
    process.exitCode = 1;
    return;
  }

  const expectedRoot = computeRingRoot(ring);
  if (expectedRoot !== trailers.ringRoot) {
    ui.error("ring root mismatch — local ring does not match commit");
    ui.kv("commit ring root", trailers.ringRoot);
    ui.kv("local ring root", expectedRoot);
    process.exitCode = 1;
    return;
  }

  // Reconstruct the canonical message that was signed: this MUST match the
  // exact bytes commit.ts encoded (`${ringRoot}|${canonicalMessage}` where
  // canonicalMessage = opts.message.trim()). Stripping the trailer block and
  // trimming gives us back the canonical commit body.
  const canonicalMessage = stripGhostTrailers(body);

  const messageBytes = new TextEncoder().encode(
    `${expectedRoot}|${canonicalMessage}`
  );
  const contextBytes = hexToBytes(ring.context);
  const ringPubs = ring.members.map((m) => hexToBytes(m.publicKey));

  let signature;
  try {
    signature = parseSignature(trailers.signature, ring.members.length);
  } catch (e: any) {
    ui.error(`malformed signature: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  const verifier = ora({
    text: "verifying LSAG signature...",
    color: "white",
  }).start();

  const valid = verifyLsag({
    message: messageBytes,
    ring: ringPubs,
    context: contextBytes,
    signature,
  });

  if (!valid) {
    verifier.fail("✗ signature INVALID");
    process.exitCode = 1;
    return;
  }
  verifier.succeed("signature valid");

  // Check key image uniqueness against local anchor log.
  // Both fullSha (from revparse) and a.commit (from prior commits) are full
  // 40-char SHAs, so equality is sufficient and unambiguous.
  const anchors = loadAnchors(repo.root);
  const reuses = anchors.anchors.filter(
    (a) =>
      a.keyImage === trailers.keyImage &&
      a.commit.toLowerCase() !== fullSha.toLowerCase()
  );

  console.log();
  ui.success(`ring: ${ring.name} (${ring.members.length} members)`);
  if (reuses.length > 0) {
    ui.error("key image reused across multiple commits:");
    for (const r of reuses) ui.dim(`   ${r.commit.slice(0, 12)}`);
  } else {
    ui.success("key image unique");
  }
  ui.success(`anchored locally`);

  console.log();
  ui.kv("commit", fullSha);
  ui.kv("ring root", trailers.ringRoot);
  ui.kv("key image", shortKeyImage(trailers.keyImage));
  ui.kv(
    "author",
    `one of ${ring.members.length} contributors`
  );
  ui.kv("identity", "not revealed");
  console.log();

  console.log("  ring members (any one of these signed):");
  for (const m of ring.members) {
    const handle = m.github === "self" ? "(local identity)" : `@${m.github}`;
    ui.bullet(handle, ui.shortHex(m.publicKey, 10, 6));
  }
}
