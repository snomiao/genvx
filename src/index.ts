import { existsSync, readdirSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { readFile, writeFile, copyFile, mkdir, rm, chmod } from "fs/promises";
import { join, resolve, sep, dirname } from "path";
import { platform, homedir } from "os";
import { createInterface } from "readline/promises";
import { createHash, scryptSync, randomBytes, createCipheriv, createDecipheriv } from "crypto";

// Types
type Change = { status: string; file: string; added: number; removed: number };
type FilePair = { localFile: string; remoteFile: string };
type Direction = "pull" | "push";

// Pure utility functions
const isWindows = () => platform() === "win32";

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
const SCRYPT_KEYLEN = 32;
const SALT_LENGTH = 32;
const SCRYPT_LOG_N = 17; // N = 2^17 = 131072, ~128MB memory, ~0.5-1s
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKeyV2(masterKey: string, salt: Buffer, logN: number): Buffer {
  return scryptSync(masterKey, salt, SCRYPT_KEYLEN, {
    N: 2 ** logN,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
}

function deriveKeyV1(masterKey: string, salt: string): Buffer {
  return scryptSync(masterKey, salt, SCRYPT_KEYLEN);
}

export function encrypt(content: string, masterKey: string, _projectId?: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKeyV2(masterKey, salt, SCRYPT_LOG_N);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // v2 format: v2:{logN}:{salt_b64}:{iv_b64}:{authTag_b64}:{ciphertext_b64}
  return [
    "v2",
    SCRYPT_LOG_N,
    salt.toString("base64"),
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptV2(encryptedContent: string, masterKey: string): string {
  const parts = encryptedContent.split(":");
  if (parts.length !== 6 || parts[0] !== "v2") {
    throw new Error("Invalid v2 encrypted format");
  }

  const logN = parseInt(parts[1]!, 10);
  const salt = Buffer.from(parts[2]!, "base64");
  const iv = Buffer.from(parts[3]!, "base64");
  const authTag = Buffer.from(parts[4]!, "base64");
  const ciphertext = Buffer.from(parts[5]!, "base64");

  const key = deriveKeyV2(masterKey, salt, logN);
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

function decryptV1(encryptedContent: string, masterKey: string, projectId: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encryptedContent.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Invalid encrypted format");
  }

  const key = deriveKeyV1(masterKey, projectId);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return decipher.update(ciphertext) + decipher.final("utf8");
}

export function decrypt(encryptedContent: string, masterKey: string, projectId: string): string {
  if (encryptedContent.startsWith("v2:")) {
    return decryptV2(encryptedContent, masterKey);
  }
  return decryptV1(encryptedContent, masterKey, projectId);
}

// Env var diff utilities (Vercel-style)
type EnvVarChange = { key: string; type: "added" | "updated" | "removed" };

function parseEnvVars(content: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1);
    if (key) vars.set(key, value);
  }
  return vars;
}

function diffEnvVars(oldContent: string, newContent: string): EnvVarChange[] {
  const oldVars = parseEnvVars(oldContent);
  const newVars = parseEnvVars(newContent);
  const changes: EnvVarChange[] = [];

  for (const [key, value] of newVars) {
    if (!oldVars.has(key)) {
      changes.push({ key, type: "added" });
    } else if (oldVars.get(key) !== value) {
      changes.push({ key, type: "updated" });
    }
  }
  for (const key of oldVars.keys()) {
    if (!newVars.has(key)) {
      changes.push({ key, type: "removed" });
    }
  }
  return changes;
}

function formatEnvVarChange(c: EnvVarChange): string {
  switch (c.type) {
    case "added": return `  + ${c.key}`;
    case "updated": return `  + ${c.key} (Updated)`;
    case "removed": return `  - ${c.key}`;
  }
}

// Load env config (guarded against redundant calls)
let envConfigLoaded = false;

async function loadEnvConfig() {
  if (envConfigLoaded) return;
  envConfigLoaded = true;

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
    const cloneResult = await Bun.$`git clone --single-branch --depth 1 -b ${branch} -q ${gitstoreUrl} ${gitstorePath}`.quiet().nothrow();

    if (cloneResult.exitCode !== 0) {
      await mkdir(gitstorePath, { recursive: true });
      await Bun.$`git -C ${gitstorePath} init -q`.quiet();
      await Bun.$`git -C ${gitstorePath} remote add origin ${gitstoreUrl}`.quiet();
      await Bun.$`git -C ${gitstorePath} checkout --orphan ${branch}`.quiet();
      await Bun.$`git -C ${gitstorePath} commit --allow-empty -m "Initialize env branch" -q`.quiet();
    }
  } else {
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

// Compute line diff stats between two content strings using git diff --numstat
function getNumstat(oldContent: string, newContent: string): { added: number; removed: number } {
  const genvxDir = getGenvxDir();
  const tmpOld = join(genvxDir, "tmp_numstat_old");
  const tmpNew = join(genvxDir, "tmp_numstat_new");

  try {
    mkdirSync(genvxDir, { recursive: true });
    writeFileSync(tmpOld, oldContent);
    writeFileSync(tmpNew, newContent);

    const result = Bun.spawnSync({
      cmd: ["git", "diff", "--no-index", "--numstat", "--", tmpOld, tmpNew],
      stdout: "pipe",
      stderr: "pipe",
    });

    if (!result.stdout) return { added: 0, removed: 0 };

    let added = 0, removed = 0;
    const stdout = new TextDecoder().decode(result.stdout);
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [a, r] = line.split("\t");
      added += Number(a) || 0;
      removed += Number(r) || 0;
    }
    return { added, removed };
  } finally {
    try { unlinkSync(tmpOld); } catch { /* ignore */ }
    try { unlinkSync(tmpNew); } catch { /* ignore */ }
  }
}

// Resolve encryption key, throwing if required but missing
async function requireEncryptionKey(useEncryption: boolean): Promise<string | null> {
  if (!useEncryption) return null;
  const key = await getEncryptionKey();
  if (!key) {
    throw new Error("GENVX_KEY not set. Add it to ~/.genvx/.env.local or use --no-encrypt.");
  }
  return key;
}

// Unified change detection for push and pull
async function detectChanges(
  projectPath: string,
  pairs: FilePair[],
  direction: Direction,
  encryptionKey: string | null,
  projectId: string,
): Promise<Change[]> {
  const changes = await Promise.all(
    pairs.map(async ({ localFile, remoteFile }): Promise<Change | null> => {
      const remotePath = join(projectPath, remoteFile);
      const localExists = existsSync(localFile);
      const remoteExists = existsSync(remotePath);

      // Read remote content (decrypt if needed)
      let remoteContent: string | null = null;
      if (remoteExists) {
        const raw = await readFile(remotePath, "utf-8");
        if (encryptionKey && remoteFile.endsWith(".enc")) {
          try {
            remoteContent = decrypt(raw, encryptionKey, projectId);
          } catch {
            throw new Error(`Failed to decrypt ${remoteFile}. Wrong GENVX_KEY?`);
          }
        } else {
          remoteContent = raw;
        }
      }

      const localContent = localExists ? await readFile(localFile, "utf-8") : null;

      // Source = what we're copying from, dest = what we're copying to
      const sourceContent = direction === "push" ? localContent : remoteContent;
      const destContent = direction === "push" ? remoteContent : localContent;

      if (sourceContent === null) return null;
      if (destContent !== null && sourceContent === destContent) return null;

      const isNew = destContent === null;
      let added: number, removed: number;
      if (isNew) {
        added = sourceContent.split("\n").length;
        removed = 0;
      } else {
        ({ added, removed } = getNumstat(destContent, sourceContent));
      }

      return { status: isNew ? "+" : "M", file: localFile, added, removed };
    })
  );

  return changes.filter((c): c is Change => c !== null);
}

// Read content for a file pair (handles decryption)
async function readPairContent(
  c: Change,
  projectPath: string,
  encryptionKey: string | null,
  projectId: string,
): Promise<{ oldContent: string; newContent: string } | null> {
  const isEncrypted = encryptionKey !== null;
  const remoteFile = isEncrypted ? `${c.file}.enc` : c.file;
  const remotePath = join(projectPath, remoteFile);

  if (!existsSync(remotePath) || !existsSync(c.file)) return null;

  let remoteContent: string;
  if (isEncrypted) {
    try {
      remoteContent = decrypt(await readFile(remotePath, "utf-8"), encryptionKey!, projectId);
    } catch { return null; }
  } else {
    remoteContent = await readFile(remotePath, "utf-8");
  }

  return { oldContent: remoteContent, newContent: await readFile(c.file, "utf-8") };
}

// Display Vercel-style env var changes
async function displayChanges(
  changes: Change[],
  projectPath: string,
  direction: Direction,
  encryptionKey: string | null,
  projectId: string,
  indent = "",
): Promise<void> {
  for (const c of changes) {
    if (c.status === "+") {
      // New file — all vars are added
      const sourceContent = direction === "push"
        ? await readFile(c.file, "utf-8")
        : await (async () => {
          const isEnc = encryptionKey !== null;
          const rf = isEnc ? `${c.file}.enc` : c.file;
          const rp = join(projectPath, rf);
          const raw = await readFile(rp, "utf-8");
          return isEnc ? decrypt(raw, encryptionKey!, projectId) : raw;
        })();
      const vars = parseEnvVars(sourceContent);
      console.log(`${indent}${c.file} (New):`);
      for (const key of vars.keys()) {
        console.log(`${indent}  + ${key}`);
      }
    } else {
      // Modified file — show per-var diff
      const pair = await readPairContent(c, projectPath, encryptionKey, projectId);
      if (!pair) continue;
      const [oldContent, newContent] = direction === "push"
        ? [pair.oldContent, pair.newContent]
        : [pair.newContent, pair.oldContent];
      const varChanges = diffEnvVars(oldContent, newContent);
      if (varChanges.length > 0) {
        console.log(`${indent}${c.file}:`);
        for (const vc of varChanges) {
          console.log(`${indent}${formatEnvVarChange(vc)}`);
        }
      } else {
        console.log(`${indent}${c.file} (formatting changes)`);
      }
    }
  }
}

// Display changes and ask for confirmation
async function displayAndConfirm(
  changes: Change[],
  projectPath: string,
  direction: Direction,
  yes: boolean,
  encryptionKey: string | null,
  projectId: string,
): Promise<boolean> {
  console.log("\nChanges:");
  await displayChanges(changes, projectPath, direction, encryptionKey, projectId, "  ");
  console.log();
  return yes || await confirmAction(`Proceed with ${direction}? [Y/n] `);
}

// Build file pairs for push direction
function buildPushPairs(localFiles: string[], encryptionKey: string | null): FilePair[] {
  return localFiles.map(f => ({
    localFile: f,
    remoteFile: encryptionKey ? `${f}.enc` : f,
  }));
}

// Build file pairs for pull direction
function buildPullPairs(remoteFiles: string[], isEncrypted: boolean): FilePair[] {
  return remoteFiles.map(f => ({
    localFile: isEncrypted ? f.replace(/\.enc$/, "") : f,
    remoteFile: f,
  }));
}

// Resolve remote files and determine encryption state
async function resolveRemoteFiles(
  projectPath: string,
  encryptionKey: string | null,
): Promise<{ remoteFiles: string[]; isEncrypted: boolean } | null> {
  const allRemoteFiles = await findEnvFiles(".env*", projectPath);
  const encryptedFiles = allRemoteFiles.filter(f => f.endsWith(".enc"));
  const plainFiles = allRemoteFiles.filter(f => !f.endsWith(".enc"));

  if (encryptionKey && encryptedFiles.length > 0) {
    return { remoteFiles: encryptedFiles, isEncrypted: true };
  }
  if (plainFiles.length > 0) {
    return { remoteFiles: plainFiles, isEncrypted: false };
  }
  return null;
}

// Push .env* files to gitstore
export async function pushToGitstore(gitstoreUrl: string, yes = false, useEncryption = true) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const projectId = getProjectId(gitRemote);
  const encryptionKey = await requireEncryptionKey(useEncryption);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);
  await ensureDir(gitstorePath);

  const localFiles = await findEnvFiles(".env*");
  if (localFiles.length === 0) return;

  const pairs = buildPushPairs(localFiles, encryptionKey);
  const changes = await detectChanges(gitstorePath, pairs, "push", encryptionKey, projectId);

  if (changes.length === 0) {
    console.log("\u2705 No changes");
    return;
  }

  if (!await displayAndConfirm(changes, gitstorePath, "push", yes, encryptionKey, projectId)) {
    console.log("Push cancelled.");
    return;
  }

  // Copy files (encrypt if enabled)
  for (const { file, status } of changes) {
    const start = performance.now();
    await ensureSecurePermissions(file);
    const content = await readFile(file, "utf-8");
    const destFile = encryptionKey ? `${file}.enc` : file;
    const destPath = join(gitstorePath, destFile);
    await ensureDir(dirname(destPath));

    if (encryptionKey) {
      const encrypted = encrypt(content, encryptionKey, projectId);
      await writeFile(destPath, encrypted);
    } else {
      await copyFile(file, destPath);
    }
    const ms = Math.round(performance.now() - start);
    const verb = status === "+" ? "Created" : "Updated";
    console.log(`\u2705 ${verb} ${file}${encryptionKey ? " (encrypted)" : ""}  [${ms}ms]`);
  }

  // Commit and push to branch
  await Bun.$`git -C ${gitstorePath} add -A`.quiet();
  await Bun.$`git -C ${gitstorePath} commit -m "Update env files"`.quiet();
  const pushResult = await Bun.$`git -C ${gitstorePath} push -u origin ${branch} -q`.quiet().nothrow();
  if (pushResult.exitCode !== 0) {
    throw new Error(`Failed to push to gitstore: ${pushResult.stderr.toString()}`);
  }
}

// Pull .env* files from gitstore
export async function pullFromGitstore(gitstoreUrl: string, yes = false, useEncryption = true) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const projectId = getProjectId(gitRemote);
  const encryptionKey = await requireEncryptionKey(useEncryption);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);

  const resolved = await resolveRemoteFiles(gitstorePath, encryptionKey);
  if (!resolved) {
    console.log("No env files found in gitstore for this project.");
    return;
  }

  const { remoteFiles, isEncrypted } = resolved;
  const pairs = buildPullPairs(remoteFiles, isEncrypted);
  const changes = await detectChanges(gitstorePath, pairs, "pull", encryptionKey, projectId);

  if (changes.length === 0) {
    console.log("\u2705 No changes");
    return;
  }

  if (!await displayAndConfirm(changes, gitstorePath, "pull", yes, encryptionKey, projectId)) {
    console.log("Pull cancelled.");
    return;
  }

  // Copy files (decrypt if needed)
  for (const { file, status } of changes) {
    const start = performance.now();
    const remoteFile = isEncrypted ? `${file}.enc` : file;
    const remotePath = join(gitstorePath, remoteFile);
    await ensureDir(dirname(file));

    if (isEncrypted && encryptionKey) {
      const encryptedContent = await readFile(remotePath, "utf-8");
      const decrypted = decrypt(encryptedContent, encryptionKey, projectId);
      await writeFile(file, decrypted);
    } else {
      await copyFile(remotePath, file);
    }

    await ensureSecurePermissions(file);
    const ms = Math.round(performance.now() - start);
    const verb = status === "+" ? "Created" : "Updated";
    console.log(`\u2705 ${verb} ${file}  [${ms}ms]`);
  }
}

// Diff .env* files (dry run)
export async function diffWithGitstore(gitstoreUrl: string, useEncryption = true) {
  const gitRemote = await getGitRemote();
  const branch = getBranchName(gitRemote);
  const projectId = getProjectId(gitRemote);
  const encryptionKey = await requireEncryptionKey(useEncryption);
  const gitstorePath = await syncGitstore(gitstoreUrl, branch);

  // Pull direction
  const resolved = await resolveRemoteFiles(gitstorePath, encryptionKey);
  if (!resolved) {
    console.log("pull: (no remote files found)");
  } else {
    const { remoteFiles, isEncrypted } = resolved;
    const pairs = buildPullPairs(remoteFiles, isEncrypted);
    const pullChanges = await detectChanges(gitstorePath, pairs, "pull", encryptionKey, projectId);
    if (pullChanges.length === 0) {
      console.log("pull: (no changes)");
    } else {
      console.log("pull:");
      await displayChanges(pullChanges, gitstorePath, "pull", encryptionKey, projectId, "  ");
    }
  }

  // Push direction
  const localFiles = await findEnvFiles(".env*");
  if (localFiles.length === 0) {
    console.log("push: (no local .env* files)");
    return;
  }

  await ensureDir(gitstorePath);
  const pushPairs = buildPushPairs(localFiles, encryptionKey);
  const pushChanges = await detectChanges(gitstorePath, pushPairs, "push", encryptionKey, projectId);
  if (pushChanges.length === 0) {
    console.log("push: (no changes)");
  } else {
    console.log("push:");
    await displayChanges(pushChanges, gitstorePath, "push", encryptionKey, projectId, "  ");
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

