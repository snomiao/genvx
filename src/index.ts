import { existsSync, readdirSync, statSync } from "fs";
import { readFile, writeFile, copyFile, mkdir, rm, chmod } from "fs/promises";
import { join, resolve, sep, dirname } from "path";
import { platform, homedir } from "os";
import { createInterface } from "readline/promises";
import { createHash, scryptSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";

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

// Encryption utilities (AES-256-GCM)
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SCRYPT_KEYLEN = 32;

function deriveKey(masterKey: string, salt: string): Buffer {
  return scryptSync(masterKey, salt, SCRYPT_KEYLEN);
}

export function encrypt(content: string, masterKey: string, projectId: string): string {
  const key = deriveKey(masterKey, projectId);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(encryptedContent: string, masterKey: string, projectId: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encryptedContent.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Invalid encrypted format");
  }

  const key = deriveKey(masterKey, projectId);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

// Get encryption key from config
export async function getEncryptionKey(): Promise<string | null> {
  await loadEnvConfig();
  return process.env.GENVX_KEY ?? null;
}

// Get project identifier for key derivation
export function getProjectId(gitRemote: string): string {
  const { host, owner, repo } = parseGitRemote(gitRemote);
  return `${host}/${owner}/${repo}`.toLowerCase();
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

// Get file changes with encryption support
async function getFileChangesWithEncryption(
  projectPath: string,
  files: string[],
  direction: Direction,
  encryptionKey: string | null,
  projectId: string
): Promise<Change[]> {
  const changes = await Promise.all(
    files.map(async (file): Promise<Change | null> => {
      const localPath = file;
      const remoteFile = encryptionKey ? `${file}.enc` : file;
      const remotePath = join(projectPath, remoteFile);
      const remoteExists = existsSync(remotePath);

      if (!remoteExists) {
        // New file
        const content = await readFile(localPath, "utf-8");
        const lines = content.split("\n").length;
        return { status: "+", file, added: lines, removed: 0 };
      }

      // Compare content (decrypt remote if encrypted)
      const localContent = await readFile(localPath, "utf-8");
      let remoteContent: string;

      if (encryptionKey) {
        try {
          const encryptedContent = await readFile(remotePath, "utf-8");
          remoteContent = decrypt(encryptedContent, encryptionKey, projectId);
        } catch {
          console.error(`Error: Failed to decrypt remote ${file}. Wrong GENVX_KEY?`);
          process.exit(1);
        }
      } else {
        remoteContent = await readFile(remotePath, "utf-8");
      }

      if (localContent === remoteContent) return null;

      // Calculate diff
      const localLines = localContent.split("\n");
      const remoteLines = remoteContent.split("\n");
      const added = localLines.filter(l => !remoteLines.includes(l)).length;
      const removed = remoteLines.filter(l => !localLines.includes(l)).length;

      return { status: "M", file, added, removed };
    })
  );

  return changes.filter((c): c is Change => c !== null);
}

// Display changes for encrypted files
async function displayAndConfirmEncrypted(
  changes: Change[],
  projectPath: string,
  direction: Direction,
  yes: boolean,
  encryptionKey: string | null,
  projectId: string
): Promise<boolean> {
  const action = direction;
  const arrow = direction === "push" ? "→" : "←";

  console.log("Pending env file changes:");
  for (const c of changes) {
    console.log(`${arrow} ${c.status} ${formatLineDelta(c.file, c.added, c.removed)}`);
    if (c.status === "M") {
      // Show diff between local and decrypted remote
      const localPath = c.file;
      const remoteFile = encryptionKey ? `${c.file}.enc` : c.file;
      const remotePath = join(projectPath, remoteFile);

      if (existsSync(remotePath)) {
        let remoteContent: string;
        if (encryptionKey) {
          try {
            const encryptedContent = await readFile(remotePath, "utf-8");
            remoteContent = decrypt(encryptedContent, encryptionKey, projectId);
          } catch {
            continue;
          }
        } else {
          remoteContent = await readFile(remotePath, "utf-8");
        }

        const localContent = await readFile(localPath, "utf-8");
        const diff = getContentDiff(remoteContent, localContent);
        if (diff) console.log(diff);
      }
    }
  }

  const { added, removed } = sumChanges(changes);
  if (added !== 0 || removed !== 0) {
    console.log(`Lines: +${added} -${removed}`);
  }

  return yes || await confirmAction(`Proceed with ${action}? [Y/n] `);
}

// Get diff between two content strings
function getContentDiff(oldContent: string, newContent: string): string {
  const genvxDir = getGenvxDir();
  const tmpOld = join(genvxDir, "tmp_old");
  const tmpNew = join(genvxDir, "tmp_new");

  try {
    Bun.spawnSync({ cmd: ["mkdir", "-p", genvxDir] });
    require("fs").writeFileSync(tmpOld, oldContent);
    require("fs").writeFileSync(tmpNew, newContent);

    const result = Bun.spawnSync({
      cmd: ["git", "diff", "--no-index", "--color=always", "--", tmpOld, tmpNew],
      stdout: "pipe",
      stderr: "pipe",
    });

    if (!result.stdout) return "";

    return new TextDecoder().decode(result.stdout)
      .split("\n")
      .filter(line => !line.match(/^(\x1b\[\d+m)*(diff|index|---|\+\+\+) /))
      .join("\n")
      .trim();
  } finally {
    try {
      require("fs").unlinkSync(tmpOld);
      require("fs").unlinkSync(tmpNew);
    } catch { /* ignore */ }
  }
}

// Push .env* files to gitstore
export async function pushToGitstore(gitstoreUrl: string, yes = false, useEncryption = true) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const projectId = getProjectId(gitRemote);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  const projectPath = getProjectPath(gitstorePath);
  await ensureDir(projectPath);

  // Get encryption key if encryption is enabled
  let encryptionKey: string | null = null;
  if (useEncryption) {
    encryptionKey = await getEncryptionKey();
    if (!encryptionKey) {
      console.error("Error: GENVX_KEY not set. Add it to ~/.genvx/.env.local or use --no-encrypt.");
      process.exit(1);
    }
  }

  const localFiles = await findEnvFiles(".env*");
  if (localFiles.length === 0) return;

  // For encrypted mode, compare against decrypted remote content
  const changes = await getFileChangesWithEncryption(
    projectPath, localFiles, "push", encryptionKey, projectId
  );

  if (changes.length === 0) {
    localFiles.forEach(file => console.log(`→ ${formatLineDelta(file, 0, 0)}`));
    console.log(".");
    return;
  }

  if (!await displayAndConfirmEncrypted(changes, projectPath, "push", yes, encryptionKey, projectId)) {
    console.log("Push cancelled.");
    return;
  }

  // Copy files (encrypt if enabled)
  for (const { file, added, removed } of changes) {
    await ensureSecurePermissions(file);
    const content = await readFile(file, "utf-8");
    const destFile = encryptionKey ? `${file}.enc` : file;
    const destPath = join(projectPath, destFile);
    await ensureDir(dirname(destPath));

    if (encryptionKey) {
      const encrypted = encrypt(content, encryptionKey, projectId);
      await writeFile(destPath, encrypted);
    } else {
      await copyFile(file, destPath);
    }
    console.log(`→ ${formatLineDelta(file, added, removed)}${encryptionKey ? " (encrypted)" : ""}`);
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
export async function pullFromGitstore(gitstoreUrl: string, yes = false, useEncryption = true) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const projectId = getProjectId(gitRemote);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  const projectPath = getProjectPath(gitstorePath);

  // Get encryption key if encryption is enabled
  let encryptionKey: string | null = null;
  if (useEncryption) {
    encryptionKey = await getEncryptionKey();
    if (!encryptionKey) {
      console.error("Error: GENVX_KEY not set. Add it to ~/.genvx/.env.local or use --no-encrypt.");
      process.exit(1);
    }
  }

  // Find remote files (encrypted or plain)
  const allRemoteFiles = await findEnvFiles(".env*", projectPath);
  const encryptedFiles = allRemoteFiles.filter(f => f.endsWith(".enc"));
  const plainFiles = allRemoteFiles.filter(f => !f.endsWith(".enc"));

  // Determine which files to use based on encryption mode
  let remoteFiles: string[];
  let isEncrypted: boolean;

  if (encryptionKey && encryptedFiles.length > 0) {
    // Use encrypted files, strip .enc suffix for local names
    remoteFiles = encryptedFiles;
    isEncrypted = true;
  } else if (plainFiles.length > 0) {
    remoteFiles = plainFiles;
    isEncrypted = false;
  } else {
    console.log("No env files found in gitstore for this project.");
    return;
  }

  // Get changes
  const changes = await getPullChangesWithEncryption(
    projectPath, remoteFiles, encryptionKey, projectId, isEncrypted
  );

  if (changes.length === 0) {
    const displayFiles = isEncrypted
      ? remoteFiles.map(f => f.replace(/\.enc$/, ""))
      : remoteFiles;
    displayFiles.forEach(file => console.log(`← ${formatLineDelta(file, 0, 0)}`));
    console.log(".");
    return;
  }

  if (!await displayAndConfirmPullEncrypted(changes, projectPath, "pull", yes, encryptionKey, projectId, isEncrypted)) {
    console.log("Pull cancelled.");
    return;
  }

  // Copy files (decrypt if needed)
  for (const { file, added, removed } of changes) {
    const remoteFile = isEncrypted ? `${file}.enc` : file;
    const remotePath = join(projectPath, remoteFile);
    await ensureDir(dirname(file));

    if (isEncrypted && encryptionKey) {
      const encryptedContent = await readFile(remotePath, "utf-8");
      const decrypted = decrypt(encryptedContent, encryptionKey, projectId);
      await writeFile(file, decrypted);
    } else {
      await copyFile(remotePath, file);
    }

    await ensureSecurePermissions(file);
    console.log(`← ${formatLineDelta(file, added, removed)}${isEncrypted ? " (decrypted)" : ""}`);
  }
}

// Get pull changes with encryption support
async function getPullChangesWithEncryption(
  projectPath: string,
  remoteFiles: string[],
  encryptionKey: string | null,
  projectId: string,
  isEncrypted: boolean
): Promise<Change[]> {
  const changes = await Promise.all(
    remoteFiles.map(async (remoteFile): Promise<Change | null> => {
      const localFile = isEncrypted ? remoteFile.replace(/\.enc$/, "") : remoteFile;
      const remotePath = join(projectPath, remoteFile);
      const localExists = existsSync(localFile);

      // Get remote content (decrypt if needed)
      let remoteContent: string;
      if (isEncrypted && encryptionKey) {
        try {
          const encryptedContent = await readFile(remotePath, "utf-8");
          remoteContent = decrypt(encryptedContent, encryptionKey, projectId);
        } catch (err) {
          console.error(`Error: Failed to decrypt ${remoteFile}. Wrong GENVX_KEY?`);
          process.exit(1);
        }
      } else {
        remoteContent = await readFile(remotePath, "utf-8");
      }

      if (!localExists) {
        const lines = remoteContent.split("\n").length;
        return { status: "+", file: localFile, added: lines, removed: 0 };
      }

      const localContent = await readFile(localFile, "utf-8");
      if (localContent === remoteContent) return null;

      const localLines = localContent.split("\n");
      const remoteLines = remoteContent.split("\n");
      const added = remoteLines.filter(l => !localLines.includes(l)).length;
      const removed = localLines.filter(l => !remoteLines.includes(l)).length;

      return { status: "M", file: localFile, added, removed };
    })
  );

  return changes.filter((c): c is Change => c !== null);
}

// Display pull changes for encrypted files
async function displayAndConfirmPullEncrypted(
  changes: Change[],
  projectPath: string,
  direction: Direction,
  yes: boolean,
  encryptionKey: string | null,
  projectId: string,
  isEncrypted: boolean
): Promise<boolean> {
  const arrow = "←";

  console.log("Pending env file changes:");
  for (const c of changes) {
    console.log(`${arrow} ${c.status} ${formatLineDelta(c.file, c.added, c.removed)}`);
    if (c.status === "M") {
      const remoteFile = isEncrypted ? `${c.file}.enc` : c.file;
      const remotePath = join(projectPath, remoteFile);

      if (existsSync(remotePath) && existsSync(c.file)) {
        let remoteContent: string;
        if (isEncrypted && encryptionKey) {
          try {
            const encryptedContent = await readFile(remotePath, "utf-8");
            remoteContent = decrypt(encryptedContent, encryptionKey, projectId);
          } catch {
            continue;
          }
        } else {
          remoteContent = await readFile(remotePath, "utf-8");
        }

        const localContent = await readFile(c.file, "utf-8");
        const diff = getContentDiff(localContent, remoteContent);
        if (diff) console.log(diff);
      }
    }
  }

  const { added, removed } = sumChanges(changes);
  if (added !== 0 || removed !== 0) {
    console.log(`Lines: +${added} -${removed}`);
  }

  return yes || await confirmAction(`Proceed with pull? [Y/n] `);
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
export async function diffWithGitstore(gitstoreUrl: string, useEncryption = true) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const projectId = getProjectId(gitRemote);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  const projectPath = getProjectPath(gitstorePath);

  // Get encryption key if encryption is enabled
  let encryptionKey: string | null = null;
  if (useEncryption) {
    encryptionKey = await getEncryptionKey();
    if (!encryptionKey) {
      console.error("Error: GENVX_KEY not set. Add it to ~/.genvx/.env.local or use --no-encrypt.");
      process.exit(1);
    }
  }

  // Pull direction
  const allRemoteFiles = await findEnvFiles(".env*", projectPath);
  const encryptedFiles = allRemoteFiles.filter(f => f.endsWith(".enc"));
  const plainFiles = allRemoteFiles.filter(f => !f.endsWith(".enc"));

  let remoteFiles: string[];
  let isEncrypted: boolean;

  if (encryptionKey && encryptedFiles.length > 0) {
    remoteFiles = encryptedFiles;
    isEncrypted = true;
  } else if (plainFiles.length > 0) {
    remoteFiles = plainFiles;
    isEncrypted = false;
  } else {
    remoteFiles = [];
    isEncrypted = false;
  }

  if (remoteFiles.length === 0) {
    console.log("pull: (no remote files found)");
  } else {
    const pullChanges = await getPullChangesWithEncryption(
      projectPath, remoteFiles, encryptionKey, projectId, isEncrypted
    );
    if (pullChanges.length === 0) {
      console.log("pull: (no changes)");
    } else {
      console.log("pull:");
      for (const change of pullChanges) {
        console.log(`  ← ${change.status} ${change.file}`);
        if (change.status === "M") {
          const remoteFile = isEncrypted ? `${change.file}.enc` : change.file;
          const remotePath = join(projectPath, remoteFile);

          if (existsSync(remotePath) && existsSync(change.file)) {
            let remoteContent: string;
            if (isEncrypted && encryptionKey) {
              try {
                const encryptedContent = await readFile(remotePath, "utf-8");
                remoteContent = decrypt(encryptedContent, encryptionKey, projectId);
              } catch {
                continue;
              }
            } else {
              remoteContent = await readFile(remotePath, "utf-8");
            }
            const localContent = await readFile(change.file, "utf-8");
            const diff = getContentDiff(localContent, remoteContent);
            if (diff) console.log(diff);
          }
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
  const pushChanges = await getFileChangesWithEncryption(
    projectPath, localFiles, "push", encryptionKey, projectId
  );

  if (pushChanges.length === 0) {
    console.log("push: (no changes)");
  } else {
    console.log("push:");
    for (const change of pushChanges) {
      console.log(`  → ${change.status} ${change.file}`);
      if (change.status === "M") {
        const remoteFile = encryptionKey ? `${change.file}.enc` : change.file;
        const remotePath = join(projectPath, remoteFile);

        if (existsSync(remotePath)) {
          let remoteContent: string;
          if (encryptionKey) {
            try {
              const encryptedContent = await readFile(remotePath, "utf-8");
              remoteContent = decrypt(encryptedContent, encryptionKey, projectId);
            } catch {
              continue;
            }
          } else {
            remoteContent = await readFile(remotePath, "utf-8");
          }
          const localContent = await readFile(change.file, "utf-8");
          const diff = getContentDiff(remoteContent, localContent);
          if (diff) console.log(diff);
        }
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

// Migrate from v1 (single branch with directories) to v2 (branch-per-project with encryption)
export async function migrateFromV1(gitstoreUrl: string, yes = false) {
  const genvxDir = await setupGenvxDir();
  const v1Path = join(genvxDir, "v1-gitstore");
  const encryptionKey = await getEncryptionKey();

  if (!encryptionKey) {
    console.error("Error: GENVX_KEY not set. Add it to ~/.genvx/.env.local for migration.");
    process.exit(1);
  }

  console.log("Cloning v1 gitstore...");

  // Clone the old v1 gitstore (main/master branch)
  const cloneResult = await Bun.$`git clone --depth 1 -q ${gitstoreUrl} ${v1Path}`.quiet().nothrow();
  if (cloneResult.exitCode !== 0) {
    console.error("Failed to clone gitstore. Is it a valid git repository?");
    process.exit(1);
  }

  // Find all project directories (host/owner/repo structure)
  const projects: { host: string; owner: string; repo: string; path: string }[] = [];

  const hosts = readdirSync(v1Path).filter(f => {
    const p = join(v1Path, f);
    return statSync(p).isDirectory() && !f.startsWith(".") && f.includes(".");
  });

  for (const host of hosts) {
    const hostPath = join(v1Path, host);
    const owners = readdirSync(hostPath).filter(f => {
      const p = join(hostPath, f);
      return statSync(p).isDirectory();
    });

    for (const owner of owners) {
      const ownerPath = join(hostPath, owner);
      const repos = readdirSync(ownerPath).filter(f => {
        const p = join(ownerPath, f);
        return statSync(p).isDirectory();
      });

      for (const repo of repos) {
        const repoPath = join(ownerPath, repo);
        const envFiles = await findEnvFiles(".env*", repoPath);
        if (envFiles.length > 0) {
          projects.push({ host, owner, repo, path: repoPath });
        }
      }
    }
  }

  if (projects.length === 0) {
    console.log("No projects found in v1 gitstore.");
    return;
  }

  console.log(`Found ${projects.length} project(s) to migrate:`);
  for (const p of projects) {
    const envFiles = await findEnvFiles(".env*", p.path);
    console.log(`  ${p.host}/${p.owner}/${p.repo} (${envFiles.length} env files)`);
  }

  if (!yes) {
    const confirmed = await confirmAction("\nProceed with migration? [Y/n] ");
    if (!confirmed) {
      console.log("Migration cancelled.");
      return;
    }
  }

  // Migrate each project
  for (const project of projects) {
    const gitRemote = `https://${project.host}/${project.owner}/${project.repo}`;
    const branch = getBranchName(gitRemote);
    const projectId = getProjectId(gitRemote);

    console.log(`\nMigrating ${project.host}/${project.owner}/${project.repo}...`);
    console.log(`  Branch: ${branch}`);

    // Create a new temp directory for this project's branch
    const projectGitPath = join(genvxDir, `migrate-${branch.replace("/", "-")}`);

    // Initialize new orphan branch
    await mkdir(projectGitPath, { recursive: true });
    await Bun.$`git -C ${projectGitPath} init -q`.quiet();
    await Bun.$`git -C ${projectGitPath} remote add origin ${gitstoreUrl}`.quiet();
    await Bun.$`git -C ${projectGitPath} checkout --orphan ${branch}`.quiet();

    // Copy and encrypt files
    const envFiles = await findEnvFiles(".env*", project.path);
    for (const file of envFiles) {
      const sourcePath = join(project.path, file);
      const content = await readFile(sourcePath, "utf-8");
      const encrypted = encrypt(content, encryptionKey, projectId);
      const destPath = join(projectGitPath, `${file}.enc`);

      await ensureDir(dirname(destPath));
      await writeFile(destPath, encrypted);
      console.log(`  → ${file} (encrypted)`);
    }

    // Commit and push
    await Bun.$`git -C ${projectGitPath} add -A`.quiet();
    await Bun.$`git -C ${projectGitPath} commit -m "Migrate from v1"`.quiet();

    const pushResult = await Bun.$`git -C ${projectGitPath} push -u origin ${branch} -q`.quiet().nothrow();
    if (pushResult.exitCode !== 0) {
      console.error(`  Failed to push branch ${branch}`);
    } else {
      console.log(`  Pushed to ${branch}`);
    }
  }

  console.log("\nMigration complete!");
  console.log("You can now use genvx push/pull with the new branch-per-project structure.");
}
