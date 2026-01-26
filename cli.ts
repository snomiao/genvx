#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { execaCommand } from "execa";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, unlinkSync } from "fs";
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
    try {
      await execaCommand(`git clone -q ${gitstoreUrl} ${gitstorePath}`, {
        shell: true
      });
    } catch (error) {
      // Initialize an empty repo
      mkdirSync(gitstorePath, { recursive: true });
      await execaCommand(`cd ${gitstorePath} && git init -q`, { shell: true });
      await execaCommand(`cd ${gitstorePath} && git remote add origin ${gitstoreUrl}`, { shell: true });
      // Create initial commit
      await execaCommand(`cd ${gitstorePath} && git commit --allow-empty -m "Initial commit" -q`, { shell: true });
      try {
        await execaCommand(`cd ${gitstorePath} && git push -u origin HEAD -q`, { shell: true });
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

// Find all .env* files recursively, skipping git repos
async function findEnvFiles(pattern: string, searchPath: string = "."): Promise<string[]> {
  const { readdirSync, statSync } = await import("fs");
  const { join: pathJoin } = await import("path");

  // Convert glob pattern to regex
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  const results: string[] = [];

  function searchDirectory(dirPath: string, relativePath: string = "") {
    try {
      const entries = readdirSync(dirPath);

      for (const entry of entries) {
        const fullPath = pathJoin(dirPath, entry);
        const relPath = relativePath ? pathJoin(relativePath, entry) : entry;

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            // Skip if this directory is a git repo
            const gitPath = pathJoin(fullPath, ".git");
            if (!existsSync(gitPath)) {
              searchDirectory(fullPath, relPath);
            }
          } else if (stat.isFile() && regex.test(entry)) {
            results.push(relPath);
          }
        } catch {
          // Skip entries we can't stat
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  searchDirectory(searchPath);
  return results;
}

// Push .env* files to gitstore
async function pushToGitstore(gitstoreUrl: string) {

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
    return;
  }

  // Copy each file to gitstore
  for (const file of localFiles) {
    const destPath = join(projectPath, file);
    const destDir = join(destPath, "..");
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(file, destPath);
    console.log(`→ ${file}`);
  }

  // Commit and push
  try {
    await execaCommand(`cd ${gitstorePath} && git add -A`, { shell: true });

    // Check if there are changes to commit
    try {
      await execaCommand(`cd ${gitstorePath} && git diff-index --quiet HEAD`, { shell: true });
      return;
    } catch {
      // There are changes, proceed with commit
    }

    const gitRemote = await getGitRemote();
    const { owner, repo } = parseGitRemote(gitRemote);
    await execaCommand(`cd ${gitstorePath} && git commit -m "Update ${owner}/${repo} env files"`, { shell: true });
    await execaCommand(`cd ${gitstorePath} && git push origin HEAD -q`, {
      shell: true
    });
  } catch (error) {
    console.error("Failed to push to gitstore:", error);
  }
}

// Pull .env* files from gitstore
async function pullFromGitstore(gitstoreUrl: string) {

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  if (!existsSync(projectPath)) {
    return;
  }

  // Find all .env* files in gitstore
  const remoteFiles = await findEnvFiles(".env*", projectPath);

  if (remoteFiles.length === 0) {
    return;
  }

  // Copy each file from gitstore to local
  for (const file of remoteFiles) {
    const sourcePath = join(projectPath, file);
    const destPath = file;
    const destDir = join(destPath, "..");
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(sourcePath, destPath);
    console.log(`← ${file}`);
  }
}

// Sync .env* files bidirectionally using git diff
async function syncWithGitstore(gitstoreUrl: string) {

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  // Create project directory if it doesn't exist
  if (!existsSync(projectPath)) {
    mkdirSync(projectPath, { recursive: true });
  }

  // First, pull files from gitstore that don't exist locally
  const remoteFiles = existsSync(projectPath)
    ? await findEnvFiles(".env*", projectPath)
    : [];

  for (const file of remoteFiles) {
    const localPath = file;
    if (!existsSync(localPath)) {
      const localDir = join(localPath, "..");
      if (!existsSync(localDir)) {
        mkdirSync(localDir, { recursive: true });
      }
      copyFileSync(join(projectPath, file), localPath);
      console.log(`← ${file}`);
    }
  }

  // Clean project directory in gitstore (remove all .env* files)
  if (existsSync(projectPath)) {
    const filesToRemove = await findEnvFiles(".env*", projectPath);
    for (const file of filesToRemove) {
      unlinkSync(join(projectPath, file));
    }
  }

  // Copy all local .env* files to gitstore
  const localFiles = await findEnvFiles(".env*");

  if (localFiles.length === 0) {
    return;
  }

  for (const file of localFiles) {
    const destPath = join(projectPath, file);
    const destDir = join(destPath, "..");
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }
    copyFileSync(file, destPath);
  }

  // Use git status to detect changes (with rename detection)
  try {
    const result = await execaCommand(`cd ${gitstorePath} && git status --short -M`, { shell: true });
    const statusLines = result.stdout.trim().split('\n').filter(line => line);

    if (statusLines.length === 0) {
      return;
    }

    // Parse and display git status
    for (const line of statusLines) {
      const status = line.substring(0, 2).trim();
      const filePath = line.substring(3);

      // Extract just the filename relative to projectPath
      const relativePath = filePath.replace(new RegExp(`^.*${projectPath.split('/').pop()}/`), '');

      if (status === 'A' || status === '??') {
        console.log(`+ ${relativePath}`);
      } else if (status === 'M') {
        console.log(`M ${relativePath}`);
      } else if (status === 'D') {
        console.log(`- ${relativePath}`);
      } else if (status.startsWith('R')) {
        const [oldFile, newFile] = filePath.split(' -> ');
        const oldRelative = oldFile?.replace(new RegExp(`^.*${projectPath.split('/').pop()}/`), '') || '';
        const newRelative = newFile?.replace(new RegExp(`^.*${projectPath.split('/').pop()}/`), '') || '';
        console.log(`R ${oldRelative} → ${newRelative}`);
      }
    }

    // Commit and push
    await execaCommand(`cd ${gitstorePath} && git add -A`, { shell: true });
    const gitRemote = await getGitRemote();
    const { owner, repo } = parseGitRemote(gitRemote);
    await execaCommand(`cd ${gitstorePath} && git commit -m "Sync ${owner}/${repo} env files"`, { shell: true });
    await execaCommand(`cd ${gitstorePath} && git push origin HEAD -q`, {
      shell: true
    });
  } catch (error) {
    // No changes or error occurred
    if (error && typeof error === 'object' && 'stdout' in error) {
      const stdout = (error as any).stdout;
      if (!stdout || stdout.trim() === '') {
        // No changes
        return;
      }
    }
    console.error("Failed to sync with gitstore:", error);
  }
}

// Cleanup .denvx directory
function cleanup() {
  const denvxDir = "./.denvx";
  if (existsSync(denvxDir)) {
    try {
      rmSync(denvxDir, { recursive: true, force: true });
    } catch (error) {
      // Silent fail - not critical
    }
  }
}

// Setup yargs CLI
yargs(hideBin(process.argv))
  .scriptName("denvx")
  .usage("$0 [command] [options]")
  .option("gitstore", {
    alias: "g",
    type: "string",
    description: "Git repository URL for storing env files",
  })
  .command(
    ["$0", "sync", "s"],
    "Sync .env* files bidirectionally with gitstore (default)",
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
  .example("$0", "Sync .env* files (default command)")
  .example("$0 push", "Push all .env* files to gitstore")
  .example("$0 pull", "Pull all .env* files from gitstore")
  .example("$0 --gitstore=https://github.com/user/secrets.git", "Sync with specific gitstore")
  .help()
  .alias("h", "help")
  .version()
  .alias("v", "version")
  .parse();
