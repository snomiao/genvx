#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  getGitstoreConfig,
  isInsideGitstoreDir,
  getGitRemote,
  parseGitRemote,
  pushToGitstore,
  pullFromGitstore,
  cleanup
} from "./index.js";

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
      ["sync", "s"],
      "Pull then push .env* files",
      () => { },
      async (argv) => {
        const gitstore = await getGitstoreConfig(argv.gitstore as string | undefined);
        if (!gitstore) {
          console.error("Error: GENVX_STORE not configured");
          console.error("Set it via --gitstore flag, GENVX_STORE env var, or in .env.local");
          process.exit(1);
        }

        // Check if we're inside gitstore
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

        await pullFromGitstore(gitstore);
        await pushToGitstore(gitstore);
        await cleanup();
      }
    )
    .command(
      ["push", "p", "save"],
      "Save .env* files to gitstore",
      () => { },
      async (argv) => {
        const gitstore = await getGitstoreConfig(argv.gitstore as string | undefined);
        if (!gitstore) {
          console.error("Error: GENVX_STORE not configured");
          console.error("Set it via --gitstore flag, GENVX_STORE env var, or in .env.local");
          process.exit(1);
        }

        // Check if we're inside gitstore
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

        await pushToGitstore(gitstore);
        await cleanup();
      }
    )
    .command(
      ["pull", "load"],
      "Load .env* files from gitstore",
      () => { },
      async (argv) => {
        const gitstore = await getGitstoreConfig(argv.gitstore as string | undefined);
        if (!gitstore) {
          console.error("Error: GENVX_STORE not configured");
          console.error("Set it via --gitstore flag, GENVX_STORE env var, or in .env.local");
          process.exit(1);
        }

        // Check if we're inside gitstore
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

        await pullFromGitstore(gitstore);
        await cleanup();
      }
    )
    .example("$0 save", "Save all .env* files to gitstore")
    .example("$0 load", "Load all .env* files from gitstore")
    .example("$0 sync", "Pull then push .env* files")
    .example("$0 push", "Push all .env* files to gitstore")
    .example("$0 pull", "Pull all .env* files from gitstore")
    .example("$0 save --gitstore=https://github.com/user/secrets.git", "Save with specific gitstore")
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
