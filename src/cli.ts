#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  getGitstoreConfig,
  isInsideGitstoreDir,
  getGitRemote,
  getBranchName,
  pushToGitstore,
  pullFromGitstore,
  diffWithGitstore,
  setupConfig,
  cleanup
} from "./index.js";

async function withCleanup(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

async function guardGitstore(gitstore: string) {
  const cwd = process.cwd();
  if (isInsideGitstoreDir(cwd)) {
    console.error("Error: Cannot run genvx inside the gitstore directory");
    process.exit(1);
  }
  try {
    const currentRemote = await getGitRemote();
    const normalizedCurrent = currentRemote.replace(/\.git$/, "").toLowerCase();
    const normalizedGitstore = gitstore.replace(/\.git$/, "").toLowerCase();
    if (normalizedCurrent === normalizedGitstore) {
      console.error("Error: Cannot run genvx inside the gitstore repository itself");
      process.exit(1);
    }
  } catch {
    // Not in a git repo, that's fine
  }
}

async function resolveGitstore(cliValue: string | undefined): Promise<string> {
  const gitstore = await getGitstoreConfig(cliValue);
  if (!gitstore) {
    console.error("Error: GENVX_STORE not configured");
    console.error("Set it via --gitstore flag, GENVX_STORE env var, or in ~/.genvx/.env.local");
    process.exit(1);
  }
  return gitstore;
}

// Setup yargs CLI
export function runCli() {
  yargs(hideBin(process.argv))
    .scriptName("genvx")
    .usage("$0 [command] [options]")
    .option("gitstore", {
      alias: "g",
      type: "string",
      description: "Git repository URL for storing env files",
    })
    .option("yes", {
      alias: "y",
      type: "boolean",
      description: "Skip confirmation prompts",
      default: false,
    })
    .option("no-encrypt", {
      type: "boolean",
      description: "Disable encryption (not recommended)",
      default: false,
    })
    .fail((msg, err, yargs) => {
      // Check if user typed "version" as a command
      const firstArg = process.argv[2];
      if (firstArg === 'version') {
        console.error('Unknown command: version');
        console.error('\nDid you mean --version?\n');
        console.error(yargs.help());
        process.exit(1);
      }
      if (err) throw err;
      if (msg) {
        console.error(msg);
        process.exit(1);
      }
    })
    .command(
      ["setup", "init"],
      "Interactively configure GENVX_STORE and GENVX_KEY",
      (y) =>
        y.option("dir", {
          type: "string",
          description: "Directory to save the config file (.env.local)",
        }),
      async (argv) => {
        try {
          await setupConfig({
            dir: argv.dir as string | undefined,
            store: argv.gitstore as string | undefined,
            yes: argv.yes as boolean,
          });
        } catch (error) {
          console.error(`Error: ${(error as Error).message}`);
          process.exit(1);
        }
      }
    )
    .command(
      ["push", "p", "save"],
      "Save .env* files to gitstore (encrypted by default)",
      () => { },
      async (argv) => {
        const gitstore = await resolveGitstore(argv.gitstore as string | undefined);
        await guardGitstore(gitstore);
        const useEncryption = !(argv["no-encrypt"] as boolean);
        await withCleanup(() => pushToGitstore(gitstore, argv.yes as boolean, useEncryption));
      }
    )
    .command(
      ["pull", "load"],
      "Load .env* files from gitstore (decrypts if encrypted)",
      () => { },
      async (argv) => {
        const gitstore = await resolveGitstore(argv.gitstore as string | undefined);
        await guardGitstore(gitstore);
        const useEncryption = !(argv["no-encrypt"] as boolean);
        await withCleanup(() => pullFromGitstore(gitstore, argv.yes as boolean, useEncryption));
      }
    )
    .command(
      ["diff", "d"],
      "Show pending .env* file changes (dry run)",
      () => { },
      async (argv) => {
        const gitstore = await resolveGitstore(argv.gitstore as string | undefined);
        await guardGitstore(gitstore);
        const useEncryption = !(argv["no-encrypt"] as boolean);
        await withCleanup(() => diffWithGitstore(gitstore, useEncryption));
      }
    )
    .command(
      ["branch", "b"],
      "Show the hashed branch name for this project",
      () => { },
      async () => {
        try {
          const gitRemote = await getGitRemote();
          const branch = getBranchName(gitRemote);
          console.log(branch);
        } catch (error) {
          console.error("Error:", (error as Error).message);
          process.exit(1);
        }
      }
    )
    .example("$0 setup", "Interactively configure gitstore URL and encryption key")
    .example("$0 setup --dir=~/.config/genvx", "Save config to a custom directory")
    .example("$0 push", "Push all .env* files to gitstore")
    .example("$0 push -y", "Push without confirmation prompt")
    .example("$0 pull", "Pull all .env* files from gitstore")
    .example("$0 pull -y", "Pull without confirmation prompt")
    .example("$0 diff", "Show pending changes without modifying files")
    .example("$0 push --gitstore=https://github.com/user/secrets.git", "Push with specific gitstore")
    .example("$0 branch", "Show hashed branch name for this project")
    .example("$0 push --no-encrypt", "Push without encryption (not recommended)")
    .help()
    .alias("h", "help")
    .version()
    .alias("v", "version")
    .strictCommands()
    .demandCommand(0, 0)
    .parse();
}

if (import.meta.main) {
  runCli();
}
