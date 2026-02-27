import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  cleanup,
  getGenvxDir,
  getProjectPath,
  pullFromGitstore,
  pushToGitstore,
  decrypt,
  getProjectId,
  parseGitRemote,
} from "./index.js";

process.env.GIT_AUTHOR_NAME ??= "genvx";
process.env.GIT_AUTHOR_EMAIL ??= "genvx@example.com";
process.env.GIT_COMMITTER_NAME ??= "genvx";
process.env.GIT_COMMITTER_EMAIL ??= "genvx@example.com";
// Set encryption key for tests
process.env.GENVX_KEY = "test-encryption-key-for-genvx-tests";

function runGit(cwd: string, args: string[]) {
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
}

async function setupRepo(withNodeModules: boolean) {
  const root = await mkdtemp(join(tmpdir(), "genvx-test-"));
  const repoDir = join(root, "repo");
  const gitstoreDir = join(root, "gitstore");

  await mkdir(repoDir, { recursive: true });
  await mkdir(gitstoreDir, { recursive: true });

  runGit(repoDir, ["init", "-q"]);
  runGit(repoDir, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  runGit(gitstoreDir, ["init", "--bare", "-q"]);

  if (withNodeModules) {
    await mkdir(join(repoDir, "node_modules"), { recursive: true });
  }

  return { root, repoDir, gitstoreDir };
}

describe("push/pull behavior in both temp dirs", () => {
  test("push saves and updates without deleting remote", async () => {
    for (const withNodeModules of [true, false]) {
      const { root, repoDir, gitstoreDir } = await setupRepo(withNodeModules);
      const previousCwd = process.cwd();
      process.chdir(repoDir);

      try {
        const gitstoreUrl = gitstoreDir;
        const expectedDir = withNodeModules ? "./node_modules/.genvx" : "./.genvx";
        const projectId = getProjectId("https://github.com/acme/demo.git");
        const encryptionKey = process.env.GENVX_KEY!;

        await writeFile(join(repoDir, ".env"), "A=1\n");
        await writeFile(join(repoDir, ".env.local"), "B=1\n");
        await pushToGitstore(gitstoreUrl);

        expect(getGenvxDir()).toBe(expectedDir);

        const gitstorePath = join(getGenvxDir(), "gitstore");
        const projectPath = getProjectPath(gitstorePath);
        // Files are now encrypted with .enc suffix
        const remoteEnvPath = join(projectPath, ".env.enc");
        const remoteEnvLocalPath = join(projectPath, ".env.local.enc");

        // Decrypt and verify content
        const encEnv = await readFile(remoteEnvPath, "utf-8");
        const encEnvLocal = await readFile(remoteEnvLocalPath, "utf-8");
        expect(decrypt(encEnv, encryptionKey, projectId)).toBe("A=1\n");
        expect(decrypt(encEnvLocal, encryptionKey, projectId)).toBe("B=1\n");

        await writeFile(join(repoDir, ".env.local"), "B=2\n");
        await pushToGitstore(gitstoreUrl);
        const encEnvLocal2 = await readFile(remoteEnvLocalPath, "utf-8");
        expect(decrypt(encEnvLocal2, encryptionKey, projectId)).toBe("B=2\n");

        await unlink(join(repoDir, ".env.local"));
        await pushToGitstore(gitstoreUrl);
        // Remote should still have the file (deletes don't propagate)
        const encEnvLocal3 = await readFile(remoteEnvLocalPath, "utf-8");
        expect(decrypt(encEnvLocal3, encryptionKey, projectId)).toBe("B=2\n");
      } finally {
        await cleanup();
        process.chdir(previousCwd);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30000);

  test("pull loads and updates without deleting local", async () => {
    for (const withNodeModules of [true, false]) {
      const { root, repoDir, gitstoreDir } = await setupRepo(withNodeModules);
      const previousCwd = process.cwd();
      process.chdir(repoDir);

      try {
        const gitstoreUrl = gitstoreDir;
        const projectId = getProjectId("https://github.com/acme/demo.git");
        const encryptionKey = process.env.GENVX_KEY!;
        const { encrypt } = await import("./index.js");

        await writeFile(join(repoDir, ".env"), "A=1\n");
        await writeFile(join(repoDir, ".env.local"), "B=1\n");
        await pushToGitstore(gitstoreUrl);

        await unlink(join(repoDir, ".env"));
        await unlink(join(repoDir, ".env.local"));

        await pullFromGitstore(gitstoreUrl);
        expect(await readFile(join(repoDir, ".env"), "utf-8")).toBe("A=1\n");
        expect(await readFile(join(repoDir, ".env.local"), "utf-8")).toBe("B=1\n");

        // Modify remote encrypted file directly
        const gitstorePath = join(getGenvxDir(), "gitstore");
        const projectPath = getProjectPath(gitstorePath);
        const encryptedContent = encrypt("B=3\n", encryptionKey, projectId);
        await writeFile(join(projectPath, ".env.local.enc"), encryptedContent);
        await pullFromGitstore(gitstoreUrl);
        expect(await readFile(join(repoDir, ".env.local"), "utf-8")).toBe("B=3\n");

        // Remote delete shouldn't affect local
        await unlink(join(projectPath, ".env.local.enc"));
        await pullFromGitstore(gitstoreUrl);
        expect(await readFile(join(repoDir, ".env.local"), "utf-8")).toBe("B=3\n");
      } finally {
        await cleanup();
        process.chdir(previousCwd);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30000);
});

describe("sync behavior in both temp dirs", () => {
  test("sync is pull then push", async () => {
    for (const withNodeModules of [true, false]) {
      const { root, repoDir, gitstoreDir } = await setupRepo(withNodeModules);
      const previousCwd = process.cwd();
      process.chdir(repoDir);

      try {
        const gitstoreUrl = gitstoreDir;
        const projectId = getProjectId("https://github.com/acme/demo.git");
        const encryptionKey = process.env.GENVX_KEY!;

        await writeFile(join(repoDir, ".env"), "A=1\n");
        await pushToGitstore(gitstoreUrl);

        await unlink(join(repoDir, ".env"));
        await pullFromGitstore(gitstoreUrl);
        expect(await readFile(join(repoDir, ".env"), "utf-8")).toBe("A=1\n");

        await writeFile(join(repoDir, ".env"), "A=2\n");
        await pullFromGitstore(gitstoreUrl);
        expect(await readFile(join(repoDir, ".env"), "utf-8")).toBe("A=1\n");

        await writeFile(join(repoDir, ".env"), "A=2\n");
        await pushToGitstore(gitstoreUrl);

        const gitstorePath = join(getGenvxDir(), "gitstore");
        const projectPath = getProjectPath(gitstorePath);
        // File is encrypted
        const encEnv = await readFile(join(projectPath, ".env.enc"), "utf-8");
        expect(decrypt(encEnv, encryptionKey, projectId)).toBe("A=2\n");
      } finally {
        await cleanup();
        process.chdir(previousCwd);
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 30000);
});
