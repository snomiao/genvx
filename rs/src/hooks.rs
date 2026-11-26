//! `genvx hooks install | uninstall | status | run`: src/hooks.ts.

use std::fs;

use crate::env::{Env, HandBack};
use crate::git;
use crate::js;
use crate::out;
use crate::project;
use crate::sync::{self, exists, fs_error, PullOptions, Stop};

/// Markers around the part of a hook or config file that genvx owns.
const BEGIN: &str = "# >>> genvx auto-sync >>>";
const END: &str = "# <<< genvx auto-sync <<<";

const HOOK_EVENTS: [&str; 2] = ["post-merge", "post-checkout"];

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Local,
    Lefthook,
    Shared,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::Local => "local",
            Mode::Lefthook => "lefthook",
            Mode::Shared => "shared",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Manager {
    None,
    Husky,
    Lefthook,
    Custom,
}

impl Manager {
    pub fn name(self) -> &'static str {
        match self {
            Manager::None => "none",
            Manager::Husky => "husky",
            Manager::Lefthook => "lefthook",
            Manager::Custom => "custom",
        }
    }
}

const NOT_A_REPOSITORY: &str = "Not in a git repository";

// ── git ────────────────────────────────────────────────────────────────────

fn git_config_get(env: &Env, key: &str) -> String {
    let output = git::git(env, &["config", "--get", key]);
    if output.ok() {
        js::trim(&output.stdout).to_string()
    } else {
        String::new()
    }
}

fn rev_parse(env: &Env, what: &str) -> Result<String, String> {
    let output = git::git(env, &["rev-parse", what]);
    if output.ok() {
        Ok(js::trim(&output.stdout).to_string())
    } else {
        Err(NOT_A_REPOSITORY.to_string())
    }
}

fn git_dir_abs(env: &Env) -> Result<String, String> {
    rev_parse(env, "--absolute-git-dir")
}

fn repo_root(env: &Env) -> Result<String, String> {
    rev_parse(env, "--show-toplevel")
}

/// A file inside a directory git reported (absolute, with `/`).
fn inside(dir: &str, name: &str) -> String {
    format!("{}/{name}", dir.trim_end_matches('/'))
}

// ── detection ──────────────────────────────────────────────────────────────

/// `detectHookManager()`
fn detect(env: &Env) -> Result<(Manager, String), String> {
    let hooks_path = git_config_get(env, "core.hooksPath");
    if !hooks_path.is_empty() {
        let manager = if hooks_path.contains(".husky") { Manager::Husky } else { Manager::Custom };
        return Ok((manager, hooks_path));
    }
    let root = repo_root(env)?;
    for name in ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"] {
        if exists(&inside(&root, name)) {
            return Ok((Manager::Lefthook, String::new()));
        }
    }
    Ok((Manager::None, String::new()))
}

/// `recommendMode(manager)`
fn recommend(manager: Manager) -> Mode {
    match manager {
        Manager::Lefthook => Mode::Lefthook,
        Manager::None => Mode::Local,
        Manager::Husky | Manager::Custom => Mode::Shared,
    }
}

// ── the genvx block ────────────────────────────────────────────────────────

/// `stripBlock(content)`
fn strip_block(content: &str) -> String {
    let mut kept = Vec::new();
    let mut in_block = false;
    for line in content.split('\n') {
        if js::trim(line) == BEGIN {
            in_block = true;
        } else if js::trim(line) == END {
            in_block = false;
        } else if !in_block {
            kept.push(line);
        }
    }
    kept.join("\n")
}

/// `hookBlock(event)`
fn hook_block(event: &str) -> String {
    let mut lines = vec![BEGIN.to_string(), "command -v genvx >/dev/null 2>&1 || exit 0".to_string()];
    if event == "post-checkout" {
        lines.push("[ \"$3\" = \"1\" ] || exit 0  # only on branch checkout".to_string());
    }
    lines.push(format!("genvx hooks run {event} || true"));
    lines.push(END.to_string());
    lines.push(String::new());
    lines.join("\n")
}

fn read(path: &str) -> Result<String, String> {
    fs::read(path).map(|bytes| js::utf8(&bytes)).map_err(|err| fs_error(&err, "open", path))
}

fn write(path: &str, content: &str) -> Result<(), String> {
    fs::write(path, content).map_err(|err| fs_error(&err, "open", path))
}

/// `rm(file, { force: true })`
fn remove(path: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(fs_error(&err, "rm", path)),
        _ => Ok(()),
    }
}

/// `writeChainedHook(dir, event)`: adds or renews the block, keeps the rest.
fn write_chained_hook(dir: &str, event: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|err| fs_error(&err, "mkdir", dir))?;
    let file = inside(dir, event);
    let mut content = if exists(&file) { strip_block(&read(&file)?) } else { String::new() };
    if js::trim(&content).is_empty() {
        content = "#!/bin/sh\n".to_string();
    } else if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&hook_block(event));
    write(&file, &content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).map_err(|err| fs_error(&err, "chmod", &file))?;
    }
    Ok(())
}

/// `stripped.replace(/^#!.*$/m, "")`: the first line that starts with `#!`
/// is emptied.
fn without_first_shebang(text: &str) -> String {
    let mut line_start = 0;
    loop {
        let rest = &text[line_start..];
        let line_len = rest.find(js::is_line_terminator).unwrap_or(rest.len());
        if rest.starts_with("#!") {
            return format!("{}{}", &text[..line_start], &rest[line_len..]);
        }
        match rest[line_len..].chars().next() {
            Some(terminator) => line_start += line_len + terminator.len_utf8(),
            None => return text.to_string(),
        }
    }
}

/// `removeChainedHook(dir, event)`: true if the file held a genvx block.
fn remove_chained_hook(dir: &str, event: &str) -> Result<bool, String> {
    let file = inside(dir, event);
    if !exists(&file) {
        return Ok(false);
    }
    let original = read(&file)?;
    if !original.contains(BEGIN) {
        return Ok(false);
    }
    let stripped = strip_block(&original);
    if js::trim(&without_first_shebang(&stripped)).is_empty() {
        remove(&file)?;
    } else {
        write(&file, &stripped)?;
    }
    Ok(true)
}

/// `ensureGitignored(root, entry)`
fn ensure_gitignored(root: &str, entry: &str) -> Result<(), String> {
    let file = inside(root, ".gitignore");
    let mut content = if exists(&file) { read(&file)? } else { String::new() };
    if content.split('\n').any(|line| js::trim(line) == entry) {
        return Ok(());
    }
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(entry);
    content.push('\n');
    write(&file, &content)
}

/// `lefthookBlock()`
fn lefthook_block() -> String {
    [
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
    ]
    .join("\n")
}

/// True if a file called `lefthook` is in any directory of PATH. The
/// TypeScript then runs `lefthook install`, which no parity case covers.
fn lefthook_may_be_installed(env: &Env) -> bool {
    if cfg!(windows) {
        return true;
    }
    let Some(path) = env.get("PATH").filter(|path| !path.is_empty()) else { return true };
    std::env::split_paths(&path).any(|dir| {
        let dir = if dir.as_os_str().is_empty() { std::path::PathBuf::from(".") } else { dir };
        fs::symlink_metadata(dir.join("lefthook")).is_ok()
    })
}

// ── install ────────────────────────────────────────────────────────────────

pub struct Installed {
    pub mode: Mode,
    pub manager: Manager,
    pub files: Vec<String>,
    pub warnings: Vec<String>,
}

/// Everything `installHooks` finds out before it changes anything.
pub struct Plan {
    mode: Mode,
    manager: Manager,
}

/// What `installHooks(mode)` is going to do. `Err(Stop::Fail)` is the error
/// the TypeScript throws while finding out; `Err(Stop::HandBack)` means the
/// installation needs something only the JavaScript does:
///
/// - `shared` mode in a project with a package.json: the TypeScript adds a
///   `prepare` script by rewriting the file through JSON.parse/stringify;
/// - `lefthook` mode when a `lefthook` program is installed: it runs it.
pub fn plan(env: &Env, requested: Option<Mode>) -> Result<Plan, Stop> {
    let (manager, _) = detect(env).map_err(Stop::Fail)?;
    let mode = requested.unwrap_or_else(|| recommend(manager));
    match mode {
        Mode::Local => {}
        Mode::Lefthook => {
            if lefthook_may_be_installed(env) {
                return Err(Stop::HandBack);
            }
        }
        Mode::Shared => {
            if manager != Manager::Husky {
                if let Ok(root) = repo_root(env) {
                    if exists(&inside(&root, "package.json")) {
                        return Err(Stop::HandBack);
                    }
                }
            }
        }
    }
    Ok(Plan { mode, manager })
}

/// `installHooks(mode)`, the part that writes.
pub fn install(env: &Env, plan: &Plan) -> Result<Installed, String> {
    let Plan { mode, manager } = *plan;
    let mut warnings = Vec::new();
    let mut files = Vec::new();
    match mode {
        Mode::Local => {
            if manager != Manager::None {
                warnings.push(format!(
                    "core.hooksPath is managed by {}; hooks in .git/hooks may be ignored. Consider: genvx hooks install --mode={}",
                    manager.name(),
                    recommend(manager).name()
                ));
            }
            let dir = inside(&git_dir_abs(env)?, "hooks");
            for event in HOOK_EVENTS {
                write_chained_hook(&dir, event)?;
                files.push(format!(".git/hooks/{event}"));
            }
        }
        Mode::Lefthook => {
            let root = repo_root(env)?;
            let file = inside(&root, "lefthook-local.yml");
            let mut content = if exists(&file) { strip_block(&read(&file)?) } else { String::new() };
            if !content.is_empty() && !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(&lefthook_block());
            write(&file, &content)?;
            ensure_gitignored(&root, "lefthook-local.yml")?;
            // `lefthook install` would run here; `plan` made sure there is none.
            files.push("lefthook-local.yml".to_string());
        }
        Mode::Shared => {
            let root = repo_root(env)?;
            let base = if manager == Manager::Husky { ".husky" } else { ".githooks" };
            let dir = inside(&root, base);
            for event in HOOK_EVENTS {
                write_chained_hook(&dir, event)?;
                files.push(format!("{base}/{event}"));
            }
            if base == ".githooks" {
                git::git(env, &["config", "core.hooksPath", ".githooks"]);
                // addPrepareScript(root): only acts on a package.json, and
                // `plan` made sure there is none.
            }
        }
    }
    Ok(Installed { mode, manager, files, warnings })
}

/// `genvx hooks install [--mode=...]`
pub fn cmd_install(env: &Env, requested: Option<Mode>) -> Result<(), Stop> {
    let plan = plan(env, requested)?;
    let done = install(env, &plan).map_err(Stop::Fail)?;
    let manager = if done.manager != Manager::None { format!(", manager: {}", done.manager.name()) } else { String::new() };
    out::log(&format!("\u{2705} Installed genvx auto-sync hooks (mode: {}{manager})", done.mode.name()));
    for file in &done.files {
        out::log(&format!("   {file}"));
    }
    for warning in &done.warnings {
        out::log(&format!("\u{26a0}\u{fe0f}  {warning}"));
    }
    Ok(())
}

// ── uninstall ──────────────────────────────────────────────────────────────

/// `genvx hooks uninstall`
pub fn cmd_uninstall(env: &Env) -> Result<(), Stop> {
    let removed = uninstall(env).map_err(Stop::Fail)?;
    if removed.is_empty() {
        out::log("No genvx hooks found.");
    } else {
        out::log("\u{2705} Removed genvx hooks:");
        for file in &removed {
            out::log(&format!("   {file}"));
        }
    }
    Ok(())
}

/// `uninstallHooks()`
fn uninstall(env: &Env) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    let root = repo_root(env)?;
    let git_dir = git_dir_abs(env)?;

    for event in HOOK_EVENTS {
        if remove_chained_hook(&inside(&git_dir, "hooks"), event)? {
            removed.push(format!(".git/hooks/{event}"));
        }
    }
    for base in [".husky", ".githooks"] {
        for event in HOOK_EVENTS {
            if remove_chained_hook(&inside(&root, base), event)? {
                removed.push(format!("{base}/{event}"));
            }
        }
    }

    let lefthook = inside(&root, "lefthook-local.yml");
    if exists(&lefthook) {
        let original = read(&lefthook)?;
        if original.contains(BEGIN) {
            let stripped = strip_block(&original);
            if js::trim(&stripped).is_empty() {
                remove(&lefthook)?;
                removed.push("lefthook-local.yml".to_string());
            } else {
                write(&lefthook, &stripped)?;
                removed.push("lefthook-local.yml (block)".to_string());
            }
        }
    }
    Ok(removed)
}

// ── status ─────────────────────────────────────────────────────────────────

/// `genvx hooks status`
pub fn cmd_status(env: &Env) -> Result<(), Stop> {
    let (manager, hooks_path) = detect(env).map_err(Stop::Fail)?;
    let root = repo_root(env).map_err(Stop::Fail)?;
    let git_dir = git_dir_abs(env).map_err(Stop::Fail)?;

    let mut installed = Vec::new();
    let mut check = |label: String, file: String| -> Result<(), Stop> {
        if exists(&file) && read(&file).map_err(Stop::Fail)?.contains(BEGIN) {
            installed.push(label);
        }
        Ok(())
    };
    for event in HOOK_EVENTS {
        check(format!(".git/hooks/{event}"), inside(&inside(&git_dir, "hooks"), event))?;
    }
    for base in [".husky", ".githooks"] {
        for event in HOOK_EVENTS {
            check(format!("{base}/{event}"), inside(&inside(&root, base), event))?;
        }
    }
    check("lefthook-local.yml".to_string(), inside(&root, "lefthook-local.yml"))?;

    let path_note = if hooks_path.is_empty() { String::new() } else { format!(" (core.hooksPath={hooks_path})") };
    out::log(&format!("Hook manager: {}{path_note}", manager.name()));
    out::log(&format!("Recommended mode: {}", recommend(manager).name()));
    if installed.is_empty() {
        out::log("genvx hooks: not installed");
    } else {
        out::log("genvx hooks installed in:");
        for file in &installed {
            out::log(&format!("   {file}"));
        }
    }
    Ok(())
}

// ── run ────────────────────────────────────────────────────────────────────

/// `runHook(event)`: what the installed hooks call. Never fails and prints
/// nothing unless files were written. `Err` only ever means hand back.
pub fn cmd_run(env: &mut Env, event: &str) -> Result<(), HandBack> {
    let cwd = std::env::current_dir().map_err(|_| HandBack)?;
    // Inside a gitstore working copy (git running a hook for genvx's own
    // clone): nothing to do.
    let result = if sync::inside_gitstore_dir(cwd.to_str().ok_or(HandBack)?) { Ok(0) } else { pull_for_hook(env) };
    if let Err(Stop::HandBack) = result {
        return Err(HandBack);
    }
    if let Ok(written) = result {
        if written > 0 {
            out::log(&format!("genvx: synced {written} env file(s) [{event}]"));
        }
    }
    sync::cleanup();
    Ok(())
}

fn pull_for_hook(env: &mut Env) -> Result<usize, Stop> {
    // getGitstoreConfig(): not configured means nothing to do.
    env.load_config()?;
    let Some(gitstore) = env.get("GENVX_STORE").filter(|store| !store.is_empty()) else { return Ok(0) };
    let Ok(remote) = project::git_remote(env) else { return Ok(0) };
    project::only_ascii(&remote)?;
    project::only_ascii(&gitstore)?;
    if project::same_repository(&remote, &gitstore) {
        return Ok(0);
    }
    sync::pull(env, &gitstore, PullOptions { quiet: true, backup: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_is_stripped_by_whole_lines() {
        let text = format!("#!/bin/sh\necho a\n  {BEGIN}  \nmine\n{END}\necho b\n");
        assert_eq!(strip_block(&text), "#!/bin/sh\necho a\necho b\n");
        assert_eq!(strip_block(&format!("a\n{BEGIN}\nlost\n")), "a");
        assert_eq!(strip_block(&format!("echo '{BEGIN}'\n")), format!("echo '{BEGIN}'\n"));
        assert_eq!(strip_block(""), "");
    }

    #[test]
    fn only_the_first_shebang_line_is_emptied() {
        assert_eq!(without_first_shebang("#!/bin/sh\n"), "\n");
        assert_eq!(without_first_shebang("#!/bin/sh"), "");
        assert_eq!(without_first_shebang("\n#!/bin/sh\r\nx"), "\n\r\nx");
        assert_eq!(without_first_shebang("#!/a\n#!/b\n"), "\n#!/b\n");
        assert_eq!(without_first_shebang("echo #!x\n"), "echo #!x\n");
        assert_eq!(without_first_shebang(""), "");
    }

    #[test]
    fn hook_text() {
        assert_eq!(
            hook_block("post-merge"),
            "# >>> genvx auto-sync >>>\ncommand -v genvx >/dev/null 2>&1 || exit 0\ngenvx hooks run post-merge || true\n# <<< genvx auto-sync <<<\n"
        );
        assert!(hook_block("post-checkout").contains("\n[ \"$3\" = \"1\" ] || exit 0  # only on branch checkout\n"));
    }
}
