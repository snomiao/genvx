#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { execaCommand } from "execa";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// Parse git remote URL to extract host, owner, and repo
function parseGitRemote(remoteUrl: string): { host: string; owner: string; repo: string } {
  // Normalize SSH URLs to HTTPS
  let url = remoteUrl;
  if (url.startsWith("git@")) {
    // git@github.com:owner/repo.git -> https://github.com/owner/repo.git
    url = url.replace(/^git@/, "https://").replace(/\.com:/, ".com/");
  }

  // Remove .git suffix
  url = url.replace(/\.git$/, "");

  // Parse URL
  const match = url.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match || !match[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid git remote URL: ${remoteUrl}`);
  }

  const [, host, owner, repo] = match;
  return { host: host!, owner: owner!, repo: repo! };
}

// Get git remote URL for current repo
async function getGitRemote(): Promise<string> {
  try {
    const result = await execaCommand("git config --get remote.origin.url", {
      shell: true,
    });
    return result.stdout.trim();
  } catch (error) {
    throw new Error("Not in a git repository or no remote origin found");
  }
}

// Get gitstore configuration
function getGitstoreConfig(cliGitstore?: string): string | null {
  // Priority 1: CLI flag
  if (cliGitstore) {
    return cliGitstore;
  }

  // Priority 2: Environment variable
  if (process.env.DENVX_STORE) {
    return process.env.DENVX_STORE;
  }

  // Priority 3: Project .env.local file
  if (existsSync(".env.local")) {
    const content = readFileSync(".env.local", "utf-8");
    const match = content.match(/^DENVX_STORE=(.+)$/m);
    if (match && match[1]) {
      return match[1].replace(/^["']|["']$/g, "");
    }
  }

  // Priority 4: Global ~/.denvx/.env.local file (fallback)
  const globalConfigPath = join(process.env.HOME || "/root", ".denvx", ".env.local");
  if (existsSync(globalConfigPath)) {
    const content = readFileSync(globalConfigPath, "utf-8");
    const match = content.match(/^DENVX_STORE=(.+)$/m);
    if (match && match[1]) {
      return match[1].replace(/^["']|["']$/g, "");
    }
  }

  return null;
}

// Setup .denvx directory
function setupDenvxDir() {
  const denvxDir = "./.denvx";
  const gitignorePath = join(denvxDir, ".gitignore");

  if (!existsSync(denvxDir)) {
    mkdirSync(denvxDir, { recursive: true });
  }

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n");
  }
}

// Clone or pull gitstore repository
async function syncGitstore(gitstoreUrl: string): Promise<string> {
  setupDenvxDir();

  const gitstorePath = "./.denvx/gitstore";

  if (!existsSync(gitstorePath)) {
    console.log(`Cloning gitstore from ${gitstoreUrl}...`);
    try {
      await execaCommand(`git clone ${gitstoreUrl} ${gitstorePath}`, {
        shell: true,
        stdio: 'inherit'
      });
    } catch (error) {
      console.log(`Repository doesn't exist yet, initializing...`);
      // Initialize an empty repo
      mkdirSync(gitstorePath, { recursive: true });
      await execaCommand(`cd ${gitstorePath} && git init`, { shell: true });
      await execaCommand(`cd ${gitstorePath} && git remote add origin ${gitstoreUrl}`, { shell: true });
      // Create initial commit
      await execaCommand(`cd ${gitstorePath} && git commit --allow-empty -m "Initial commit"`, { shell: true });
      try {
        await execaCommand(`cd ${gitstorePath} && git push -u origin HEAD`, { shell: true, stdio: 'inherit' });
      } catch {
        // Remote might not exist yet, that's ok
      }
    }
  } else {
    // Pull latest changes
    try {
      await execaCommand(`cd ${gitstorePath} && git pull origin HEAD`, { shell: true });
    } catch {
      // Might fail if remote doesn't exist yet, that's ok
    }
  }

  return gitstorePath;
}

// Get the project's path within gitstore
async function getProjectPath(gitstorePath: string): Promise<string> {
  const gitRemote = await getGitRemote();
  const { host, owner, repo } = parseGitRemote(gitRemote);
  return join(gitstorePath, host, owner, repo);
}

// Find all .env* files
async function findEnvFiles(pattern: string, searchPath: string = "."): Promise<string[]> {
  const { readdirSync } = await import("fs");

  // Convert glob pattern to regex
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");

  try {
    const files = readdirSync(searchPath).filter((f) => regex.test(f));
    return files;
  } catch (error) {
    return [];
  }
}

// Push .env* files to gitstore
async function pushToGitstore(gitstoreUrl: string) {
  console.log("Pushing .env* files to gitstore...");

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  // Create project directory if it doesn't exist
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true });
  }

  // Find all local .env* files
  const localFiles = await findEnvFiles(".env*");

  if (localFiles.length === 0) {
    console.log("No .env* files found to push");
    return;
  }

  // Copy each file to gitstore
  for (const file of localFiles) {
    const destPath = join(projectPath, file);
    copyFileSync(file, destPath);
    console.log(`✓ Copied ${file} to gitstore`);
  }

  // Commit and push
  try {
    await execaCommand(`cd ${gitstorePath} && git add -A`, { shell: true });

    // Check if there are changes to commit
    try {
      await execaCommand(`cd ${gitstorePath} && git diff-index --quiet HEAD`, { shell: true });
      console.log("No changes to push");
      return;
    } catch {
      // There are changes, proceed with commit
    }

    const gitRemote = await getGitRemote();
    const { owner, repo } = parseGitRemote(gitRemote);
    await execaCommand(`cd ${gitstorePath} && git commit -m "Update ${owner}/${repo} env files"`, { shell: true });
    await execaCommand(`cd ${gitstorePath} && git push origin HEAD`, {
      shell: true,
      stdio: 'inherit'
    });
    console.log("✓ Pushed to gitstore");
  } catch (error) {
    console.error("Failed to push to gitstore:", error);
  }
}

// Pull .env* files from gitstore
async function pullFromGitstore(gitstoreUrl: string) {
  console.log("Pulling .env* files from gitstore...");

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  if (!existsSync(projectPath)) {
    console.log("No env files found in gitstore for this project");
    return;
  }

  // Find all .env* files in gitstore
  const remoteFiles = await findEnvFiles(".env*", projectPath);

  if (remoteFiles.length === 0) {
    console.log("No .env* files found in gitstore");
    return;
  }

  // Copy each file from gitstore to local
  for (const file of remoteFiles) {
    const sourcePath = join(projectPath, file);
    const destPath = file;
    copyFileSync(sourcePath, destPath);
    console.log(`✓ Pulled ${file} from gitstore`);
  }
}

// Sync .env* files bidirectionally
async function syncWithGitstore(gitstoreUrl: string) {
  console.log("Syncing .env* files with gitstore...");

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  // Create project directory if it doesn't exist
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true });
  }

  // Find local and remote files
  const localFiles = await findEnvFiles(".env*");
  const remoteFiles = existsSync(projectPath)
    ? await findEnvFiles(".env*", projectPath)
    : [];

  const allFiles = new Set([...localFiles, ...remoteFiles]);

  if (allFiles.size === 0) {
    console.log("No .env* files found");
    return;
  }

  let hasChanges = false;

  for (const file of allFiles) {
    const localPath = file;
    const remotePath = join(projectPath, file);

    const localExists = existsSync(localPath);
    const remoteExists = existsSync(remotePath);

    if (!localExists && remoteExists) {
      // Only in gitstore, pull it
      copyFileSync(remotePath, localPath);
      console.log(`← Pulled ${file} from gitstore`);
    } else if (localExists && !remoteExists) {
      // Only local, push it
      copyFileSync(localPath, remotePath);
      console.log(`→ Pushed ${file} to gitstore`);
      hasChanges = true;
    } else if (localExists && remoteExists) {
      // Both exist, compare modification times
      const localStat = Bun.file(localPath);
      const remoteStat = Bun.file(remotePath);

      const localMtime = (await localStat.stat()).mtime;
      const remoteMtime = (await remoteStat.stat()).mtime;

      if (localMtime > remoteMtime) {
        copyFileSync(localPath, remotePath);
        console.log(`→ ${file} (local is newer)`);
        hasChanges = true;
      } else if (remoteMtime > localMtime) {
        copyFileSync(remotePath, localPath);
        console.log(`← ${file} (gitstore is newer)`);
      } else {
        console.log(`✓ ${file} (in sync)`);
      }
    }
  }

  // Commit and push if there are changes
  if (hasChanges) {
    try {
      await execaCommand(`cd ${gitstorePath} && git add -A`, { shell: true });
      const gitRemote = await getGitRemote();
      const { owner, repo } = parseGitRemote(gitRemote);
      await execaCommand(`cd ${gitstorePath} && git commit -m "Sync ${owner}/${repo} env files"`, { shell: true });
      await execaCommand(`cd ${gitstorePath} && git push origin HEAD`, {
        shell: true,
        stdio: 'inherit'
      });
      console.log("✓ Pushed changes to gitstore");
    } catch (error) {
      console.error("Failed to push to gitstore:", error);
    }
  }
}

// Cleanup .denvx directory
function cleanup() {
  const denvxDir = "./.denvx";
  if (existsSync(denvxDir)) {
    try {
      rmSync(denvxDir, { recursive: true, force: true });
      console.log("✓ Cleaned up temporary .denvx directory");
    } catch (error) {
      // Silent fail - not critical
    }
  }
}

// Setup yargs CLI
yargs(hideBin(process.argv))
  .scriptName("denvx")
  .usage("$0 <command> [options]")
  .option("gitstore", {
    alias: "g",
    type: "string",
    description: "Git repository URL for storing env files",
  })
  .command(
    ["push", "p"],
    "Push .env* files to gitstore",
    () => {},
    async (argv) => {
      const gitstore = getGitstoreConfig(argv.gitstore as string | undefined);
      if (!gitstore) {
        console.error("Error: DENVX_STORE not configured");
        console.error("Set it via --gitstore flag, DENVX_STORE env var, or in .env.local");
        process.exit(1);
      }
      await pushToGitstore(gitstore);
      cleanup();
    }
  )
  .command(
    ["pull"],
    "Pull .env* files from gitstore",
    () => {},
    async (argv) => {
      const gitstore = getGitstoreConfig(argv.gitstore as string | undefined);
      if (!gitstore) {
        console.error("Error: DENVX_STORE not configured");
        console.error("Set it via --gitstore flag, DENVX_STORE env var, or in .env.local");
        process.exit(1);
      }
      await pullFromGitstore(gitstore);
      cleanup();
    }
  )
  .command(
    ["sync", "s"],
    "Sync .env* files bidirectionally with gitstore",
    () => {},
    async (argv) => {
      const gitstore = getGitstoreConfig(argv.gitstore as string | undefined);
      if (!gitstore) {
        console.error("Error: DENVX_STORE not configured");
        console.error("Set it via --gitstore flag, DENVX_STORE env var, or in .env.local");
        process.exit(1);
      }
      await syncWithGitstore(gitstore);
      cleanup();
    }
  )
  .example("$0 push", "Push all .env* files to gitstore")
  .example("$0 pull", "Pull all .env* files from gitstore")
  .example("$0 sync", "Sync .env* files bidirectionally")
  .example("$0 --gitstore=https://github.com/user/secrets.git sync", "Sync with specific gitstore")
  .demandCommand(1, "You need to specify a command")
  .help()
  .alias("h", "help")
  .version()
  .alias("v", "version")
  .parse();
