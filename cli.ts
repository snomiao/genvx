#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { execaCommand } from "execa";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { createHash } from "crypto";

type EnvLine = { key: string; value: string; raw: string };

function parseEnvFile(content: string): Map<string, EnvLine> {
  const lines = content.split("\n");
  const map = new Map<string, EnvLine>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const [, key, value] = match;
      map.set(key.trim(), { key: key.trim(), value, raw: line });
    }
  }

  return map;
}

function mergeEnvFiles(localContent: string, decryptedContent: string): string {
  const localMap = parseEnvFile(localContent);
  const decryptedMap = parseEnvFile(decryptedContent);

  const allKeys = new Set([...localMap.keys(), ...decryptedMap.keys()]);
  const result: string[] = [];

  for (const key of allKeys) {
    const localLine = localMap.get(key);
    const decryptedLine = decryptedMap.get(key);

    if (localLine && decryptedLine) {
      // Both exist - check for conflicts
      if (localLine.value !== decryptedLine.value) {
        result.push(`# Conflict: kept local value, encrypted had: ${decryptedLine.value}`);
        result.push(localLine.raw);
      } else {
        result.push(localLine.raw);
      }
    } else if (localLine) {
      // Only in local
      result.push(localLine.raw);
    } else if (decryptedLine) {
      // Only in encrypted
      result.push(decryptedLine.raw);
    }
  }

  return result.join("\n") + "\n";
}

async function findEnvFiles(pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];

  for await (const file of glob.scan(".")) {
    files.push(file);
  }

  return files;
}

function getEnvName(localFile: string): string {
  const match = localFile.match(/\.env\.(.+)\.local$/);
  return match ? match[1] : "";
}

// Gitstore configuration
function getGitstoreConfig(cliGitstore?: string): string | null {
  // Priority 1: CLI flag
  if (cliGitstore) {
    return cliGitstore;
  }

  // Priority 2: Environment variable
  if (process.env.DENVX_GITSTORE) {
    return process.env.DENVX_GITSTORE;
  }

  // Priority 3: .env.local file
  if (existsSync(".env.local")) {
    const content = readFileSync(".env.local", "utf-8");
    const envMap = parseEnvFile(content);
    const gitstoreVar = envMap.get("DENVX_GITSTORE");
    if (gitstoreVar) {
      return gitstoreVar.value.replace(/^["']|["']$/g, "");
    }
  }

  return null;
}

// Redact credentials from URL for display
function redactUrlCredentials(url: string): string {
  try {
    const urlObj = new URL(url);
    if (urlObj.username || urlObj.password) {
      // Replace credentials with asterisks
      return url.replace(/\/\/[^@]+@/, '//***@');
    }
    return url;
  } catch {
    // If URL parsing fails, try regex fallback
    return url.replace(/\/\/[^@]+@/, '//***@');
  }
}

// Normalize git remote URL (git@github.com:user/repo.git -> https://github.com/user/repo.git)
function normalizeGitRemote(remote: string): string {
  // Convert SSH format to HTTPS
  if (remote.startsWith("git@")) {
    return remote
      .replace(/^git@/, "https://")
      .replace(/\.com:/, ".com/");
  }
  return remote;
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

// Calculate branch ID from git remote
function calculateBranchId(gitRemote: string): string {
  const normalized = normalizeGitRemote(gitRemote);
  const hash = createHash("sha256").update(normalized).digest("hex");
  return hash.slice(0, 12);
}

// Setup .denvx directory
async function setupDenvxDir() {
  const denvxDir = "./.denvx";
  const gitignorePath = join(denvxDir, ".gitignore");

  if (!existsSync(denvxDir)) {
    mkdirSync(denvxDir, { recursive: true });
  }

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n");
  }
}

// Clone or sync gitstore repository
async function syncGitstore(gitstoreUrl: string, branchId: string): Promise<string> {
  await setupDenvxDir();

  const gitstorePath = "./.denvx/gitstore";

  if (!existsSync(gitstorePath)) {
    console.log(`Cloning gitstore from ${redactUrlCredentials(gitstoreUrl)}...`);
    try {
      await execaCommand(`git clone ${gitstoreUrl} ${gitstorePath}`, {
        shell: true,
        stdio: 'inherit'
      });
    } catch (error) {
      console.log(`Repository doesn't exist yet, will create it when pushing...`);
      // Initialize an empty repo
      mkdirSync(gitstorePath, { recursive: true });
      await execaCommand(`cd ${gitstorePath} && git init`, { shell: true });
      await execaCommand(`cd ${gitstorePath} && git remote add origin ${gitstoreUrl}`, { shell: true });
    }
  }

  // Fetch and checkout/create branch
  try {
    await execaCommand(`cd ${gitstorePath} && git fetch origin`, { shell: true });

    // Try to checkout existing branch or create new one
    try {
      await execaCommand(`cd ${gitstorePath} && git checkout ${branchId}`, { shell: true });
      await execaCommand(`cd ${gitstorePath} && git pull origin ${branchId}`, { shell: true });
    } catch {
      // Branch doesn't exist, create it
      await execaCommand(`cd ${gitstorePath} && git checkout -b ${branchId}`, { shell: true });
    }
  } catch (error) {
    // Remote doesn't exist yet, that's ok
    console.log(`Creating new branch ${branchId}...`);
    await execaCommand(`cd ${gitstorePath} && git checkout -b ${branchId}`, { shell: true });
  }

  return gitstorePath;
}

// Push changes to gitstore
async function pushGitstore(gitstorePath: string, branchId: string, message: string) {
  try {
    await execaCommand(`cd ${gitstorePath} && git add -A`, { shell: true });

    // Check if there are changes to commit
    try {
      await execaCommand(`cd ${gitstorePath} && git diff-index --quiet HEAD`, { shell: true });
      console.log("No changes to push to gitstore");
      return;
    } catch {
      // There are changes, proceed with commit
    }

    await execaCommand(`cd ${gitstorePath} && git commit -m "${message}"`, { shell: true });
    await execaCommand(`cd ${gitstorePath} && git push -u origin ${branchId}`, {
      shell: true,
      stdio: 'inherit'
    });
    console.log(`✓ Pushed to gitstore branch ${branchId}`);
  } catch (error) {
    console.error("Failed to push to gitstore:", error);
  }
}

async function encryptEnvFile(name: string, gitstoreUrl?: string) {
  const localFile = `.env.${name}.local`;
  let encryptedFile = `.env.${name}.encrypted`;

  if (!existsSync(localFile)) {
    console.error(`Error: ${localFile} does not exist`);
    process.exit(1);
  }

  let gitstorePath: string | null = null;
  let branchId: string | null = null;

  if (gitstoreUrl) {
    // Using gitstore
    const gitRemote = await getGitRemote();
    branchId = calculateBranchId(gitRemote);
    gitstorePath = await syncGitstore(gitstoreUrl, branchId);
    encryptedFile = join(gitstorePath, `.env.${name}.encrypted`);
    console.log(`Using gitstore on branch ${branchId}`);
  }

  console.log(`Encrypting ${localFile} to ${encryptedFile}...`);

  try {
    // Copy local to encrypted file first
    copyFileSync(localFile, encryptedFile);

    // Encrypt in place
    await execaCommand(`bunx dotenvx encrypt -f ${encryptedFile}`, {
      shell: true,
      stdio: 'inherit'
    });

    console.log(`✓ Encrypted ${localFile} -> ${encryptedFile}`);

    // If using gitstore, push changes
    if (gitstorePath && branchId) {
      await pushGitstore(gitstorePath, branchId, `Encrypt .env.${name}.encrypted`);
    }
  } catch (error) {
    console.error(`Failed to encrypt ${localFile}:`, error);
    process.exit(1);
  }
}

async function decryptEnvFile(name: string, merge = false, gitstoreUrl?: string) {
  const localFile = `.env.${name}.local`;
  let encryptedFile = `.env.${name}.encrypted`;

  let gitstorePath: string | null = null;
  let branchId: string | null = null;

  if (gitstoreUrl) {
    // Using gitstore
    const gitRemote = await getGitRemote();
    branchId = calculateBranchId(gitRemote);
    gitstorePath = await syncGitstore(gitstoreUrl, branchId);
    encryptedFile = join(gitstorePath, `.env.${name}.encrypted`);
    console.log(`Using gitstore on branch ${branchId}`);
  }

  if (!existsSync(encryptedFile)) {
    console.error(`Error: ${encryptedFile} does not exist`);
    process.exit(1);
  }

  console.log(`Decrypting ${encryptedFile} to ${localFile}...`);

  try {
    // Decrypt to temp file first
    const tempFile = `.env.${name}.temp`;
    copyFileSync(encryptedFile, tempFile);

    // Decrypt in place
    await execaCommand(`bunx dotenvx decrypt -f ${tempFile}`, {
      shell: true,
      stdio: 'inherit'
    });

    const decryptedContent = readFileSync(tempFile, "utf-8");

    if (merge && existsSync(localFile)) {
      // Merge with existing local file
      const localContent = readFileSync(localFile, "utf-8");
      const merged = mergeEnvFiles(localContent, decryptedContent);
      writeFileSync(localFile, merged);
      console.log(`✓ Decrypted and merged ${encryptedFile} -> ${localFile}`);
    } else {
      // Just write the decrypted content
      writeFileSync(localFile, decryptedContent);
      console.log(`✓ Decrypted ${encryptedFile} -> ${localFile}`);
    }

    // Clean up temp file
    unlinkSync(tempFile);
  } catch (error) {
    console.error(`Failed to decrypt ${encryptedFile}:`, error);
    process.exit(1);
  }
}

async function syncEnvFile(name: string, gitstoreUrl?: string) {
  const localFile = `.env.${name}.local`;
  let encryptedFile = `.env.${name}.encrypted`;

  let gitstorePath: string | null = null;
  let branchId: string | null = null;

  if (gitstoreUrl) {
    // Using gitstore
    const gitRemote = await getGitRemote();
    branchId = calculateBranchId(gitRemote);
    gitstorePath = await syncGitstore(gitstoreUrl, branchId);
    encryptedFile = join(gitstorePath, `.env.${name}.encrypted`);
    console.log(`Using gitstore on branch ${branchId}`);
  }

  const localExists = existsSync(localFile);
  const encryptedExists = existsSync(encryptedFile);

  if (!localExists && !encryptedExists) {
    console.error(`Error: Neither ${localFile} nor ${encryptedFile} exists`);
    return;
  }

  if (localExists && !encryptedExists) {
    // Only local exists, encrypt it
    console.log(`${encryptedFile} not found, creating from ${localFile}...`);
    await encryptEnvFile(name, gitstoreUrl);
  } else if (!localExists && encryptedExists) {
    // Only encrypted exists, decrypt it
    console.log(`${localFile} not found, creating from ${encryptedFile}...`);
    await decryptEnvFile(name, false, gitstoreUrl);
  } else {
    // Both exist - sync them
    const localStat = Bun.file(localFile);
    const encryptedStat = Bun.file(encryptedFile);

    const localMtime = (await localStat.stat()).mtime;
    const encryptedMtime = (await encryptedStat.stat()).mtime;

    if (localMtime > encryptedMtime) {
      console.log(`${localFile} is newer, encrypting...`);
      await encryptEnvFile(name, gitstoreUrl);
    } else if (encryptedMtime > localMtime) {
      console.log(`${encryptedFile} is newer, decrypting and merging...`);
      await decryptEnvFile(name, true, gitstoreUrl);
    } else {
      console.log(`${name}: Files are in sync`);
    }
  }
}

async function syncAll(gitstoreUrl?: string) {
  let gitstorePath: string | null = null;
  let branchId: string | null = null;

  if (gitstoreUrl) {
    const gitRemote = await getGitRemote();
    branchId = calculateBranchId(gitRemote);
    gitstorePath = await syncGitstore(gitstoreUrl, branchId);
  }

  const localFiles = await findEnvFiles(".env.*.local");
  let encryptedFiles: string[] = [];

  if (gitstorePath) {
    // Find encrypted files in gitstore
    const glob = new Bun.Glob(".env.*.encrypted");
    for await (const file of glob.scan(gitstorePath)) {
      encryptedFiles.push(file);
    }
  } else {
    // Find encrypted files in current directory
    encryptedFiles = await findEnvFiles(".env.*.encrypted");
  }

  const names = new Set<string>();

  for (const file of localFiles) {
    names.add(getEnvName(file));
  }

  for (const file of encryptedFiles) {
    const name = file.replace(/\.env\.(.+)\.encrypted$/, "$1");
    names.add(name);
  }

  if (names.size === 0) {
    console.log("No .env.*.local or .env.*.encrypted files found");
    return;
  }

  for (const name of names) {
    await syncEnvFile(name, gitstoreUrl);
  }
}

// Setup yargs CLI
yargs(hideBin(process.argv))
  .scriptName("denvx")
  .usage("$0 <command> [options]")
  .option("gitstore", {
    alias: "g",
    type: "string",
    description: "Git repository URL for storing encrypted files",
  })
  .command(
    "sync [name]",
    "Sync .env.[name].local <=> .env.[name].encrypted",
    (yargs) => {
      return yargs.positional("name", {
        describe: "Environment name (e.g., prod, dev). If omitted, sync all files",
        type: "string",
      });
    },
    async (argv) => {
      const gitstore = getGitstoreConfig(argv.gitstore as string | undefined);

      if (argv.name) {
        await syncEnvFile(argv.name as string, gitstore || undefined);
      } else {
        await syncAll(gitstore || undefined);
      }
    }
  )
  .command(
    ["encrypt <name>", "enc <name>"],
    "Encrypt .env.[name].local to .env.[name].encrypted",
    (yargs) => {
      return yargs.positional("name", {
        describe: "Environment name (e.g., prod, dev)",
        type: "string",
        demandOption: true,
      });
    },
    async (argv) => {
      const gitstore = getGitstoreConfig(argv.gitstore as string | undefined);
      await encryptEnvFile(argv.name as string, gitstore || undefined);
    }
  )
  .command(
    ["decrypt <name>", "dec <name>"],
    "Decrypt .env.[name].encrypted to .env.[name].local",
    (yargs) => {
      return yargs.positional("name", {
        describe: "Environment name (e.g., prod, dev)",
        type: "string",
        demandOption: true,
      });
    },
    async (argv) => {
      const gitstore = getGitstoreConfig(argv.gitstore as string | undefined);
      await decryptEnvFile(argv.name as string, false, gitstore || undefined);
    }
  )
  .example("$0 sync", "Sync all .env.*.local files")
  .example("$0 sync prod", "Sync .env.prod.local <=> .env.prod.encrypted")
  .example("$0 encrypt dev", "Encrypt .env.dev.local")
  .example("$0 decrypt dev", "Decrypt .env.dev.encrypted")
  .example("$0 --gitstore=https://github.com/user/envs.git sync", "Sync using remote gitstore")
  .demandCommand(1, "You need to specify a command")
  .help()
  .alias("h", "help")
  .version()
  .alias("v", "version")
  .parse();
