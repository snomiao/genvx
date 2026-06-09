import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  detectHookManager,
  recommendMode,
  installHooks,
  uninstallHooks,
  hooksStatus,
} from "./hooks.js";

function runGit(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "genvx-hooks-"));
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["remote", "add", "origin", "https://github.com/acme/demo.git"]);
  return dir;
}

// Run fn with process.cwd() temporarily set to dir.
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

describe("hook manager detection", () => {
  test("plain repo → manager none, recommends local", async () => {
    const dir = await makeRepo();
    try {
      await inDir(dir, async () => {
        const { manager } = await detectHookManager();
        expect(manager).toBe("none");
        expect(recommendMode(manager)).toBe("local");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lefthook.yml present → manager lefthook, recommends lefthook", async () => {
    const dir = await makeRepo();
    try {
      await writeFile(join(dir, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
      await inDir(dir, async () => {
        const { manager } = await detectHookManager();
        expect(manager).toBe("lefthook");
        expect(recommendMode(manager)).toBe("lefthook");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("husky core.hooksPath → manager husky, recommends shared", async () => {
    const dir = await makeRepo();
    try {
      runGit(dir, ["config", "core.hooksPath", ".husky/_"]);
      await inDir(dir, async () => {
        const { manager } = await detectHookManager();
        expect(manager).toBe("husky");
        expect(recommendMode(manager)).toBe("shared");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local mode install/uninstall", () => {
  test("auto installs into .git/hooks, executable, idempotent, then removes cleanly", async () => {
    const dir = await makeRepo();
    try {
      await inDir(dir, async () => {
        const r = await installHooks("auto");
        expect(r.mode).toBe("local");
        expect(r.warnings).toEqual([]);

        const pm = join(dir, ".git/hooks/post-merge");
        const pc = join(dir, ".git/hooks/post-checkout");
        expect(existsSync(pm)).toBe(true);
        expect(existsSync(pc)).toBe(true);

        const body = await readFile(pm, "utf-8");
        expect(body).toContain("genvx hooks run post-merge");
        expect(body).toContain("command -v genvx");
        // post-checkout guards against file checkouts
        expect(await readFile(pc, "utf-8")).toContain('[ "$3" = "1" ]');

        // executable
        if (process.platform !== "win32") {
          expect(statSync(pm).mode & 0o100).toBe(0o100);
        }

        // idempotent — re-install must not duplicate the block
        await installHooks("auto");
        const reBody = await readFile(pm, "utf-8");
        const occurrences = reBody.split("genvx hooks run post-merge").length - 1;
        expect(occurrences).toBe(1);

        const status = await hooksStatus();
        expect(status.installed).toContain(".git/hooks/post-merge");
        expect(status.installed).toContain(".git/hooks/post-checkout");

        const removed = await uninstallHooks();
        expect(removed).toContain(".git/hooks/post-merge");
        // file removed since only a shebang remained
        expect(existsSync(pm)).toBe(false);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves a pre-existing user hook when chaining and unchaining", async () => {
    const dir = await makeRepo();
    try {
      const pm = join(dir, ".git/hooks/post-merge");
      await mkdir(join(dir, ".git/hooks"), { recursive: true });
      await writeFile(pm, "#!/bin/sh\necho user-hook\n");

      await inDir(dir, async () => {
        await installHooks("local");
        const body = await readFile(pm, "utf-8");
        expect(body).toContain("echo user-hook");
        expect(body).toContain("genvx hooks run post-merge");

        await uninstallHooks();
        const after = await readFile(pm, "utf-8");
        expect(after).toContain("echo user-hook");
        expect(after).not.toContain("genvx hooks run");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("local mode warns when core.hooksPath is hijacked", async () => {
    const dir = await makeRepo();
    try {
      runGit(dir, ["config", "core.hooksPath", ".husky/_"]);
      await inDir(dir, async () => {
        const r = await installHooks("local");
        expect(r.warnings.length).toBeGreaterThan(0);
        expect(r.warnings[0]).toContain("husky");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("lefthook mode install/uninstall", () => {
  test("writes gitignored lefthook-local.yml and removes it", async () => {
    const dir = await makeRepo();
    try {
      await writeFile(join(dir, "lefthook.yml"), "pre-commit:\n  commands: {}\n");
      await inDir(dir, async () => {
        const r = await installHooks("auto");
        expect(r.mode).toBe("lefthook");

        const lf = join(dir, "lefthook-local.yml");
        expect(existsSync(lf)).toBe(true);
        const body = await readFile(lf, "utf-8");
        expect(body).toContain("genvx hooks run post-merge");

        // gitignored
        const gi = await readFile(join(dir, ".gitignore"), "utf-8");
        expect(gi).toContain("lefthook-local.yml");

        await uninstallHooks();
        expect(existsSync(lf)).toBe(false);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("shared mode install", () => {
  test("creates committed .githooks + sets core.hooksPath + prepare script", async () => {
    const dir = await makeRepo();
    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo" }) + "\n");
      await inDir(dir, async () => {
        const r = await installHooks("shared");
        expect(r.mode).toBe("shared");
        expect(existsSync(join(dir, ".githooks/post-merge"))).toBe(true);

        const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
        expect(pkg.scripts.prepare).toContain("core.hooksPath .githooks");

        const cfg = Bun.spawnSync({ cmd: ["git", "config", "--get", "core.hooksPath"], cwd: dir });
        expect(new TextDecoder().decode(cfg.stdout).trim()).toBe(".githooks");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
