#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { execaCommand } from "execa";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "fs";
import { resolve } from "path";

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

async function encryptEnvFile(name: string) {
  const localFile = `.env.${name}.local`;
  const encryptedFile = `.env.${name}.encrypted`;

  if (!existsSync(localFile)) {
    console.error(`Error: ${localFile} does not exist`);
    process.exit(1);
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
  } catch (error) {
    console.error(`Failed to encrypt ${localFile}:`, error);
    process.exit(1);
  }
}

async function decryptEnvFile(name: string, merge = false) {
  const localFile = `.env.${name}.local`;
  const encryptedFile = `.env.${name}.encrypted`;

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

async function syncEnvFile(name: string) {
  const localFile = `.env.${name}.local`;
  const encryptedFile = `.env.${name}.encrypted`;

  const localExists = existsSync(localFile);
  const encryptedExists = existsSync(encryptedFile);

  if (!localExists && !encryptedExists) {
    console.error(`Error: Neither ${localFile} nor ${encryptedFile} exists`);
    return;
  }

  if (localExists && !encryptedExists) {
    // Only local exists, encrypt it
    console.log(`${encryptedFile} not found, creating from ${localFile}...`);
    await encryptEnvFile(name);
  } else if (!localExists && encryptedExists) {
    // Only encrypted exists, decrypt it
    console.log(`${localFile} not found, creating from ${encryptedFile}...`);
    await decryptEnvFile(name, false);
  } else {
    // Both exist - sync them
    const localStat = Bun.file(localFile);
    const encryptedStat = Bun.file(encryptedFile);

    const localMtime = (await localStat.stat()).mtime;
    const encryptedMtime = (await encryptedStat.stat()).mtime;

    if (localMtime > encryptedMtime) {
      console.log(`${localFile} is newer, encrypting...`);
      await encryptEnvFile(name);
    } else if (encryptedMtime > localMtime) {
      console.log(`${encryptedFile} is newer, decrypting and merging...`);
      await decryptEnvFile(name, true);
    } else {
      console.log(`${name}: Files are in sync`);
    }
  }
}

async function syncAll() {
  const localFiles = await findEnvFiles(".env.*.local");
  const encryptedFiles = await findEnvFiles(".env.*.encrypted");

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
    await syncEnvFile(name);
  }
}

// Setup yargs CLI
yargs(hideBin(process.argv))
  .scriptName("denvx")
  .usage("$0 <command> [options]")
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
      if (argv.name) {
        await syncEnvFile(argv.name as string);
      } else {
        await syncAll();
      }
    }
  )
  .command(
    "encrypt <name>",
    "Encrypt .env.[name].local to .env.[name].encrypted",
    (yargs) => {
      return yargs.positional("name", {
        describe: "Environment name (e.g., prod, dev)",
        type: "string",
        demandOption: true,
      });
    },
    async (argv) => {
      await encryptEnvFile(argv.name as string);
    }
  )
  .command(
    "decrypt <name>",
    "Decrypt .env.[name].encrypted to .env.[name].local",
    (yargs) => {
      return yargs.positional("name", {
        describe: "Environment name (e.g., prod, dev)",
        type: "string",
        demandOption: true,
      });
    },
    async (argv) => {
      await decryptEnvFile(argv.name as string, false);
    }
  )
  .example("$0 sync", "Sync all .env.*.local files")
  .example("$0 sync prod", "Sync .env.prod.local <=> .env.prod.encrypted")
  .example("$0 encrypt dev", "Encrypt .env.dev.local")
  .example("$0 decrypt dev", "Decrypt .env.dev.encrypted")
  .demandCommand(1, "You need to specify a command")
  .help()
  .alias("h", "help")
  .version()
  .alias("v", "version")
  .parse();
