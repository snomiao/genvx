import { execaCommand } from "execa";
import { existsSync } from "fs";
import { readFile, writeFile, copyFile, mkdir, rm, unlink, chmod } from "fs/promises";
import path, { join, resolve, sep, dirname } from "path";
import { platform } from "os";
import { createInterface } from "readline/promises";
import { config } from "dotenv";
import os from 'node:os'

// Ensure file has secure permissions (600)
async function ensureSecurePermissions(filePath: string) {
  const isWindows = platform() === "win32";

  try {
    await chmod(filePath, 0o600);
  } catch (error) {
    // Only ignore chmod errors on Windows
    if (!isWindows) {
      throw new Error(`Failed to set secure permissions (600) on ${filePath}: ${error}`);
    }
  }
}

function getNullPath(): string {
  return platform() === "win32" ? "NUL" : "/dev/null";
}

function runGit(args: string[], cwd: string): { stdout: string } {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }

  const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  return { stdout };
}

function formatLineDelta(file: string, added: number, removed: number): string {
  if (added === 0 && removed === 0) {
    return file;
  }
  if (added > 0 && removed === 0) {
    return `+${added} ${file}`;
  }
  if (removed > 0 && added === 0) {
    return `-${removed} ${file}`;
  }
  return `+${added} -${removed} ${file}`;
}

async function confirmAction(prompt: string = "Proceed? [Y/n] "): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return true;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    // Default to 'yes' if user just presses Enter
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// Parse git remote URL to extract host, owner, and repo
export function parseGitRemote(remoteUrl: string): { host: string; owner: string; repo: string } {
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
export async function getGitRemote(): Promise<string> {
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
export async function getGitstoreConfig(cliGitstore?: string): Promise<string | null> {
  // Priority 1: CLI flag
  if (cliGitstore) {
    return cliGitstore;
  }

  // Priority 2: Environment variables
  config({ override: false, path: '.env.local', quiet: true })
  config({ override: false, path: '.env', quiet: true })
  config({ override: false, path: path.resolve(os.homedir(), '.genvx/.env.local'), quiet: true })
  config({ override: false, path: path.resolve(os.homedir(), '.genvx/.env'), quiet: true })
  if (process.env.GENVX_STORE) {
    return process.env.GENVX_STORE;
  }

  return null;
}

export function getGenvxDir(): string {
  return existsSync("node_modules") ? "./node_modules/.genvx" : "./.genvx";
}

export function isInsideGitstoreDir(cwd: string): boolean {
  const normalizedCwd = resolve(cwd);
  return (
    normalizedCwd.includes(`${sep}.genvx${sep}gitstore`) ||
    normalizedCwd.includes(`${sep}node_modules${sep}.genvx${sep}gitstore`)
  );
}

// Setup .genvx directory
export async function setupGenvxDir(): Promise<string> {
  const genvxDir = getGenvxDir();
  const gitignorePath = join(genvxDir, ".gitignore");

  if (!existsSync(genvxDir)) {
    await mkdir(genvxDir, { recursive: true });
  }

  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, "*\n");
  }

  return genvxDir;
}

// Clone or pull gitstore repository
export async function syncGitstore(gitstoreUrl: string): Promise<string> {
  const genvxDir = await setupGenvxDir();
  const gitstorePath = join(genvxDir, "gitstore");

  if (!existsSync(gitstorePath)) {
    try {
      await execaCommand(`git clone --depth 1 -q ${gitstoreUrl} ${gitstorePath}`, {
        shell: true
      });
    } catch (error) {
      // Initialize an empty repo
      await mkdir(gitstorePath, { recursive: true });
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

async function printGitstoreDiff(gitstorePath: string, projectPath: string): Promise<boolean> {
  const result = await execaCommand(`cd ${gitstorePath} && git status --short -M`, { shell: true });
  const statusLines = result.stdout.trim().split("\n").filter(line => line);

  if (statusLines.length === 0) {
    console.log(".");
    return false;
  }

  const projectDirName = projectPath.split("/").pop() || "";
  const relativePrefix = new RegExp(`^.*${projectDirName}/`);
  const numstatMap = new Map<string, { added: number; removed: number }>();

  try {
    const numstatResult = await execaCommand(`cd ${gitstorePath} && git diff --numstat`, { shell: true });
    const lines = numstatResult.stdout
      .trim()
      .split("\n")
      .filter(line => line)
      .map(line => line.split("\t"))
      .filter(parts => parts.length >= 3);

    for (const parts of lines) {
      const added = Number(parts[0]) || 0;
      const removed = Number(parts[1]) || 0;
      const rawPath = parts.slice(2).join("\t");
      const pathPart = rawPath.includes("=>") ? rawPath.split("=>")[1]?.trim() : rawPath;
      const normalizedPath = (pathPart || rawPath).replace(/[{}]/g, "").trim();
      const relativePath = normalizedPath.replace(relativePrefix, "");
      numstatMap.set(relativePath, { added, removed });

      if (rawPath.includes("=>")) {
        const oldPart = rawPath.split("=>")[0]?.replace(/[{}]/g, "").trim() || "";
        const oldRelative = oldPart.replace(relativePrefix, "");
        numstatMap.set(oldRelative, { added, removed });
      }
    }
  } catch {
    // Ignore numstat errors
  }

  console.log("Pending env file changes:");
  for (const line of statusLines) {
    const status = line.substring(0, 2).trim();
    const filePath = line.substring(3);
    const relativePath = filePath.replace(relativePrefix, "");
    const counts = numstatMap.get(relativePath);
    const suffix = counts ? ` +${counts.added} -${counts.removed}` : "";

    if (status === "A" || status === "??") {
      console.log(`+ ${relativePath}${suffix}`);
    } else if (status === "M") {
      console.log(`M ${relativePath}${suffix}`);
    } else if (status === "D") {
      console.log(`- ${relativePath}${suffix}`);
    } else if (status.startsWith("R")) {
      const [oldFile, newFile] = filePath.split(" -> ");
      const oldRelative = oldFile?.replace(relativePrefix, "") || "";
      const newRelative = newFile?.replace(relativePrefix, "") || "";
      console.log(`R ${oldRelative} → ${newRelative}${suffix}`);
    }
  }

  try {
    const diffResult = await execaCommand(`cd ${gitstorePath} && git diff --stat`, { shell: true });
    if (diffResult.stdout.trim()) {
      console.log(diffResult.stdout.trim());
    }

    const numstatResult = await execaCommand(`cd ${gitstorePath} && git diff --numstat`, { shell: true });
    const lines = numstatResult.stdout
      .trim()
      .split("\n")
      .filter(line => line)
      .map(line => line.split("\t"))
      .filter(parts => parts.length >= 2);

    if (lines.length > 0) {
      const added = lines.reduce((sum, parts) => sum + (Number(parts[0]) || 0), 0);
      const removed = lines.reduce((sum, parts) => sum + (Number(parts[1]) || 0), 0);
      console.log(`Lines: +${added} -${removed}`);
    }
  } catch {
    // Ignore diff errors
  }

  return true;
}

async function getPullChanges(projectPath: string, remoteFiles: string[]) {
  const changes: Array<{ status: string; file: string; added: number; removed: number }> = [];

  for (const file of remoteFiles) {
    const sourcePath = join(projectPath, file);
    const destPath = file;
    const destExists = existsSync(destPath);

    if (destExists) {
      const [sourceContent, destContent] = await Promise.all([
        readFile(sourcePath, "utf-8"),
        readFile(destPath, "utf-8"),
      ]);

      if (sourceContent === destContent) {
        continue;
      }
    }

    const leftPath = destExists ? destPath : getNullPath();
    let addedFile = 0;
    let removedFile = 0;

    try {
      const diffNumstat = runGit(["diff", "--no-index", "--numstat", "--", leftPath, sourcePath], process.cwd());
      const lines = diffNumstat.stdout
        .trim()
        .split("\n")
        .filter(line => line)
        .map(line => line.split("\t"))
        .filter(parts => parts.length >= 2);

      for (const parts of lines) {
        const added = Number(parts[0]) || 0;
        const removed = Number(parts[1]) || 0;
        addedFile += added;
        removedFile += removed;
      }
    } catch {
      // Ignore diff errors
    }

    changes.push({ status: destExists ? "M" : "+", file, added: addedFile, removed: removedFile });
  }

  return changes;
}

async function getPushChanges(projectPath: string, localFiles: string[]) {
  const changes: Array<{ status: string; file: string; added: number; removed: number }> = [];

  for (const file of localFiles) {
    const sourcePath = file;
    const destPath = join(projectPath, file);
    const destExists = existsSync(destPath);

    if (destExists) {
      const [sourceContent, destContent] = await Promise.all([
        readFile(sourcePath, "utf-8"),
        readFile(destPath, "utf-8"),
      ]);

      if (sourceContent === destContent) {
        continue;
      }
    }

    const leftPath = destExists ? destPath : getNullPath();
    let addedFile = 0;
    let removedFile = 0;

    try {
      const diffNumstat = runGit(["diff", "--no-index", "--numstat", "--", leftPath, sourcePath], process.cwd());
      const lines = diffNumstat.stdout
        .trim()
        .split("\n")
        .filter(line => line)
        .map(line => line.split("\t"))
        .filter(parts => parts.length >= 2);

      for (const parts of lines) {
        const added = Number(parts[0]) || 0;
        const removed = Number(parts[1]) || 0;
        addedFile += added;
        removedFile += removed;
      }
    } catch {
      // Ignore diff errors
    }

    changes.push({ status: destExists ? "M" : "+", file, added: addedFile, removed: removedFile });
  }

  return changes;
}

// Get the project's path within gitstore
export async function getProjectPath(gitstorePath: string): Promise<string> {
  const gitRemote = await getGitRemote();
  const { host, owner, repo } = parseGitRemote(gitRemote);
  return join(gitstorePath, host, owner, repo);
}

// Find all .env* files recursively, skipping git repos and common build/dependency directories
export async function findEnvFiles(pattern: string, searchPath: string = "."): Promise<string[]> {
  const { readdirSync, statSync } = await import("fs");
  const { join: pathJoin } = await import("path");

  // Convert glob pattern to regex
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  const results: string[] = [];

  // Directories to skip (common build/dependency/cache directories)
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "target",
    "vendor",
    ".genvx"
  ]);

  function searchDirectory(dirPath: string, relativePath: string = "") {
    try {
      const entries = readdirSync(dirPath);

      for (const entry of entries) {
        const fullPath = pathJoin(dirPath, entry);
        const relPath = relativePath ? pathJoin(relativePath, entry) : entry;

        try {
          const stat = statSync(fullPath);

          if (stat.isDirectory()) {
            // Skip common directories and git repos
            if (!skipDirs.has(entry) && !existsSync(pathJoin(fullPath, ".git"))) {
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
export async function pushToGitstore(gitstoreUrl: string, yes = false) {

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  // Create project directory if it doesn't exist
  if (!existsSync(projectPath)) {
    await mkdir(projectPath, { recursive: true });
  }

  // Find all local .env* files
  const localFiles = await findEnvFiles(".env*");

  if (localFiles.length === 0) {
    return;
  }

  // Calculate changes before copying
  const changes = await getPushChanges(projectPath, localFiles);
  if (changes.length === 0) {
    for (const file of localFiles) {
      console.log(`→ ${formatLineDelta(file, 0, 0)}`);
    }
    console.log(".");
    return;
  }

  console.log("Pending env file changes:");
  let addedTotal = 0;
  let removedTotal = 0;
  for (const change of changes) {
    addedTotal += change.added;
    removedTotal += change.removed;
    console.log(`${change.status} ${formatLineDelta(change.file, change.added, change.removed)}`);
  }
  if (addedTotal !== 0 || removedTotal !== 0) {
    console.log(`Lines: +${addedTotal} -${removedTotal}`);
  }

  // Ask for confirmation before writing files
  const proceed = yes || await confirmAction("Proceed with push? [Y/n] ");
  if (!proceed) {
    console.log("Push cancelled.");
    return;
  }

  // Copy each file to gitstore
  for (const change of changes) {
    const file = change.file;
    // Ensure secure permissions on local file before pushing
    await ensureSecurePermissions(file);

    const destPath = join(projectPath, file);
    const destDir = dirname(destPath);
    if (destDir !== "." && !existsSync(destDir)) {
      await mkdir(destDir, { recursive: true });
    }

    await copyFile(file, destPath);
    console.log(`→ ${formatLineDelta(file, change.added, change.removed)}`);
  }

  // Commit and push
  try {
    await execaCommand(`cd ${gitstorePath} && git add -A`, { shell: true });

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
export async function pullFromGitstore(gitstoreUrl: string, yes = false) {

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

  const changes = await getPullChanges(projectPath, remoteFiles);
  if (changes.length === 0) {
    for (const file of remoteFiles) {
      console.log(`← ${formatLineDelta(file, 0, 0)}`);
    }
    console.log(".");
    return;
  }

  console.log("Pending env file changes:");
  let addedTotal = 0;
  let removedTotal = 0;
  for (const change of changes) {
    addedTotal += change.added;
    removedTotal += change.removed;
    console.log(`${change.status} ${formatLineDelta(change.file, change.added, change.removed)}`);
  }
  if (addedTotal !== 0 || removedTotal !== 0) {
    console.log(`Lines: +${addedTotal} -${removedTotal}`);
  }

  // Ask for confirmation before writing files
  const proceed = yes || await confirmAction("Proceed with pull? [Y/n] ");
  if (!proceed) {
    console.log("Pull cancelled.");
    return;
  }

  // Copy each file from gitstore to local
  for (const change of changes) {
    const sourcePath = join(projectPath, change.file);
    const destPath = change.file;
    const destDir = dirname(destPath);
    if (destDir !== "." && !existsSync(destDir)) {
      await mkdir(destDir, { recursive: true });
    }
    await copyFile(sourcePath, destPath);

    // Set secure permissions on pulled .env files
    await ensureSecurePermissions(destPath);

    console.log(`← ${formatLineDelta(change.file, change.added, change.removed)}`);
  }
}

// Diff .env* files (dry run — shows what would change without modifying anything)
function parseEnvKeys(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key) map.set(key, trimmed.slice(eqIdx + 1));
  }
  return map;
}

function keyDiffSummary(oldContent: string, newContent: string): string {
  const oldMap = parseEnvKeys(oldContent);
  const newMap = parseEnvKeys(newContent);
  const parts: string[] = [];
  for (const key of newMap.keys()) {
    if (!oldMap.has(key)) parts.push(`+${key}`);
    else if (oldMap.get(key) !== newMap.get(key)) parts.push(`~${key}`);
  }
  for (const key of oldMap.keys()) {
    if (!newMap.has(key)) parts.push(`-${key}`);
  }
  return parts.length ? `[${parts.join(', ')}]` : '';
}

async function readOrEmpty(filePath: string): Promise<string> {
  return existsSync(filePath) ? readFile(filePath, 'utf-8') : Promise.resolve('');
}

export async function diffWithGitstore(gitstoreUrl: string) {
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  // Pull direction: what would come down from remote
  if (existsSync(projectPath)) {
    const remoteFiles = await findEnvFiles(".env*", projectPath);
    const pullChanges = await getPullChanges(projectPath, remoteFiles);
    if (pullChanges.length === 0) {
      console.log("pull: (no changes)");
    } else {
      console.log("pull:");
      for (const change of pullChanges) {
        const remotePath = join(projectPath, change.file);
        const [localContent, remoteContent] = await Promise.all([
          readOrEmpty(change.file),
          readOrEmpty(remotePath),
        ]);
        const keys = keyDiffSummary(localContent, remoteContent);
        console.log(`  ← ${change.status} ${change.file}${keys ? ' ' + keys : ''}`);
      }
    }
  } else {
    console.log("pull: (no remote files found)");
  }

  // Push direction: what would go up to remote
  const localFiles = await findEnvFiles(".env*");
  if (localFiles.length === 0) {
    console.log("push: (no local .env* files)");
  } else {
    if (!existsSync(projectPath)) {
      await mkdir(projectPath, { recursive: true });
    }
    const pushChanges = await getPushChanges(projectPath, localFiles);
    if (pushChanges.length === 0) {
      console.log("push: (no changes)");
    } else {
      console.log("push:");
      for (const change of pushChanges) {
        const remotePath = join(projectPath, change.file);
        const [localContent, remoteContent] = await Promise.all([
          readOrEmpty(change.file),
          readOrEmpty(remotePath),
        ]);
        const keys = keyDiffSummary(remoteContent, localContent);
        console.log(`  → ${change.status} ${change.file}${keys ? ' ' + keys : ''}`);
      }
    }
  }
}

// Sync .env* files bidirectionally using git diff
export async function syncWithGitstore(gitstoreUrl: string) {

  // Sync gitstore
  const gitstorePath = await syncGitstore(gitstoreUrl);
  const projectPath = await getProjectPath(gitstorePath);

  // Create project directory if it doesn't exist
  if (!existsSync(projectPath)) {
    await mkdir(projectPath, { recursive: true });
  }

  // Clean project directory in gitstore (remove all .env* files)
  // This allows deletions to be synced - deleted local files won't be restored
  if (existsSync(projectPath)) {
    const filesToRemove = await findEnvFiles(".env*", projectPath);
    for (const file of filesToRemove) {
      await unlink(join(projectPath, file));
    }
  }

  // Copy all local .env* files to gitstore
  const localFiles = await findEnvFiles(".env*");

  if (localFiles.length === 0) {
    return;
  }

  for (const file of localFiles) {
    // Set secure permissions on local .env files
    await ensureSecurePermissions(file);

    const destPath = join(projectPath, file);
    const destDir = dirname(destPath);
    if (destDir !== "." && !existsSync(destDir)) {
      await mkdir(destDir, { recursive: true });
    }
    await copyFile(file, destPath);
  }

  // Use git status to detect changes (with rename detection)
  try {
    const hasChanges = await printGitstoreDiff(gitstorePath, projectPath);
    if (!hasChanges) {
      return;
    }

    const proceed = await confirmAction("Proceed with sync? [Y/n] ");
    if (!proceed) {
      console.log("Sync cancelled.");
      return;
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

// Cleanup .genvx directory
export async function cleanup() {
  const genvxDir = getGenvxDir();
  if (existsSync(genvxDir)) {
    try {
      await rm(genvxDir, { recursive: true, force: true });
    } catch (error) {
      // Silent fail - not critical
    }
  }
}
