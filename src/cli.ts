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
import {
  installHooks,
  uninstallHooks,
  hooksStatus,
  runHook,
  type HookMode,
} from "./hooks.js";

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
        y
          .option("dir", {
            type: "string",
            description: "Directory to save the config file (.env.local)",
          })
          .option("hooks", {
            type: "boolean",
            default: true,
            description: "Also set up auto-sync git hooks (use --no-hooks to skip)",
          }),
      async (argv) => {
        try {
          await setupConfig({
            dir: argv.dir as string | undefined,
            store: argv.gitstore as string | undefined,
            yes: argv.yes as boolean,
            hooks: argv.hooks as boolean,
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
        await withCleanup(async () => { await pullFromGitstore(gitstore, argv.yes as boolean, useEncryption); });
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
      "hooks <action> [event]",
      "Manage genvx auto-sync git hooks (install/uninstall/status)",
      (y) =>
        y
          .positional("action", {
            type: "string",
            choices: ["install", "uninstall", "status", "run"] as const,
          })
          .positional("event", { type: "string" })
          .option("mode", {
            type: "string",
            choices: ["auto", "local", "lefthook", "shared"] as const,
            default: "auto",
            description: "Install mode (auto picks the cleanest local-only option)",
          }),
      async (argv) => {
        const action = argv.action as string;

        // `run` is invoked by the hook files themselves — must always exit 0.
        if (action === "run") {
          await runHook((argv.event as string) || "manual");
          return;
        }

        try {
          if (action === "install") {
            const r = await installHooks(argv.mode as "auto" | HookMode);
            console.log(
              `✅ Installed genvx auto-sync hooks (mode: ${r.mode}` +
              `${r.manager !== "none" ? `, manager: ${r.manager}` : ""})`
            );
            for (const f of r.files) console.log(`   ${f}`);
            for (const w of r.warnings) console.log(`⚠️  ${w}`);
          } else if (action === "uninstall") {
            const removed = await uninstallHooks();
            if (removed.length === 0) {
              console.log("No genvx hooks found.");
            } else {
              console.log("✅ Removed genvx hooks:");
              for (const f of removed) console.log(`   ${f}`);
            }
          } else if (action === "status") {
            const s = await hooksStatus();
            console.log(
              `Hook manager: ${s.manager}` +
              `${s.hooksPath ? ` (core.hooksPath=${s.hooksPath})` : ""}`
            );
            console.log(`Recommended mode: ${s.recommended}`);
            if (s.installed.length === 0) {
              console.log("genvx hooks: not installed");
            } else {
              console.log("genvx hooks installed in:");
              for (const f of s.installed) console.log(`   ${f}`);
            }
          }
        } catch (error) {
          console.error(`Error: ${(error as Error).message}`);
          process.exit(1);
        }
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
    .example("$0 hooks install", "Install auto-sync hooks (auto-detects local-only mode)")
    .example("$0 hooks install --mode=shared", "Install committed hooks for the whole team")
    .example("$0 hooks status", "Show detected hook manager and installed genvx hooks")
    .example("$0 hooks uninstall", "Remove genvx auto-sync hooks")
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
