#!/usr/bin/env node
/**
 * gitghost — ship code, leave no trace.
 *
 * CLI entrypoint. Wires every subcommand to its handler.
 */

import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initCommand } from "./commands/init.js";
import {
  ringAdd,
  ringAddSelf,
  ringRemove,
  ringList,
} from "./commands/ring.js";
import { commitCommand } from "./commands/commit.js";
import { verifyCommand } from "./commands/verify.js";
import { anchorCommand, anchorList } from "./commands/anchor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };
const VERSION = pkg.version;

const BANNER = `
${chalk.whiteBright("  ┌─────────────────────────────────────┐")}
${chalk.whiteBright("  │   gitghost · ship and disappear     │")}
${chalk.whiteBright("  └─────────────────────────────────────┘")}
${chalk.dim(`     anonymous commits via ring signatures · v${VERSION}`)}
`;

async function main() {
  const program = new Command()
    .name("gitghost")
    .description("anonymous git commits via linkable ring signatures")
    .version(VERSION, "-v, --version")
    .addHelpText("beforeAll", BANNER);

  program
    .command("init")
    .description("initialize gitghost in the current repo")
    .argument("[ring-name]", "name of the initial ring", "default")
    .action(async (name: string | undefined) => {
      await initCommand(name);
    });

  const ring = program
    .command("ring")
    .description("manage the contributor ring");

  ring
    .command("add <github-username>")
    .description("pull keys from github.com/<user>.keys and add to ring")
    .action(async (user: string) => {
      await ringAdd(user);
    });

  ring
    .command("add-self")
    .description("add your local identity to the ring")
    .action(async () => {
      await ringAddSelf();
    });

  ring
    .command("remove <github-username>")
    .description("remove a member from the ring")
    .action(async (user: string) => {
      await ringRemove(user);
    });

  ring
    .command("list")
    .description("print current ring members and root hash")
    .action(async () => {
      await ringList();
    });

  program
    .command("commit")
    .description("create a ring-signed git commit")
    .requiredOption("-m, --message <message>", "commit message")
    .option("-a, --anchor", "anchor immediately on base", false)
    .action(async (opts: { message: string; anchor?: boolean }) => {
      await commitCommand(opts);
    });

  program
    .command("verify <commit-sha>")
    .description("verify a ghost commit's signature and anchor")
    .action(async (sha: string) => {
      await verifyCommand(sha);
    });

  const anchor = program
    .command("anchor")
    .description("anchor a ghost commit on base mainnet");

  anchor
    .argument("[commit-sha]")
    .option("--relayer <url>", "override relayer endpoint")
    .option("--offline", "simulate locally without calling the relayer", false)
    .action(
      async (
        sha: string | undefined,
        opts: { relayer?: string; offline?: boolean },
      ) => {
        if (!sha) {
          await anchorList();
        } else {
          await anchorCommand(sha, opts);
        }
      },
    );

  await program.parseAsync(process.argv);
}

main().catch((e: any) => {
  console.error(chalk.red(`[ghost] error: ${e.message ?? e}`));
  process.exit(1);
});
