/**
 * Git integration helpers — locate the repo, write commit trailers,
 * compute commit hashes, look up the working repo via simple-git.
 */

import path from "node:path";
import fs from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";

export interface RepoContext {
  root: string;
  git: SimpleGit;
}

/**
 * Walk upward from cwd to find a directory containing `.git`.
 */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  // Limit traversal so we don't hit infinite loops on weird filesystems
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export async function openRepo(): Promise<RepoContext> {
  const root = findRepoRoot();
  if (!root) {
    throw new Error(
      "not inside a git repository — run `git init` or cd into one first."
    );
  }
  const git = simpleGit(root);
  return { root, git };
}

/**
 * Format the LSAG signature + ring root + key image as a set of
 * RFC-7322-style commit trailers. Trailers go on the last paragraph
 * of the commit message and are picked up by `git interpret-trailers`.
 */
export function formatGhostTrailers(input: {
  ringRoot: string;
  keyImage: string;
  ringName: string;
  ringSize: number;
  signature: string;
}): string {
  return [
    "",
    "",
    `Ghost-Ring: ${input.ringName} (${input.ringSize} members)`,
    `Ghost-Ring-Root: ${input.ringRoot}`,
    `Ghost-Key-Image: ${input.keyImage}`,
    `Ghost-Signature: ${input.signature}`,
  ].join("\n");
}

export interface ParsedGhostTrailers {
  ringName?: string;
  ringSize?: number;
  ringRoot?: string;
  keyImage?: string;
  signature?: string;
  /** Index of the first trailer line in the original message (line-aligned). */
  trailerStartLine?: number;
}

/**
 * Parse Ghost-* trailers from a commit message.
 *
 * Robust strategy: scan from the END of the message looking for a contiguous
 * block of trailer-shaped lines (`Ghost-X: value`). The block must be the
 * last paragraph in the message (a leading blank line separator is normal).
 *
 * This avoids the brittle `message.indexOf("Ghost-Ring:")` approach which
 * misfires when the user's commit description text happens to contain the
 * literal string "Ghost-Ring:" before the actual trailers.
 */
export function parseGhostTrailers(message: string): ParsedGhostTrailers {
  const out: ParsedGhostTrailers = {};
  // Use a non-locale-dependent split. Strip trailing whitespace once but
  // preserve leading content (we walk from the end).
  const lines = message.replace(/\s+$/, "").split("\n");

  // Walk backward to find the last contiguous block of trailer-shaped lines.
  // A trailer-shaped line either matches /^Ghost-\w+: / or is a continuation
  // line starting with whitespace (we don't currently emit multi-line ghost
  // trailers but support skipping them defensively).
  let blockStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (/^Ghost-[A-Za-z][A-Za-z0-9-]*:\s/.test(ln)) {
      blockStart = i;
      continue;
    }
    if (ln.length === 0) {
      // Blank line above the trailer block ends the scan.
      break;
    }
    // Any other non-trailer line: we stop and discard everything seen so far,
    // since trailers must be the trailing paragraph.
    blockStart = lines.length;
    break;
  }

  if (blockStart === lines.length) return out;

  out.trailerStartLine = blockStart;
  for (let i = blockStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("Ghost-Ring-Root:")) {
      out.ringRoot = line.slice("Ghost-Ring-Root:".length).trim();
    } else if (line.startsWith("Ghost-Key-Image:")) {
      out.keyImage = line.slice("Ghost-Key-Image:".length).trim();
    } else if (line.startsWith("Ghost-Signature:")) {
      out.signature = line.slice("Ghost-Signature:".length).trim();
    } else if (line.startsWith("Ghost-Ring:")) {
      const value = line.slice("Ghost-Ring:".length).trim();
      const m = value.match(/^(.+?)\s*\((\d+)\s*members?\)\s*$/);
      if (m) {
        out.ringName = m[1];
        out.ringSize = Number(m[2]);
      } else {
        out.ringName = value;
      }
    }
  }
  return out;
}

/**
 * Strip Ghost-* trailers off a commit message, returning the canonical body
 * the trailers were computed against. This MUST mirror exactly what the
 * `commit` command signs (canonicalMessage = opts.message.trim()).
 */
export function stripGhostTrailers(message: string): string {
  const parsed = parseGhostTrailers(message);
  if (parsed.trailerStartLine === undefined) return message.trim();

  const lines = message.replace(/\s+$/, "").split("\n");
  // Drop everything from the trailer block down. Then trim the remaining
  // body so the output matches `opts.message.trim()` from `commit`.
  const body = lines.slice(0, parsed.trailerStartLine).join("\n");
  return body.trim();
}
