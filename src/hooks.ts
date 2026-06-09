import { existsSync, readdirSync } from "fs";
import { readFile, writeFile, mkdir, chmod, rm } from "fs/promises";
import { join } from "path";
import {
  getGitstoreConfig,
  getGitRemote,
  isInsideGitstoreDir,
  pullFromGitstore,
  cleanup,
} from "./index.js";

// Markers delimiting the genvx-managed block inside any hook/config file.
const BEGIN = "# >>> genvx auto-sync >>>";
const END = "# <<< genvx auto-sync <<<";

// Git events we hook for auto-pull. post-checkout only fires for branch
// checkouts (handled in the hook body via the $3 flag).
const HOOK_EVENTS = ["post-merge", "post-checkout"] as const;

export type HookMode = "local" | "lefthook" | "shared";
export type HookManager = "none" | "husky" | "lefthook" | "custom";

// --- git helpers -----------------------------------------------------------

async function gitConfigGet(key: string): Promise<string> {
  const r = await Bun.$`git config --get ${key}`.quiet().nothrow();
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

async function gitDirAbs(): Promise<string> {
  const r = await Bun.$`git rev-parse --absolute-git-dir`.quiet().nothrow();
  if (r.exitCode !== 0) throw new Error("Not in a git repository");
  return r.stdout.toString().trim();
}

async function repoRoot(): Promise<string> {
  const r = await Bun.$`git rev-parse --show-toplevel`.quiet().nothrow();
  if (r.exitCode !== 0) throw new Error("Not in a git repository");
  return r.stdout.toString().trim();
}

// --- detection -------------------------------------------------------------

// Detect which hook manager (if any) currently owns this repo's hooks.
export async function detectHookManager(): Promise<{ manager: HookManager; hooksPath: string }> {
  const hooksPath = await gitConfigGet("core.hooksPath");
  if (hooksPath) {
    if (hooksPath.includes(".husky")) return { manager: "husky", hooksPath };
    return { manager: "custom", hooksPath };
  }
  // lefthook does not set core.hooksPath; detect it by its config file.
  const root = await repoRoot();
  for (const f of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) {
    if (existsSync(join(root, f))) return { manager: "lefthook", hooksPath: "" };
  }
  return { manager: "none", hooksPath: "" };
}

// Pick the cleanest "undercover" mode for the detected environment.
export function recommendMode(manager: HookManager): HookMode {
  if (manager === "lefthook") return "lefthook"; // gitignored lefthook-local.yml
  if (manager === "none") return "local"; // native .git/hooks, never committed
  return "shared"; // husky/custom own core.hooksPath — no clean per-repo local-only
}

// --- block (de)composition -------------------------------------------------

// Strip the genvx-managed block from a file's content.
function stripBlock(content: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of content.split("\n")) {
    if (line.trim() === BEGIN) { inBlock = true; continue; }
    if (line.trim() === END) { inBlock = false; continue; }
    if (!inBlock) out.push(line);
  }
  return out.join("\n");
}

// The shell snippet installed into a hook file. Identical everywhere: it
// no-ops when genvx is absent and delegates all logic to `genvx hooks run`.
function hookBlock(event: string): string {
  const lines = [BEGIN, "command -v genvx >/dev/null 2>&1 || exit 0"];
  if (event === "post-checkout") {
    lines.push('[ "$3" = "1" ] || exit 0  # only on branch checkout');
  }
  lines.push(`genvx hooks run ${event} || true`, END, "");
  return lines.join("\n");
}

// Append (or refresh) the genvx block in a hook file, making it executable.
async function writeChainedHook(dir: string, event: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, event);
  let content = existsSync(file) ? await readFile(file, "utf-8") : "";
  content = stripBlock(content);
  if (!content.trim()) content = "#!/bin/sh\n";
  else if (!content.endsWith("\n")) content += "\n";
  content += hookBlock(event);
  await writeFile(file, content);
  await chmod(file, 0o755);
}

// Remove the genvx block from a hook file; delete the file if nothing but a
// shebang remains. Returns true if the file contained a genvx block.
async function removeChainedHook(dir: string, event: string): Promise<boolean> {
  const file = join(dir, event);
  if (!existsSync(file)) return false;
  const orig = await readFile(file, "utf-8");
  if (!orig.includes(BEGIN)) return false;
  const stripped = stripBlock(orig);
  const meaningful = stripped.replace(/^#!.*$/m, "").trim();
  if (meaningful === "") await rm(file, { force: true });
  else await writeFile(file, stripped);
  return true;
}

// --- gitignore helper ------------------------------------------------------

async function ensureGitignored(root: string, entry: string): Promise<void> {
  const gi = join(root, ".gitignore");
  let content = existsSync(gi) ? await readFile(gi, "utf-8") : "";
  if (content.split("\n").map((l) => l.trim()).includes(entry)) return;
  if (content && !content.endsWith("\n")) content += "\n";
  await writeFile(gi, content + `${entry}\n`);
}

// --- per-mode installers ---------------------------------------------------

// local: native .git/hooks — never committed, true undercover.
async function installLocal(): Promise<string[]> {
  const dir = join(await gitDirAbs(), "hooks");
  const files: string[] = [];
  for (const e of HOOK_EVENTS) {
    await writeChainedHook(dir, e);
    files.push(`.git/hooks/${e}`);
  }
  return files;
}

// lefthook: gitignored lefthook-local.yml — undercover for lefthook users.
function lefthookBlock(): string {
  return [
    BEGIN,
    "post-merge:",
    "  commands:",
    "    genvx-pull:",
    "      run: genvx hooks run post-merge",
    "post-checkout:",
    "  commands:",
    "    genvx-pull:",
    "      run: genvx hooks run post-checkout",
    END,
    "",
  ].join("\n");
}

async function installLefthook(): Promise<string[]> {
  const root = await repoRoot();
  const file = join(root, "lefthook-local.yml");
  let content = existsSync(file) ? await readFile(file, "utf-8") : "";
  content = stripBlock(content);
  if (content && !content.endsWith("\n")) content += "\n";
  await writeFile(file, content + lefthookBlock());
  await ensureGitignored(root, "lefthook-local.yml");
  await Bun.$`lefthook install`.quiet().nothrow(); // regenerate wrappers (best-effort)
  return ["lefthook-local.yml"];
}

// shared: committed hooks for the whole team.
async function addPrepareScript(root: string): Promise<void> {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    pkg.scripts ??= {};
    if (!pkg.scripts.prepare) {
      pkg.scripts.prepare = "git config core.hooksPath .githooks";
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  } catch { /* leave package.json untouched on parse error */ }
}

async function installShared(manager: HookManager): Promise<string[]> {
  const root = await repoRoot();
  // Reuse an existing husky setup if present, else use a tracked .githooks dir.
  const base = manager === "husky" ? ".husky" : ".githooks";
  const dir = join(root, base);
  const files: string[] = [];
  for (const e of HOOK_EVENTS) {
    await writeChainedHook(dir, e);
    files.push(`${base}/${e}`);
  }
  if (base === ".githooks") {
    await Bun.$`git config core.hooksPath .githooks`.quiet().nothrow();
    await addPrepareScript(root);
  }
  return files;
}

// --- public API ------------------------------------------------------------

export interface InstallResult {
  mode: HookMode;
  manager: HookManager;
  files: string[];
  warnings: string[];
}

export async function installHooks(modeArg: "auto" | HookMode = "auto"): Promise<InstallResult> {
  const { manager } = await detectHookManager();
  const mode: HookMode = modeArg === "auto" ? recommendMode(manager) : modeArg;
  const warnings: string[] = [];
  let files: string[];

  if (mode === "local") {
    if (manager !== "none") {
      warnings.push(
        `core.hooksPath is managed by ${manager}; hooks in .git/hooks may be ignored. ` +
        `Consider: genvx hooks install --mode=${recommendMode(manager)}`,
      );
    }
    files = await installLocal();
  } else if (mode === "lefthook") {
    files = await installLefthook();
  } else {
    files = await installShared(manager);
  }

  return { mode, manager, files, warnings };
}

export async function uninstallHooks(): Promise<string[]> {
  const removed: string[] = [];
  const root = await repoRoot();
  const gitDir = await gitDirAbs();

  for (const e of HOOK_EVENTS) {
    if (await removeChainedHook(join(gitDir, "hooks"), e)) removed.push(`.git/hooks/${e}`);
  }
  for (const baseName of [".husky", ".githooks"]) {
    for (const e of HOOK_EVENTS) {
      if (await removeChainedHook(join(root, baseName), e)) removed.push(`${baseName}/${e}`);
    }
  }

  const lf = join(root, "lefthook-local.yml");
  if (existsSync(lf)) {
    const orig = await readFile(lf, "utf-8");
    if (orig.includes(BEGIN)) {
      const stripped = stripBlock(orig);
      if (stripped.trim() === "") {
        await rm(lf, { force: true });
        removed.push("lefthook-local.yml");
      } else {
        await writeFile(lf, stripped);
        removed.push("lefthook-local.yml (block)");
      }
    }
  }

  return removed;
}

export interface HooksStatus {
  manager: HookManager;
  hooksPath: string;
  recommended: HookMode;
  installed: string[];
}

export async function hooksStatus(): Promise<HooksStatus> {
  const { manager, hooksPath } = await detectHookManager();
  const root = await repoRoot();
  const gitDir = await gitDirAbs();
  const installed: string[] = [];

  const check = async (label: string, file: string) => {
    if (existsSync(file) && (await readFile(file, "utf-8")).includes(BEGIN)) installed.push(label);
  };

  for (const e of HOOK_EVENTS) await check(`.git/hooks/${e}`, join(gitDir, "hooks", e));
  for (const baseName of [".husky", ".githooks"]) {
    for (const e of HOOK_EVENTS) await check(`${baseName}/${e}`, join(root, baseName, e));
  }
  await check("lefthook-local.yml", join(root, "lefthook-local.yml"));

  return { manager, hooksPath, recommended: recommendMode(manager), installed };
}

// Invoked by the installed hook files. Fail-soft: must NEVER throw or it would
// break the underlying git operation. No-ops silently when unconfigured.
export async function runHook(event: string): Promise<void> {
  try {
    if (isInsideGitstoreDir(process.cwd())) return;

    const gitstore = await getGitstoreConfig();
    if (!gitstore) return; // genvx not configured for this environment

    let remote: string;
    try {
      remote = await getGitRemote();
    } catch {
      return; // no git remote — nothing to derive a branch from
    }

    const norm = (s: string) => s.replace(/\.git$/, "").toLowerCase();
    if (norm(remote) === norm(gitstore)) return; // never run inside the gitstore repo

    const written = await pullFromGitstore(gitstore, true, true, { quiet: true, backup: true });
    if (written > 0) {
      console.log(`genvx: synced ${written} env file(s) [${event}]`);
    }
  } catch {
    // Swallow everything — a hook must not fail the git command it runs under.
  } finally {
    try {
      await cleanup();
    } catch { /* ignore */ }
  }
}
