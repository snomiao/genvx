//! `genvx setup` / `genvx init` when nobody is asked anything: with `--yes`,
//! or without a terminal on standard input. `setupConfig` in src/index.ts.
//! The interactive form stays with the JavaScript.

use std::fs;

use crate::crypto;
use crate::env::{Env, HandBack};
use crate::hooks;
use crate::js;
use crate::out;
use crate::sync::{exists, fs_error, Stop};

pub struct Options {
    /// `--dir`
    pub dir: Option<String>,
    /// `--gitstore`
    pub store: Option<String>,
    /// false for `--no-hooks`
    pub hooks: bool,
}

/// `path.resolve(p)` on POSIX: absolute, without `.`, `..` or doubled slashes.
fn resolve(cwd: &str, path: &str) -> String {
    let full = if path.starts_with('/') { path.to_string() } else { format!("{cwd}/{path}") };
    let mut parts: Vec<&str> = Vec::new();
    for part in full.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// `p.replace(/^~(?=$|[/\\])/, homedir())`
fn expand_tilde(path: &str, home: &str) -> String {
    match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => format!("{home}{rest}"),
        _ => path.to_string(),
    }
}

/// `upsertEnvVar(content, key, value)`: every line that sets `key` is
/// replaced; if there is none, a line is added at the end.
fn upsert_env_var(content: &str, key: &str, value: &str) -> String {
    let mut lines: Vec<String> = if content.is_empty() { Vec::new() } else { content.split('\n').map(String::from).collect() };
    let mut found = false;
    for line in &mut lines {
        let trimmed = js::trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else { continue };
        if js::trim(&trimmed[..eq]) == key {
            found = true;
            *line = format!("{key}={value}");
        }
    }
    if !found {
        lines.push(format!("{key}={value}"));
    }
    lines.join("\n")
}

/// The value the last line setting `key` gives it (a Map in the TypeScript).
fn existing_var(content: &str, key: &str) -> Option<String> {
    let mut value = None;
    for line in content.split('\n') {
        let trimmed = js::trim(line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else { continue };
        if js::trim(&trimmed[..eq]) == key {
            value = Some(js::trim(&trimmed[eq + 1..]).to_string());
        }
    }
    value
}

pub fn run(env: &Env, options: &Options) -> Result<(), Stop> {
    // Windows paths (drive letters, both slashes) follow other rules in
    // node's path module; only the default directory is taken there.
    if cfg!(windows) && options.dir.is_some() {
        return Err(Stop::HandBack);
    }
    let sep = std::path::MAIN_SEPARATOR;
    let cwd = std::env::current_dir().map_err(|_| HandBack)?.into_os_string().into_string().map_err(|_| HandBack)?;
    let absolute = |path: &str| if cfg!(windows) { path.to_string() } else { resolve(&cwd, path) };

    // 1. Target directory
    let global_dir = absolute(&format!("{}{sep}.genvx", env.home));
    let target_dir = match &options.dir {
        Some(dir) => absolute(&expand_tilde(dir, &env.home)),
        None => global_dir.clone(),
    };
    let target_file = format!("{}{sep}.env.local", target_dir.trim_end_matches(sep));
    let is_auto_loaded = target_dir == global_dir || target_dir == absolute(".");

    // 2. Existing config. If it exists and cannot be read the TypeScript
    //    reports bun's error; nothing has happened yet, so let it.
    let mut content = if exists(&target_file) { js::utf8(&fs::read(&target_file).map_err(|_| HandBack)?) } else { String::new() };

    // 3. GENVX_STORE
    let store = match &options.store {
        Some(store) => store.clone(),
        None => existing_var(&content, "GENVX_STORE").unwrap_or_default(),
    };
    if store.is_empty() {
        return Err(Stop::Fail("GENVX_STORE is required. Pass --gitstore=<url> or run interactively.".to_string()));
    }

    // 4. GENVX_KEY: kept if there is one, else 32 random bytes in base64.
    let mut key = existing_var(&content, "GENVX_KEY").unwrap_or_default();
    let key_generated = key.is_empty();

    // 8, looked at early: what installing the hooks would take. If only the
    // JavaScript can do it, it has to do the whole command.
    let hook_plan = if options.hooks {
        match hooks::plan(env, None) {
            Ok(plan) => Some(plan),
            Err(Stop::HandBack) => return Err(Stop::HandBack),
            // Not a git repository: the TypeScript skips the hooks silently.
            Err(Stop::Fail(_)) => None,
        }
    } else {
        None
    };

    if key_generated {
        key = crypto::base64_encode(&crypto::random(32));
    }

    // 5. Build content
    content = upsert_env_var(&content, "GENVX_STORE", &store);
    content = upsert_env_var(&content, "GENVX_KEY", &key);
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }

    // 7. Write with secure permissions
    if target_dir != "." && !exists(&target_dir) {
        fs::create_dir_all(&target_dir).map_err(|err| Stop::Fail(fs_error(&err, "mkdir", &target_dir)))?;
    }
    fs::write(&target_file, &content).map_err(|err| Stop::Fail(fs_error(&err, "open", &target_file)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&target_file, fs::Permissions::from_mode(0o600)).map_err(|err| {
            Stop::Fail(format!(
                "Failed to set secure permissions (600) on {target_file}: Error: {}",
                fs_error(&err, "chmod", &target_file)
            ))
        })?;
    }
    out::log(&format!("\n\u{2705} Saved config to {target_file}"));

    if key_generated {
        out::log("\n\u{26a0}\u{fe0f}  Encryption key generated. Save it somewhere safe -");
        out::log("   losing it means losing access to ALL encrypted env files:");
        out::log(&format!("\n   GENVX_KEY={key}\n"));
    }
    if !is_auto_loaded {
        out::log("\u{26a0}\u{fe0f}  This directory is not auto-loaded. To use it, set:");
        out::log(&format!("   export GENVX_CONFIG_DIR={target_dir}"));
    }

    // 8. Auto-sync hooks in the current repository, if there is one. Any
    //    failure is silent.
    if let Some(plan) = hook_plan {
        if let Ok(done) = hooks::install(env, &plan) {
            out::log(&format!(
                "\u{2705} Auto-sync hooks installed (mode: {}). Env will refresh on pull/checkout.",
                done.mode.name()
            ));
            for warning in &done.warnings {
                out::log(&format!("\u{26a0}\u{fe0f}  {warning}"));
            }
        }
    }

    out::log("Next: cd into a git project and run  genvx push");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_is_lexical() {
        assert_eq!(resolve("/work/dir", "."), "/work/dir");
        assert_eq!(resolve("/work/dir", "../custom/./deep/.."), "/work/custom");
        assert_eq!(resolve("/work/dir", "/abs//x/"), "/abs/x");
        assert_eq!(resolve("/work/dir", "a/~/b"), "/work/dir/a/~/b");
        assert_eq!(resolve("/", "../.."), "/");
    }

    #[test]
    fn tilde_only_at_the_start() {
        assert_eq!(expand_tilde("~", "/home/u"), "/home/u");
        assert_eq!(expand_tilde("~/.genvx/", "/home/u"), "/home/u/.genvx/");
        assert_eq!(expand_tilde("~\\x", "/home/u"), "/home/u\\x");
        assert_eq!(expand_tilde("~user/x", "/home/u"), "~user/x");
        assert_eq!(expand_tilde("a/~/b", "/home/u"), "a/~/b");
    }

    #[test]
    fn upsert_keeps_everything_else() {
        assert_eq!(upsert_env_var("", "K", "v"), "K=v");
        assert_eq!(upsert_env_var("A=1\n", "K", "v"), "A=1\n\nK=v");
        assert_eq!(upsert_env_var("# c\n  K = old  \nA=1\nK=again", "K", "v"), "# c\nK=v\nA=1\nK=v");
        assert_eq!(existing_var("K=1\n K = two \n#K=3", "K"), Some("two".to_string()));
        assert_eq!(existing_var("A=1", "K"), None);
    }
}
