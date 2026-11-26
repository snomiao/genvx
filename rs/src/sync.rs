//! push, pull and diff: src/index.ts from `syncGitstore` to `cleanup`, in the
//! same order, with the same output.

use std::fs;
use std::io::ErrorKind;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::crypto::{self, Keys};
use crate::env::{Env, HandBack};
use crate::git;
use crate::js;
use crate::out;
use crate::project;

const SEP: char = std::path::MAIN_SEPARATOR;

/// Why a command stops early.
pub enum Stop {
    /// An error the TypeScript throws; the text after `Error: `.
    Fail(String),
    /// Not handled here (see `HandBack`).
    HandBack,
}

impl From<HandBack> for Stop {
    fn from(_: HandBack) -> Stop {
        Stop::HandBack
    }
}

pub type Run<T> = Result<T, Stop>;

fn fail<T>(message: impl Into<String>) -> Run<T> {
    Err(Stop::Fail(message.into()))
}

// ── paths and files ────────────────────────────────────────────────────────

/// `path.join(a, b)` for the paths that occur here (relative, already tidy).
pub fn join(a: &str, b: &str) -> String {
    if a.is_empty() || a == "." {
        b.to_string()
    } else {
        format!("{a}{SEP}{b}")
    }
}

/// `path.dirname(p)`
fn dirname(path: &str) -> &str {
    match path.rfind(SEP) {
        None => ".",
        Some(0) => &path[..1],
        Some(at) => &path[..at],
    }
}

/// `existsSync(path)`
pub fn exists(path: &str) -> bool {
    fs::metadata(path).is_ok()
}

/// The text of a file system error as bun words it: `ENOENT: no such file or
/// directory, open '<path>'`. Only the ENOENT form is covered by a parity
/// case; the others follow the same pattern and are not.
pub fn fs_error(err: &std::io::Error, syscall: &str, path: &str) -> String {
    let (code, text) = match (err.kind(), err.raw_os_error()) {
        (ErrorKind::NotFound, _) => ("ENOENT", "no such file or directory"),
        (_, Some(1)) => ("EPERM", "operation not permitted"),
        (ErrorKind::PermissionDenied, _) => ("EACCES", "permission denied"),
        (ErrorKind::AlreadyExists, _) => ("EEXIST", "file already exists"),
        (ErrorKind::IsADirectory, _) => return "EISDIR: illegal operation on a directory, read".to_string(),
        (ErrorKind::NotADirectory, _) => ("ENOTDIR", "not a directory"),
        (ErrorKind::DirectoryNotEmpty, _) => ("ENOTEMPTY", "directory not empty"),
        (ErrorKind::ReadOnlyFilesystem, _) => ("EROFS", "read-only file system"),
        (ErrorKind::StorageFull, _) => ("ENOSPC", "no space left on device"),
        _ => return err.to_string(),
    };
    format!("{code}: {text}, {syscall} '{path}'")
}

/// `await readFile(path, "utf-8")`
fn read_text(path: &str) -> Run<String> {
    match fs::read(path) {
        Ok(bytes) => Ok(js::utf8(&bytes)),
        Err(err) => fail(fs_error(&err, "open", path)),
    }
}

/// `ensureDir(dirPath)`
fn ensure_dir(dir: &str) -> Run<()> {
    if dir != "." && !exists(dir) {
        if let Err(err) = fs::create_dir_all(dir) {
            return fail(fs_error(&err, "mkdir", dir));
        }
    }
    Ok(())
}

/// `ensureSecurePermissions(filePath)`: chmod 600; on Windows a failure is ignored.
fn secure_permissions(path: &str) -> Run<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
            return fail(format!(
                "Failed to set secure permissions (600) on {path}: Error: {}",
                fs_error(&err, "chmod", path)
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// `copyFile(from, to)`
fn copy_file(from: &str, to: &str) -> Run<()> {
    match fs::copy(from, to) {
        Ok(_) => Ok(()),
        Err(err) => fail(fs_error(&err, "copyfile", from)),
    }
}

/// `rm(path, { recursive: true, force: true })`
fn remove_all(path: &str) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

/// `getGenvxDir()`, in the form `path.join` leaves it.
pub fn genvx_dir() -> String {
    if exists("node_modules") {
        join("node_modules", ".genvx")
    } else {
        ".genvx".to_string()
    }
}

/// `isInsideGitstoreDir(cwd)`
pub fn inside_gitstore_dir(cwd: &str) -> bool {
    cwd.contains(&format!("{SEP}.genvx{SEP}gitstore"))
}

/// `cleanup()`: removes the working directory, keeping earlier backups.
pub fn cleanup() {
    let dir = genvx_dir();
    if !exists(&dir) {
        return;
    }
    if exists(&join(&dir, "backups")) {
        let Some(names) = dir_entries(&dir) else { return };
        for name in names {
            if name == "backups" || name == ".gitignore" {
                continue;
            }
            if remove_all(&join(&dir, &name)).is_err() {
                return;
            }
        }
    } else {
        let _ = remove_all(&dir);
    }
}

/// `readdirSync(dir)`: the names in the order the system gives them, which
/// is the order files are then listed and processed in. `None` if the
/// directory cannot be read. Names that are not UTF-8 are left out.
fn dir_entries(dir: &str) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).ok()? {
        if let Ok(name) = entry.ok()?.file_name().into_string() {
            names.push(name);
        }
    }
    Some(names)
}

const SKIP_DIRS: [&str; 16] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "target",
    "vendor",
    ".genvx",
];

/// `findEnvFiles(".env*", searchPath)`: every file whose name starts with
/// `.env`, in every directory that is not skipped and not a git repository
/// of its own.
pub fn find_env_files(search_path: &str) -> Vec<String> {
    fn search(dir: &str, relative: &str, results: &mut Vec<String>) {
        let Some(names) = dir_entries(dir) else { return };
        for name in names {
            let full = join(dir, &name);
            let rel = join(relative, &name);
            let Ok(meta) = fs::metadata(&full) else { continue };
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) && !exists(&join(&full, ".git")) {
                    search(&full, &rel, results);
                }
            } else if meta.is_file() && name.starts_with(".env") && !name[4..].contains(js::is_line_terminator) {
                // /^\.env.*$/
                results.push(rel);
            }
        }
    }
    let mut results = Vec::new();
    search(search_path, "", &mut results);
    results
}

// ── env var listing ────────────────────────────────────────────────────────

/// `parseEnvVars(content)`: a Map, so a repeated key keeps its first place
/// and takes its last value.
fn parse_env_vars(content: &str) -> Vec<(&str, &str)> {
    let mut vars: Vec<(&str, &str)> = Vec::new();
    for line in content.split('\n') {
        let trimmed = js::trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else { continue };
        let key = js::trim(&trimmed[..eq]);
        let value = &trimmed[eq + 1..];
        if key.is_empty() {
            continue;
        }
        match vars.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = value,
            None => vars.push((key, value)),
        }
    }
    vars
}

/// `diffEnvVars` and `formatEnvVarChange` in one: the lines to print.
fn env_var_changes(old_content: &str, new_content: &str) -> Vec<String> {
    let old = parse_env_vars(old_content);
    let new = parse_env_vars(new_content);
    let mut lines = Vec::new();
    for (key, value) in &new {
        match old.iter().find(|(k, _)| k == key) {
            None => lines.push(format!("  + {key}")),
            Some((_, old_value)) if old_value != value => lines.push(format!("  + {key} (Updated)")),
            Some(_) => {}
        }
    }
    for (key, _) in &old {
        if !new.iter().any(|(k, _)| k == key) {
            lines.push(format!("  - {key}"));
        }
    }
    lines
}

// ── the gitstore working copy ──────────────────────────────────────────────

/// `` await Bun.$`...`.quiet() ``: a failing command throws.
fn must(output: git::Output) -> Run<()> {
    if output.ok() {
        Ok(())
    } else {
        fail(format!("Failed with exit code {}", output.code))
    }
}

/// `syncGitstore(gitstoreUrl, branch)`: clone the project's branch, start it
/// if the store has none, or update a copy left by an earlier run.
fn sync_gitstore(env: &Env, url: &str, branch: &str) -> Run<String> {
    // setupGenvxDir()
    let dir = genvx_dir();
    ensure_dir(&dir)?;
    let gitignore = join(&dir, ".gitignore");
    if !exists(&gitignore) {
        if let Err(err) = fs::write(&gitignore, "*\n") {
            return fail(fs_error(&err, "open", &gitignore));
        }
    }

    let path = join(&dir, "gitstore");
    if !exists(&path) {
        let clone = git::git(env, &["clone", "--single-branch", "--depth", "1", "-b", branch, "-q", url, &path]);
        if !clone.ok() {
            if let Err(err) = fs::create_dir_all(&path) {
                return fail(fs_error(&err, "mkdir", &path));
            }
            must(git::git(env, &["-C", &path, "init", "-q"]))?;
            must(git::git(env, &["-C", &path, "remote", "add", "origin", url]))?;
            must(git::git(env, &["-C", &path, "checkout", "--orphan", branch]))?;
            must(git::git(env, &["-C", &path, "commit", "--allow-empty", "-m", "Initialize env branch", "-q"]))?;
        }
    } else {
        git::git(env, &["-C", &path, "pull", "origin", branch]);
    }
    Ok(path)
}

// ── change detection and display ───────────────────────────────────────────

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Pull,
    Push,
}

struct Pair {
    local: String,
    remote: String,
}

struct Change {
    /// status "+" (the destination has no such file) rather than "M"
    is_new: bool,
    file: String,
}

/// What the command works with once the project and the key are known.
struct Session {
    project_id: String,
    /// `encryptionKey`: always present here, because every invocation the
    /// Rust binary takes has encryption on.
    keys: Option<Keys>,
}

impl Session {
    fn decrypt(&mut self, raw: &str) -> Result<String, crypto::Undecryptable> {
        let keys = self.keys.as_mut().expect("decrypt is only called with a key");
        crypto::decrypt(raw, keys, &self.project_id)
    }
}

/// `detectChanges(...)`. The TypeScript also counts changed lines with
/// `git diff --numstat` for every modified file and never shows the result;
/// that subprocess is left out.
fn detect_changes(session: &mut Session, project_path: &str, pairs: &[Pair], direction: Direction) -> Run<Vec<Change>> {
    let mut changes = Vec::new();
    for pair in pairs {
        let remote_path = join(project_path, &pair.remote);
        let local_exists = exists(&pair.local);
        let remote_exists = exists(&remote_path);

        let remote_content = if remote_exists {
            let raw = read_text(&remote_path)?;
            if session.keys.is_some() && pair.remote.ends_with(".enc") {
                match session.decrypt(&raw) {
                    Ok(text) => Some(text),
                    Err(_) => return fail(format!("Failed to decrypt {}. Wrong GENVX_KEY?", pair.remote)),
                }
            } else {
                Some(raw)
            }
        } else {
            None
        };
        let local_content = if local_exists { Some(read_text(&pair.local)?) } else { None };

        let (source, dest) = match direction {
            Direction::Push => (local_content, remote_content),
            Direction::Pull => (remote_content, local_content),
        };
        let Some(source) = source else { continue };
        if dest.as_ref() == Some(&source) {
            continue;
        }
        changes.push(Change { is_new: dest.is_none(), file: pair.local.clone() });
    }
    Ok(changes)
}

/// `displayChanges(...)`: which variables each file adds, updates or removes.
fn display_changes(session: &mut Session, changes: &[Change], project_path: &str, direction: Direction, indent: &str) -> Run<()> {
    let encrypted = session.keys.is_some();
    for change in changes {
        let remote_file = if encrypted { format!("{}.enc", change.file) } else { change.file.clone() };
        let remote_path = join(project_path, &remote_file);
        if change.is_new {
            let source = match direction {
                Direction::Push => read_text(&change.file)?,
                Direction::Pull => {
                    // With a key set, the TypeScript looks for `<file>.enc`
                    // even when the store holds plaintext, and fails here.
                    let raw = read_text(&remote_path)?;
                    if encrypted {
                        match session.decrypt(&raw) {
                            Ok(text) => text,
                            Err(_) => return fail(format!("Failed to decrypt {remote_file}. Wrong GENVX_KEY?")),
                        }
                    } else {
                        raw
                    }
                }
            };
            out::log(&format!("{indent}{} (New):", change.file));
            for (key, _) in parse_env_vars(&source) {
                out::log(&format!("{indent}  + {key}"));
            }
        } else {
            // readPairContent(): nothing is listed if either side is missing
            // or cannot be decrypted.
            if !exists(&remote_path) || !exists(&change.file) {
                continue;
            }
            let raw = read_text(&remote_path)?;
            let remote_content = if encrypted {
                match session.decrypt(&raw) {
                    Ok(text) => text,
                    Err(_) => continue,
                }
            } else {
                raw
            };
            let local_content = read_text(&change.file)?;
            let lines = match direction {
                Direction::Push => env_var_changes(&remote_content, &local_content),
                Direction::Pull => env_var_changes(&local_content, &remote_content),
            };
            if lines.is_empty() {
                out::log(&format!("{indent}{} (formatting changes)", change.file));
            } else {
                out::log(&format!("{indent}{}:", change.file));
                for line in lines {
                    out::log(&format!("{indent}{line}"));
                }
            }
        }
    }
    Ok(())
}

/// `displayAndConfirm(...)` where no question is asked: the Rust binary only
/// takes push and pull with `--yes` or without a terminal on standard input,
/// and then the TypeScript does not ask either.
fn display_and_confirm(session: &mut Session, changes: &[Change], project_path: &str, direction: Direction) -> Run<()> {
    out::log("\nChanges:");
    display_changes(session, changes, project_path, direction, "  ")?;
    out::log("");
    Ok(())
}

fn push_pairs(local_files: &[String], encrypted: bool) -> Vec<Pair> {
    local_files
        .iter()
        .map(|file| Pair { local: file.clone(), remote: if encrypted { format!("{file}.enc") } else { file.clone() } })
        .collect()
}

/// `resolveRemoteFiles` and `buildPullPairs`: the encrypted files if there is
/// a key and any exist, else the plaintext ones, else nothing.
fn pull_pairs(project_path: &str, has_key: bool) -> Option<(Vec<Pair>, bool)> {
    let all = find_env_files(project_path);
    let (encrypted, plain): (Vec<String>, Vec<String>) = all.into_iter().partition(|file| file.ends_with(".enc"));
    if has_key && !encrypted.is_empty() {
        let pairs = encrypted
            .into_iter()
            .map(|file| Pair { local: file[..file.len() - 4].to_string(), remote: file })
            .collect();
        return Some((pairs, true));
    }
    if !plain.is_empty() {
        let pairs = plain.into_iter().map(|file| Pair { local: file.clone(), remote: file }).collect();
        return Some((pairs, false));
    }
    None
}

/// The first lines of pushToGitstore, pullFromGitstore and diffWithGitstore:
/// remote, branch, project id, key, working copy.
fn open_session(env: &mut Env, gitstore: &str) -> Run<(Session, String, String)> {
    let remote = match project::git_remote(env) {
        Ok(remote) => remote,
        Err(message) => return fail(message),
    };
    project::only_ascii(&remote)?;
    let project = match project::project(&remote) {
        Ok(project) => project,
        Err(message) => return fail(message),
    };
    // requireEncryptionKey(true)
    env.load_config()?;
    let key = match env.get("GENVX_KEY") {
        Some(key) if !key.is_empty() => key,
        _ => return fail("GENVX_KEY not set. Add it to ~/.genvx/.env.local or use --no-encrypt."),
    };
    let gitstore_path = sync_gitstore(env, gitstore, &project.branch)?;
    Ok((Session { project_id: project.id, keys: Some(Keys::new(key)) }, gitstore_path, project.branch))
}

fn elapsed_ms(start: Instant) -> u128 {
    (start.elapsed().as_secs_f64() * 1000.0).round() as u128
}

// ── the three commands ─────────────────────────────────────────────────────

/// `pushToGitstore(gitstoreUrl, yes, true)`
pub fn push(env: &mut Env, gitstore: &str) -> Run<()> {
    let (mut session, gitstore_path, branch) = open_session(env, gitstore)?;
    ensure_dir(&gitstore_path)?;

    let local_files = find_env_files(".");
    if local_files.is_empty() {
        return Ok(());
    }
    let pairs = push_pairs(&local_files, session.keys.is_some());
    let changes = detect_changes(&mut session, &gitstore_path, &pairs, Direction::Push)?;
    if changes.is_empty() {
        out::log("\u{2705} No changes");
        return Ok(());
    }
    display_and_confirm(&mut session, &changes, &gitstore_path, Direction::Push)?;

    for change in &changes {
        let start = Instant::now();
        secure_permissions(&change.file)?;
        let content = read_text(&change.file)?;
        let dest_path = join(&gitstore_path, &format!("{}.enc", change.file));
        ensure_dir(dirname(&dest_path))?;
        let encrypted = crypto::encrypt(&content, session.keys.as_mut().expect("key"));
        if let Err(err) = fs::write(&dest_path, encrypted) {
            return fail(fs_error(&err, "open", &dest_path));
        }
        let verb = if change.is_new { "Created" } else { "Updated" };
        out::log(&format!("\u{2705} {verb} {} (encrypted)  [{}ms]", change.file, elapsed_ms(start)));
    }

    must(git::git(env, &["-C", &gitstore_path, "add", "-A"]))?;
    must(git::git(env, &["-C", &gitstore_path, "commit", "-m", "Update env files"]))?;
    let pushed = git::git(env, &["-C", &gitstore_path, "push", "-u", "origin", &branch, "-q"]);
    if !pushed.ok() {
        return fail(format!("Failed to push to gitstore: {}", pushed.stderr));
    }
    Ok(())
}

/// How `pullFromGitstore` is called by the `pull` command and by a git hook.
#[derive(Clone, Copy)]
pub struct PullOptions {
    /// print nothing (hooks)
    pub quiet: bool,
    /// copy a file to `.genvx/backups/<time>/` before overwriting it (hooks)
    pub backup: bool,
}

/// `pullFromGitstore(gitstoreUrl, yes, true, opts)` with `yes` true or
/// nobody to ask. Returns the number of files written.
pub fn pull(env: &mut Env, gitstore: &str, opts: PullOptions) -> Run<usize> {
    let (mut session, gitstore_path, _) = open_session(env, gitstore)?;

    let Some((pairs, is_encrypted)) = pull_pairs(&gitstore_path, session.keys.is_some()) else {
        if !opts.quiet {
            out::log("No env files found in gitstore for this project.");
        }
        return Ok(0);
    };
    let changes = detect_changes(&mut session, &gitstore_path, &pairs, Direction::Pull)?;
    if changes.is_empty() {
        if !opts.quiet {
            out::log("\u{2705} No changes");
        }
        return Ok(0);
    }
    if !opts.quiet {
        display_and_confirm(&mut session, &changes, &gitstore_path, Direction::Pull)?;
    }

    let stamp = backup_stamp(SystemTime::now());
    for change in &changes {
        let start = Instant::now();
        let remote_file = if is_encrypted { format!("{}.enc", change.file) } else { change.file.clone() };
        let remote_path = join(&gitstore_path, &remote_file);
        ensure_dir(dirname(&change.file))?;

        if opts.backup && !change.is_new && exists(&change.file) {
            let dest = join(&join(&join(&genvx_dir(), "backups"), &stamp), &change.file);
            ensure_dir(dirname(&dest))?;
            copy_file(&change.file, &dest)?;
        }

        if is_encrypted && session.keys.is_some() {
            let raw = read_text(&remote_path)?;
            let Ok(decrypted) = session.decrypt(&raw) else {
                // Cannot happen: the same text was decrypted a moment ago.
                return fail(format!("Failed to decrypt {remote_file}. Wrong GENVX_KEY?"));
            };
            if let Err(err) = fs::write(&change.file, decrypted) {
                return fail(fs_error(&err, "open", &change.file));
            }
        } else {
            copy_file(&remote_path, &change.file)?;
        }

        secure_permissions(&change.file)?;
        if !opts.quiet {
            let verb = if change.is_new { "Created" } else { "Updated" };
            out::log(&format!("\u{2705} {verb} {}  [{}ms]", change.file, elapsed_ms(start)));
        }
    }
    Ok(changes.len())
}

/// `diffWithGitstore(gitstoreUrl, true)`
pub fn diff(env: &mut Env, gitstore: &str) -> Run<()> {
    let (mut session, gitstore_path, _) = open_session(env, gitstore)?;

    match pull_pairs(&gitstore_path, session.keys.is_some()) {
        None => out::log("pull: (no remote files found)"),
        Some((pairs, _)) => {
            let changes = detect_changes(&mut session, &gitstore_path, &pairs, Direction::Pull)?;
            if changes.is_empty() {
                out::log("pull: (no changes)");
            } else {
                out::log("pull:");
                display_changes(&mut session, &changes, &gitstore_path, Direction::Pull, "  ")?;
            }
        }
    }

    let local_files = find_env_files(".");
    if local_files.is_empty() {
        out::log("push: (no local .env* files)");
        return Ok(());
    }
    ensure_dir(&gitstore_path)?;
    let pairs = push_pairs(&local_files, session.keys.is_some());
    let changes = detect_changes(&mut session, &gitstore_path, &pairs, Direction::Push)?;
    if changes.is_empty() {
        out::log("push: (no changes)");
    } else {
        out::log("push:");
        display_changes(&mut session, &changes, &gitstore_path, Direction::Push, "  ")?;
    }
    Ok(())
}

/// `new Date().toISOString().replace(/[:.]/g, "-")`
fn backup_stamp(now: SystemTime) -> String {
    let millis = now.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0) as i64;
    let (seconds, ms) = (millis.div_euclid(1000), millis.rem_euclid(1000));
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Days since 1970-01-01 to a date in the Gregorian calendar.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{ms:03}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stamps_are_utc_iso_with_dashes() {
        let at = |ms: u64| backup_stamp(UNIX_EPOCH + Duration::from_millis(ms));
        assert_eq!(at(0), "1970-01-01T00-00-00-000Z");
        assert_eq!(at(1_767_225_600_000), "2026-01-01T00-00-00-000Z");
        assert_eq!(at(1_709_251_199_999), "2024-02-29T23-59-59-999Z");
        assert_eq!(at(1_795_727_553_123), "2026-11-26T21-12-33-123Z");
        assert_eq!(at(951_782_400_000), "2000-02-29T00-00-00-000Z");
    }

    #[test]
    fn variables_are_listed_like_a_map() {
        assert_eq!(parse_env_vars("A=1\n  B = two \n#C=3\nD\n=E\nexport F=6\nA=again\r\nG="), vec![("A", "again"), ("B", " two"), ("export F", "6"), ("G", "")]);
        assert_eq!(
            env_var_changes("A=1\nB=2\nC=3\n", "B=2\nA=one\nD=4\n"),
            vec!["  + A (Updated)", "  + D", "  - C"]
        );
        assert!(env_var_changes("# x\nA=1", "A=1\n\n").is_empty());
    }

    #[test]
    fn path_helpers() {
        assert_eq!(join(".", ".env"), ".env");
        assert_eq!(join("", ".env"), ".env");
        assert_eq!(dirname(".env"), ".");
        let nested = join(&join(".genvx", "gitstore"), &join("sub", ".env.enc"));
        assert_eq!(dirname(&nested), join(&join(".genvx", "gitstore"), "sub"));
    }
}
