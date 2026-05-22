/**
 * Pretty-print helpers used across all commands.
 *
 * Keeps the cyberpunk look consistent with the landing page:
 *   silver / ghost text, dim secondary, terminal-green checks.
 */

import chalk from "chalk";

export const tag = chalk.dim("[ghost]");
export const ok = chalk.green("✓");
export const fail = chalk.red("✗");
export const arrow = chalk.dim("→");

export function info(msg: string): void {
  console.log(`${tag} ${chalk.gray(msg)}`);
}

export function ghost(msg: string): void {
  console.log(`${tag} ${chalk.whiteBright(msg)}`);
}

export function success(msg: string): void {
  console.log(`${tag} ${ok} ${chalk.whiteBright(msg)}`);
}

export function error(msg: string): void {
  console.log(`${tag} ${fail} ${chalk.red(msg)}`);
}

export function dim(msg: string): void {
  console.log(`${tag} ${chalk.dim(msg)}`);
}

export function bullet(msg: string, sub?: string): void {
  const main = chalk.whiteBright(msg);
  if (sub) {
    console.log(`  ${chalk.dim("·")} ${main}  ${chalk.dim(sub)}`);
  } else {
    console.log(`  ${chalk.dim("·")} ${main}`);
  }
}

export function header(text: string): void {
  console.log();
  console.log(chalk.whiteBright(text.toLowerCase()));
  console.log(chalk.dim("─".repeat(Math.min(text.length, 48))));
}

export function kv(key: string, value: string): void {
  console.log(`  ${chalk.dim(key.padEnd(14))} ${chalk.whiteBright(value)}`);
}

export function shortHex(hex: string, head = 8, tail = 4): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}
