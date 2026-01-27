import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  cleanup,
  getGenvxDir,
  getProjectPath,
  syncWithGitstore,
} from "./cli";

process.env.GIT_AUTHOR_NAME ??= "genvx";
process.env.GIT_AUTHOR_EMAIL ??= "genvx@example.com";
process.env.GIT_COMMITTER_NAME ??= "genvx";
process.env.GIT_COMMITTER_EMAIL ??= "genvx@example.com";

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

const directions = ["local", "remote"] as const;
const crudOps = ["create", "read", "update", "delete"] as const;

describe("sync matrix: direction x CRUD", () => {
  test("sync covers all CRUD directions in both temp dirs", async () => {
    for (const withNodeModules of [true, false]) {
      for (const direction of directions) {
        for (const operation of crudOps) {
          const { root, repoDir, gitstoreDir } = await setupRepo(withNodeModules);
          const previousCwd = process.cwd();
          process.chdir(repoDir);

          try {
            const gitstoreUrl = gitstoreDir;
            const expectedDir = withNodeModules ? "./node_modules/.genvx" : "./.genvx";
            const localEnvPath = join(repoDir, ".env");
            const localEnvLocalPath = join(repoDir, ".env.local");

            await writeFile(localEnvPath, "A=1\n");
            await writeFile(localEnvLocalPath, "B=1\n");
            await syncWithGitstore(gitstoreUrl);

            expect(getGenvxDir()).toBe(expectedDir);

            const gitstorePath = join(getGenvxDir(), "gitstore");
            const projectPath = await getProjectPath(gitstorePath);
            const remoteEnvPath = join(projectPath, ".env");
            const remoteEnvLocalPath = join(projectPath, ".env.local");

            if (direction === "local") {
              if (operation === "create") {
                await writeFile(join(repoDir, ".env.new"), "N=1\n");
                await syncWithGitstore(gitstoreUrl);
                expect(existsSync(join(projectPath, ".env.new"))).toBe(true);
              } else if (operation === "read") {
                await syncWithGitstore(gitstoreUrl);
                expect(await readFile(remoteEnvPath, "utf-8")).toBe("A=1\n");
              } else if (operation === "update") {
                await writeFile(localEnvLocalPath, "B=2\n");
                await syncWithGitstore(gitstoreUrl);
                expect(await readFile(remoteEnvLocalPath, "utf-8")).toBe("B=2\n");
              } else if (operation === "delete") {
                await unlink(localEnvLocalPath);
                await syncWithGitstore(gitstoreUrl);
                expect(existsSync(remoteEnvLocalPath)).toBe(false);
              }
            } else {
              if (operation === "create") {
                await writeFile(join(projectPath, ".env.remote"), "R=1\n");
                await syncWithGitstore(gitstoreUrl);
                expect(existsSync(join(projectPath, ".env.remote"))).toBe(false);
                expect(existsSync(join(repoDir, ".env.remote"))).toBe(false);
              } else if (operation === "read") {
                await syncWithGitstore(gitstoreUrl);
                expect(await readFile(remoteEnvPath, "utf-8")).toBe("A=1\n");
                expect(await readFile(localEnvPath, "utf-8")).toBe("A=1\n");
              } else if (operation === "update") {
                await writeFile(remoteEnvLocalPath, "B=99\n");
                await syncWithGitstore(gitstoreUrl);
                expect(await readFile(remoteEnvLocalPath, "utf-8")).toBe("B=1\n");
                expect(await readFile(localEnvLocalPath, "utf-8")).toBe("B=1\n");
              } else if (operation === "delete") {
                await unlink(remoteEnvLocalPath);
                await syncWithGitstore(gitstoreUrl);
                expect(await readFile(remoteEnvLocalPath, "utf-8")).toBe("B=1\n");
                expect(await readFile(localEnvLocalPath, "utf-8")).toBe("B=1\n");
              }
            }
          } finally {
            await cleanup();
            process.chdir(previousCwd);
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    }
  }, 90000);
});
