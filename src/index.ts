import { existsSync, readdirSync, statSync } from "fs";
import { readFile, writeFile, copyFile, mkdir, rm, chmod } from "fs/promises";
import { join, resolve, sep, dirname } from "path";
import { platform, homedir } from "os";
import { createInterface } from "readline/promises";
import { createHash } from "crypto";

// Types
type Change = { status: string; file: string; added: number; removed: number };

// Pure utility functions
const isWindows = () => platform() === "win32";
const getNullPath = () => isWindows() ? "NUL" : "/dev/null";
const normalizeGitUrl = (url: string) => url.replace(/\.git$/, "").toLowerCase();

const formatLineDelta = (file: string, added: number, removed: number): string =>
  added === 0 && removed === 0 ? file
    : added > 0 && removed === 0 ? `+${added} ${file}`
    : removed > 0 && added === 0 ? `-${removed} ${file}`
    : `+${added} -${removed} ${file}`;

const sumChanges = (changes: Change[]) =>
  changes.reduce(
    (acc, c) => ({ added: acc.added + c.added, removed: acc.removed + c.removed }),
    { added: 0, removed: 0 }
  );

// File operations
const ensureDir = async (dirPath: string) => {
  if (dirPath !== "." && !existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
};

async function ensureSecurePermissions(filePath: string) {
  try {
    await chmod(filePath, 0o600);
  } catch (error) {
    if (!isWindows()) {
      throw new Error(`Failed to set secure permissions (600) on ${filePath}: ${error}`);
    }
  }
}

// Git utilities using Bun.$
const git = async (args: string[], cwd?: string) => {
  const result = cwd
    ? await Bun.$`git -C ${cwd} ${args}`.quiet().nothrow()
    : await Bun.$`git ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const gitSpawn = (args: string[], cwd: string): { stdout: string } => {
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
  return { stdout: result.stdout ? new TextDecoder().decode(result.stdout) : "" };
};

// Confirmation prompt
async function confirmAction(prompt = "Proceed? [Y/n] "): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// Parse git remote URL to extract host, owner, and repo
export function parseGitRemote(remoteUrl: string): { host: string; owner: string; repo: string } {
  let url = remoteUrl.startsWith("git@")
    ? remoteUrl.replace(/^git@/, "https://").replace(/\.com:/, ".com/")
    : remoteUrl;
  url = url.replace(/\.git$/, "");

  const match = url.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match?.[2] || !match?.[3]) {
    throw new Error(`Invalid git remote URL: ${remoteUrl}`);
  }
  return { host: match[1], owner: match[2], repo: match[3] };
}

// Generate hashed branch name from project identifier
// Uses SHA256 truncated to 16 chars for obscurity while keeping it manageable
export function getBranchName(gitRemote: string): string {
  const { host, owner, repo } = parseGitRemote(gitRemote);
  const projectId = `${host}/${owner}/${repo}`.toLowerCase();
  const hash = createHash("sha256").update(projectId).digest("hex").slice(0, 16);
  return `env/${hash}`;
}

// Get git remote URL for current repo
export async function getGitRemote(): Promise<string> {
  try {
    return await git(["config", "--get", "remote.origin.url"]);
  } catch {
    throw new Error("Not in a git repository or no remote origin found");
  }
}

// Load env config from multiple sources (Bun auto-loads .env, but we need specific paths)
async function loadEnvConfig() {
  const paths = [
    ".env.local",
    ".env",
    join(homedir(), ".genvx/.env.local"),
    join(homedir(), ".genvx/.env"),
  ];

  for (const envPath of paths) {
    if (existsSync(envPath)) {
      const content = await readFile(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key && !process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// Get gitstore configuration
export async function getGitstoreConfig(cliGitstore?: string): Promise<string | null> {
  if (cliGitstore) return cliGitstore;
  await loadEnvConfig();
  return process.env.GENVX_STORE ?? null;
}

export const getGenvxDir = (): string =>
  existsSync("node_modules") ? "./node_modules/.genvx" : "./.genvx";

export const isInsideGitstoreDir = (cwd: string): boolean => {
  const normalized = resolve(cwd);
  return normalized.includes(`${sep}.genvx${sep}gitstore`) ||
    normalized.includes(`${sep}node_modules${sep}.genvx${sep}gitstore`);
};

// Setup .genvx directory
export async function setupGenvxDir(): Promise<string> {
  const genvxDir = getGenvxDir();
  const gitignorePath = join(genvxDir, ".gitignore");
  await ensureDir(genvxDir);
  if (!existsSync(gitignorePath)) {
    await writeFile(gitignorePath, "*\n");
  }
  return genvxDir;
}

// Clone or pull gitstore repository (single branch per project)
export async function syncGitstore(gitstoreUrl: string, branch: string): Promise<string> {
  const genvxDir = await setupGenvxDir();
  const gitstorePath = join(genvxDir, "gitstore");

  if (!existsSync(gitstorePath)) {
    // Try to clone the specific branch
    const cloneResult = await Bun.$`git clone --single-branch --depth 1 -b ${branch} -q ${gitstoreUrl} ${gitstorePath}`.quiet().nothrow();

    if (cloneResult.exitCode !== 0) {
      // Branch doesn't exist yet - create orphan branch
      await mkdir(gitstorePath, { recursive: true });
      await Bun.$`git -C ${gitstorePath} init -q`.quiet();
      await Bun.$`git -C ${gitstorePath} remote add origin ${gitstoreUrl}`.quiet();
      await Bun.$`git -C ${gitstorePath} checkout --orphan ${branch}`.quiet();
      // Create initial empty commit
      await Bun.$`git -C ${gitstorePath} commit --allow-empty -m "Initialize env branch" -q`.quiet();
    }
  } else {
    // Pull latest changes
    await Bun.$`git -C ${gitstorePath} pull origin ${branch}`.quiet().nothrow();
  }
  return gitstorePath;
}

// Find all .env* files recursively
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt",
  ".output", ".cache", ".venv", "venv", "__pycache__", ".pytest_cache",
  "target", "vendor", ".genvx"
]);

export async function findEnvFiles(pattern: string, searchPath = "."): Promise<string[]> {
  const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
  const results: string[] = [];

  const search = (dirPath: string, relativePath = "") => {
    try {
      for (const entry of readdirSync(dirPath)) {
        const fullPath = join(dirPath, entry);
        const relPath = relativePath ? join(relativePath, entry) : entry;
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(entry) && !existsSync(join(fullPath, ".git"))) {
              search(fullPath, relPath);
            }
          } else if (stat.isFile() && regex.test(entry)) {
            results.push(relPath);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  };

  search(searchPath);
  return results;
}

// Get the project's path within gitstore (now just root since each branch = one project)
export function getProjectPath(gitstorePath: string): string {
  return gitstorePath;
}

// Unified change detection - works for both pull and push
type Direction = "pull" | "push";

async function getFileChanges(
  projectPath: string,
  files: string[],
  direction: Direction
): Promise<Change[]> {
  const getPath = (file: string, isSource: boolean) =>
    direction === "pull"
      ? (isSource ? join(projectPath, file) : file)
      : (isSource ? file : join(projectPath, file));

  const changes = await Promise.all(
    files.map(async (file): Promise<Change | null> => {
      const sourcePath = getPath(file, true);
      const destPath = getPath(file, false);
      const destExists = existsSync(destPath);

      if (destExists) {
        const [sourceContent, destContent] = await Promise.all([
          readFile(sourcePath, "utf-8"),
          readFile(destPath, "utf-8"),
        ]);
        if (sourceContent === destContent) return null;
      }

      let added = 0, removed = 0;
      try {
        const leftPath = destExists ? destPath : getNullPath();
        const { stdout } = gitSpawn(
          ["diff", "--no-index", "--numstat", "--", leftPath, sourcePath],
          process.cwd()
        );
        const lines = stdout.trim().split("\n")
          .filter(Boolean)
          .map(line => line.split("\t"))
          .filter(parts => parts.length >= 2);

        for (const [a, r] of lines) {
          added += Number(a) || 0;
          removed += Number(r) || 0;
        }
      } catch { /* ignore */ }

      return { status: destExists ? "M" : "+", file, added, removed };
    })
  );

  return changes.filter((c): c is Change => c !== null);
}

// Display changes with diffs and ask for confirmation
async function displayAndConfirm(
  changes: Change[],
  projectPath: string,
  direction: Direction,
  yes: boolean
): Promise<boolean> {
  const action = direction;
  const arrow = direction === "push" ? "→" : "←";

  console.log("Pending env file changes:");
  for (const c of changes) {
    console.log(`${arrow} ${c.status} ${formatLineDelta(c.file, c.added, c.removed)}`);
    if (c.status === "M") {
      const remotePath = join(projectPath, c.file);
      const [oldPath, newPath] = direction === "push"
        ? [remotePath, c.file]
        : [c.file, remotePath];
      const diff = getFileDiff(oldPath, newPath);
      if (diff) console.log(diff);
    }
  }

  const { added, removed } = sumChanges(changes);
  if (added !== 0 || removed !== 0) {
    console.log(`Lines: +${added} -${removed}`);
  }

  return yes || await confirmAction(`Proceed with ${action}? [Y/n] `);
}

// Push .env* files to gitstore
export async function pushToGitstore(gitstoreUrl: string, yes = false) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  const projectPath = getProjectPath(gitstorePath);
  await ensureDir(projectPath);

  const localFiles = await findEnvFiles(".env*");
  if (localFiles.length === 0) return;

  const changes = await getFileChanges(projectPath, localFiles, "push");
  if (changes.length === 0) {
    localFiles.forEach(file => console.log(`→ ${formatLineDelta(file, 0, 0)}`));
    console.log(".");
    return;
  }

  if (!await displayAndConfirm(changes, projectPath, "push", yes)) {
    console.log("Push cancelled.");
    return;
  }

  // Copy files
  for (const { file, added, removed } of changes) {
    await ensureSecurePermissions(file);
    const destPath = join(projectPath, file);
    await ensureDir(dirname(destPath));
    await copyFile(file, destPath);
    console.log(`→ ${formatLineDelta(file, added, removed)}`);
  }

  // Commit and push to branch
  try {
    await Bun.$`git -C ${gitstorePath} add -A`.quiet();
    await Bun.$`git -C ${gitstorePath} commit -m "Update env files"`.quiet();
    await Bun.$`git -C ${gitstorePath} push -u origin ${branch} -q`.quiet();
  } catch (error) {
    console.error("Failed to push to gitstore:", error);
  }
}

// Pull .env* files from gitstore
export async function pullFromGitstore(gitstoreUrl: string, yes = false) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  const projectPath = getProjectPath(gitstorePath);

  const remoteFiles = await findEnvFiles(".env*", projectPath);
  if (remoteFiles.length === 0) {
    console.log("No env files found in gitstore for this project.");
    return;
  }

  const changes = await getFileChanges(projectPath, remoteFiles, "pull");
  if (changes.length === 0) {
    remoteFiles.forEach(file => console.log(`← ${formatLineDelta(file, 0, 0)}`));
    console.log(".");
    return;
  }

  if (!await displayAndConfirm(changes, projectPath, "pull", yes)) {
    console.log("Pull cancelled.");
    return;
  }

  // Copy files
  for (const { file, added, removed } of changes) {
    const sourcePath = join(projectPath, file);
    await ensureDir(dirname(file));
    await copyFile(sourcePath, file);
    await ensureSecurePermissions(file);
    console.log(`← ${formatLineDelta(file, added, removed)}`);
  }
}

// Get git diff between two files (simplified output)
const getFileDiff = (oldPath: string, newPath: string): string => {
  const left = existsSync(oldPath) ? oldPath : getNullPath();
  const result = Bun.spawnSync({
    cmd: ["git", "diff", "--no-index", "--color=always", "--", left, newPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.stdout) return "";

  // Skip header lines (diff --git, index, ---, +++), keep @@ and content
  return new TextDecoder().decode(result.stdout)
    .split("\n")
    .filter(line => !line.match(/^(\x1b\[\d+m)*(diff|index|---|\+\+\+) /))
    .join("\n")
    .trim();
};

// Diff .env* files (dry run)
export async function diffWithGitstore(gitstoreUrl: string) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  const projectPath = getProjectPath(gitstorePath);

  // Pull direction
  const remoteFiles = await findEnvFiles(".env*", projectPath);
  if (remoteFiles.length === 0) {
    console.log("pull: (no remote files found)");
  } else {
    const pullChanges = await getFileChanges(projectPath, remoteFiles, "pull");
    if (pullChanges.length === 0) {
      console.log("pull: (no changes)");
    } else {
      console.log("pull:");
      for (const change of pullChanges) {
        const remotePath = join(projectPath, change.file);
        console.log(`  ← ${change.status} ${change.file}`);
        if (change.status === "M") {
          const diff = getFileDiff(change.file, remotePath);
          if (diff) console.log(diff);
        }
      }
    }
  }

  // Push direction
  const localFiles = await findEnvFiles(".env*");
  if (localFiles.length === 0) {
    console.log("push: (no local .env* files)");
    return;
  }

  await ensureDir(projectPath);
  const pushChanges = await getFileChanges(projectPath, localFiles, "push");

  if (pushChanges.length === 0) {
    console.log("push: (no changes)");
  } else {
    console.log("push:");
    for (const change of pushChanges) {
      const remotePath = join(projectPath, change.file);
      console.log(`  → ${change.status} ${change.file}`);
      if (change.status === "M") {
        const diff = getFileDiff(remotePath, change.file);
        if (diff) console.log(diff);
      }
    }
  }
}

// Cleanup .genvx directory
export async function cleanup() {
  const genvxDir = getGenvxDir();
  if (existsSync(genvxDir)) {
    try {
      await rm(genvxDir, { recursive: true, force: true });
    } catch { /* silent */ }
  }
}
