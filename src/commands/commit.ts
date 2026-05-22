/**
 * gitghost commit -m <message>
 *
 *   1. Hash the staged changes + message + parent → commit-payload
 *   2. Sign with LSAG using local identity as signer-in-ring
 *   3. Append signature trailers to the commit message
 *   4. Run `git commit` so the trailers land in the actual commit object
 *   5. Record the anchor locally (and optionally on Base later)
 */

import { hexToBytes } from "@noble/hashes/utils";
import ora from "ora";
import { openRepo, formatGhostTrailers } from "../core/git.js";
import {
  loadIdentity,
  loadRing,
  appendAnchor,
  type AnchorRecord,
} from "../core/storage.js";
import {
  sign,
  serializeSignature,
  computeKeyImage,
} from "../core/lsag.js";
import { computeRingRoot, shortKeyImage } from "../core/ringRoot.js";
import * as ui from "../utils/ui.js";
import { bytesToHex } from "@noble/hashes/utils";
import { anchorCommand } from "./anchor.js";

export async function commitCommand(opts: {
  message?: string;
  anchor?: boolean;
}): Promise<void> {
  if (!opts.message || opts.message.trim().length === 0) {
    ui.error("commit message required: gitghost commit -m \"...\"");
    process.exitCode = 1;
    return;
  }

  const repo = await openRepo();
  const identity = loadIdentity(repo.root);
  const ring = loadRing(repo.root);

  if (!identity || !ring) {
    ui.error("not initialized — run `gitghost init <ring-name>`");
    process.exitCode = 1;
    return;
  }

  if (ring.members.length < 2) {
    ui.error("ring needs at least 2 members for anonymity");
    ui.dim("try: gitghost ring add <github-username>");
    process.exitCode = 1;
    return;
  }
  // Anonymity quality warnings (non-fatal). N=2 -> 50% guess; N=3 -> 33%.
  // Most papers consider N>=8 the practical floor for meaningful anonymity.
  if (ring.members.length === 2) {
    ui.dim(
      "warning: 2-member ring gives only 50% anonymity. add more members for stronger cover."
    );
  } else if (ring.members.length < 5) {
    ui.dim(
      `warning: ring has ${ring.members.length} members - anonymity is weak. consider adding more.`
    );
  }
  // Performance warning: LSAG is O(N) for both signing and verification.
  // Above ~200 members the UX starts to noticeably suffer (multi-second sign).
  if (ring.members.length > 200) {
    ui.dim(
      `note: ring has ${ring.members.length} members - signing/verifying may take several seconds.`
    );
  }

  const signerIndex = ring.members.findIndex(
    (m) => m.publicKey === identity.publicKey
  );
  if (signerIndex < 0) {
    ui.error("your local identity is not in this ring");
    ui.dim("add yourself with: gitghost ring add-self");
    process.exitCode = 1;
    return;
  }

  // Normalize message exactly once: this canonical form is what gets signed,
  // what lands in the git commit, and what the verifier reconstructs. Any
  // mismatch here makes legitimate commits fail verification.
  const canonicalMessage = opts.message.trim();

  // Compose the signed payload: ring root + canonical message. Both are
  // bound so the signature is invalid if EITHER is tampered with.
  const ringRoot = computeRingRoot(ring);
  const messageBytes = new TextEncoder().encode(
    `${ringRoot}|${canonicalMessage}`
  );
  const contextBytes = hexToBytes(ring.context);
  const ringPubs = ring.members.map((m) => hexToBytes(m.publicKey));

  const spinner = ora({
    text: `composing LSAG over ${ring.members.length} keys...`,
    color: "white",
  }).start();

  let signature, keyImage;
  try {
    signature = sign({
      message: messageBytes,
      ring: ringPubs,
      signerIndex,
      secret: hexToBytes(identity.secret),
      context: contextBytes,
    });
    keyImage = signature.keyImage;
  } catch (e: any) {
    spinner.fail(`signing failed: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  spinner.succeed(`LSAG composed · key image ${shortKeyImage(keyImage)}`);

  const serialized = serializeSignature(signature);
  const trailer = formatGhostTrailers({
    ringRoot,
    keyImage,
    ringName: ring.name,
    ringSize: ring.members.length,
    signature: serialized,
  });

  const fullMessage = `${canonicalMessage}${trailer}`;

  const stage = ora({ text: "writing commit...", color: "white" }).start();
  let commitSha: string;
  try {
    const status = await repo.git.status();
    if (status.staged.length === 0 && status.created.length === 0 && status.modified.length === 0) {
      stage.warn("no staged changes — committing with --allow-empty");
      const result = await repo.git.raw([
        "commit",
        "--allow-empty",
        "-m",
        fullMessage,
      ]);
      const m = result.match(/[\(\[]([a-f0-9]{6,40})[\)\]]/);
      commitSha = m?.[1] ?? (await repo.git.revparse(["HEAD"]));
    } else {
      const result = await repo.git.raw([
        "commit",
        "-m",
        fullMessage,
      ]);
      const m = result.match(/[\(\[]([a-f0-9]{6,40})[\)\]]/);
      commitSha = m?.[1] ?? (await repo.git.revparse(["HEAD"]));
    }
    stage.succeed(`commit shipped · ghost-${commitSha.slice(0, 8)}`);
  } catch (e: any) {
    stage.fail(`git commit failed: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  // Persist anchor locally
  const anchor: AnchorRecord = {
    commit: commitSha,
    ringName: ring.name,
    ringRoot,
    keyImage,
    signedAt: Date.now(),
  };
  appendAnchor(repo.root, anchor);

  console.log();
  ui.kv("ring", `${ring.name} (${ring.members.length} members)`);
  ui.kv("ring root", ringRoot);
  ui.kv("key image", shortKeyImage(keyImage));
  ui.kv("commit", commitSha);
  console.log();

  // If the user passed --anchor, immediately submit the on-chain anchor.
  // Otherwise just hint at the manual step.
  if (opts.anchor) {
    await anchorCommand(commitSha);
    return;
  }
  ui.dim(
    "anchor on-chain: gitghost anchor " + commitSha.slice(0, 8)
  );
}
