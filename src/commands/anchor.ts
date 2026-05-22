/**
 * gitghost anchor <commit>
 *
 *   Submit a ghost commit to the GhostRegistry contract on Base via the
 *   sponsored relayer at https://gitghost.org/api/anchor.
 *
 *   The relayer pays gas, but only after re-running full LSAG verification
 *   server-side — so we never anchor anything that doesn't already verify.
 *
 *   Override relayer with --relayer <url>, or fall back to local simulation
 *   with --offline (useful for tests / air-gapped flows).
 */

import ora from "ora";
import {
  openRepo,
  parseGhostTrailers,
} from "../core/git.js";
import {
  appendAnchor,
  findAnchor,
  loadAnchors,
  loadRing,
} from "../core/storage.js";
import * as ui from "../utils/ui.js";

const DEFAULT_RELAYER = "https://gitghost.org/api/anchor";

export interface AnchorOptions {
  relayer?: string;
  offline?: boolean;
}

export async function anchorCommand(
  commitArg: string,
  opts: AnchorOptions = {},
): Promise<void> {
  if (!commitArg) {
    ui.error("usage: gitghost anchor <commit-sha>");
    process.exitCode = 1;
    return;
  }
  const cleaned = commitArg.replace(/^ghost-/, "").trim();
  const repo = await openRepo();

  let fullSha: string;
  try {
    fullSha = (await repo.git.revparse([cleaned])).trim();
  } catch {
    ui.error(`unknown commit: ${cleaned}`);
    process.exitCode = 1;
    return;
  }

  const anchor = findAnchor(repo.root, fullSha);
  if (!anchor) {
    ui.error("no local ghost record for this commit");
    ui.dim("only ghost commits made via `gitghost commit` can be anchored");
    process.exitCode = 1;
    return;
  }

  if (anchor.baseTx && anchor.baseTx !== "0x" && !anchor.baseTx.startsWith("0x0000000000000000")) {
    ui.dim("commit already anchored");
    ui.kv("base tx", anchor.baseTx);
    ui.kv("base block", String(anchor.baseBlock ?? "?"));
    ui.dim(`  https://basescan.org/tx/${anchor.baseTx}`);
    return;
  }

  if (opts.offline) {
    return offlineSimulate(repo.root, fullSha, anchor);
  }

  // Need full message + ring to let the relayer re-verify.
  let body: string;
  try {
    body = await repo.git.raw(["log", "-1", "--format=%B", fullSha]);
  } catch (e) {
    ui.error(`failed to read commit body: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const trailers = parseGhostTrailers(body);
  if (!trailers.signature || !trailers.ringRoot || !trailers.keyImage) {
    ui.error("commit is missing Ghost-* trailers");
    process.exitCode = 1;
    return;
  }

  const ring = loadRing(repo.root);
  if (!ring) {
    ui.error("no ring config — anchor needs .gitghost/ring.json");
    process.exitCode = 1;
    return;
  }

  const relayerUrl = opts.relayer ?? process.env.GITGHOST_RELAYER ?? DEFAULT_RELAYER;
  const spinner = ora({
    text: `submitting to relayer (${relayerUrl})...`,
    color: "white",
  }).start();

  let result: RelayerResult;
  try {
    const res = await fetch(relayerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commitSha: fullSha,
        ringRoot: trailers.ringRoot,
        keyImage: trailers.keyImage,
        message: body,
        ring: JSON.stringify(ring),
      }),
    });
    const json = (await res.json()) as RelayerResult;
    if (!res.ok || !json.ok) {
      const reason = json.error ?? `HTTP ${res.status}`;
      const retryHint =
        json.retryAfterSeconds !== undefined
          ? ` (retry after ${json.retryAfterSeconds}s)`
          : "";
      spinner.fail(`relayer rejected: ${reason}${retryHint}`);
      process.exitCode = 1;
      return;
    }
    result = json;
  } catch (e) {
    spinner.fail(`relayer request failed: ${(e as Error).message}`);
    ui.dim("hint: check connectivity, or pass --offline to simulate locally");
    process.exitCode = 1;
    return;
  }

  if (result.alreadyAnchored) {
    spinner.succeed(
      `already anchored on base block ${result.blockNumber.toLocaleString()}`,
    );
  } else {
    spinner.succeed(
      `anchored to base block ${result.blockNumber.toLocaleString()}`,
    );
  }

  // Persist locally so future `gitghost verify` can short-circuit and
  // future `anchor` invocations dedupe.
  anchor.baseTx = result.txHash;
  anchor.baseBlock = result.blockNumber;
  appendAnchor(repo.root, anchor);

  console.log();
  ui.kv("commit", fullSha);
  ui.kv("base tx", result.txHash);
  ui.kv("base block", String(result.blockNumber));
  ui.kv("basescan", result.basescanUrl);
  if (result.remaining) {
    ui.dim(
      `relayer budget: ${result.remaining.perIp} per-ip · ${result.remaining.daily} daily`,
    );
  }
}

interface RelayerResult {
  ok: boolean;
  error?: string;
  retryAfterSeconds?: number;
  txHash: string;
  blockNumber: number;
  alreadyAnchored?: boolean;
  basescanUrl: string;
  remaining?: { perIp: number; daily: number };
}

/**
 * Local simulation path. Generates a deterministic pseudo-tx so
 * `gitghost verify` can still surface anchor-shaped output offline.
 * Use with `--offline` or in CI environments without network access.
 */
async function offlineSimulate(
  repoRoot: string,
  fullSha: string,
  anchor: ReturnType<typeof findAnchor>,
): Promise<void> {
  if (!anchor) return;
  const { sha256 } = await import("@noble/hashes/sha256");
  const { bytesToHex } = await import("@noble/hashes/utils");

  const seed = sha256(new TextEncoder().encode(fullSha + anchor.keyImage));
  const txHash = "0x" + bytesToHex(seed);
  const block = 28_847_000 + (Number("0x" + bytesToHex(seed).slice(0, 6)) % 5000);

  anchor.baseTx = txHash;
  anchor.baseBlock = block;
  appendAnchor(repoRoot, anchor);

  ui.success(`simulated anchor at block ${block.toLocaleString()}`);
  console.log();
  ui.kv("commit", fullSha);
  ui.kv("base tx", txHash);
  ui.kv("base block", String(block));
  console.log();
  ui.dim("note: --offline simulates the on-chain call without paying gas.");
  ui.dim("real anchors go through https://gitghost.org/api/anchor.");
}

export async function anchorList(): Promise<void> {
  const repo = await openRepo();
  const anchors = loadAnchors(repo.root);
  ui.header(`anchors (${anchors.anchors.length})`);
  if (anchors.anchors.length === 0) {
    ui.dim("no anchored commits yet");
    return;
  }
  for (const a of anchors.anchors) {
    ui.bullet(a.commit.slice(0, 12), a.ringName);
    if (a.baseTx) {
      console.log(`      base tx ${a.baseTx.slice(0, 14)}…  block ${a.baseBlock}`);
    } else {
      console.log("      not yet anchored on base");
    }
  }
}
