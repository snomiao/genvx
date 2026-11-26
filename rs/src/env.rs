//! Where the program's environment comes from.
//!
//! The TypeScript reads `process.env`, and that is more than the environment
//! the command was started with:
//!
//! 1. bun, before the program starts, loads `.env.development.local`,
//!    `.env.local`, `.env.development` and `.env` from the current directory
//!    (variables already set win; among the files that order wins). These are
//!    the very files genvx is about, so this is not a corner case.
//! 2. genvx's own `loadEnvConfig` then fills in what is still unset or empty
//!    from `./.env.local`, `./.env`, `$GENVX_CONFIG_DIR/.env.local`,
//!    `$GENVX_CONFIG_DIR/.env`, `~/.genvx/.env.local` and `~/.genvx/.env`,
//!    with a simpler reader (no quotes, no comments after a value).
//!
//! Everything in `process.env` is also the environment of every `git` the
//! program starts. Both steps are reproduced here, in the same order.
//!
//! bun's reader has quoting, `$VAR` expansion and multi-line values. Only the
//! plain part of its syntax is taken here (see `read_plain_dotenv`); a file
//! that uses anything else makes the whole invocation go back to the
//! JavaScript, before anything has been printed or changed.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::js;

/// "Not mine": the invocation has to be handed to the JavaScript. Only ever
/// returned before the first output and the first change on disk.
#[derive(Debug, PartialEq)]
pub struct HandBack;

pub struct Env {
    /// Variables set on top of the real environment (by a `.env` file or by
    /// the config files), oldest first.
    added: Vec<(String, String)>,
    config_loaded: bool,
    /// `os.homedir()`
    pub home: String,
}

/// The files bun loads when NODE_ENV is unset, strongest first.
const BUN_DOTENV_FILES: [&str; 4] = [".env.development.local", ".env.local", ".env.development", ".env"];

impl Env {
    /// The environment as the TypeScript sees it when it starts.
    pub fn startup() -> Result<Env, HandBack> {
        // These change what bun itself does (which .env files it loads, extra
        // command-line options). Rare; not imitated.
        for name in ["NODE_ENV", "BUN_ENV", "BUN_OPTIONS", "NODE_OPTIONS"] {
            if std::env::var_os(name).is_some() {
                return Err(HandBack);
            }
        }
        for name in ["GENVX_STORE", "GENVX_KEY", "GENVX_CONFIG_DIR"] {
            if std::env::var_os(name).is_some_and(|value| value.to_str().is_none()) {
                return Err(HandBack);
            }
        }
        let home = home_dir()?;
        // bun reads bunfig.toml from the directory and from the user's
        // configuration; it can preload scripts and switch .env loading off.
        let mut bunfigs = vec!["bunfig.toml".to_string(), format!("{home}{}.bunfig.toml", std::path::MAIN_SEPARATOR)];
        if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
            bunfigs.push(Path::new(&xdg).join(".bunfig.toml").to_str().ok_or(HandBack)?.to_string());
        }
        for file in bunfigs {
            match fs::symlink_metadata(&file) {
                Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => {}
                _ => return Err(HandBack),
            }
        }

        let mut env = Env { added: Vec::new(), config_loaded: false, home };
        for file in BUN_DOTENV_FILES {
            for (key, value) in read_plain_dotenv(file)? {
                if std::env::var_os(&key).is_none() && env.added.iter().all(|(k, _)| !same_name(k, &key)) {
                    env.added.push((key, value));
                }
            }
        }
        Ok(env)
    }

    /// `process.env[key]`
    pub fn get(&self, key: &str) -> Option<String> {
        if let Some((_, value)) = self.added.iter().find(|(k, _)| same_name(k, key)) {
            return Some(value.clone());
        }
        std::env::var_os(key).map(|value| value.to_string_lossy().into_owned())
    }

    fn set(&mut self, key: &str, value: &str) {
        match self.added.iter_mut().find(|(k, _)| same_name(k, key)) {
            Some(entry) => entry.1 = value.to_string(),
            None => self.added.push((key.to_string(), value.to_string())),
        }
    }

    /// `loadEnvConfig()`: runs once, the first time the store or the key is
    /// asked for, so a command that never asks never loads these files.
    pub fn load_config(&mut self) -> Result<(), HandBack> {
        if self.config_loaded {
            return Ok(());
        }
        self.config_loaded = true;

        let sep = std::path::MAIN_SEPARATOR;
        let mut paths = vec![".env.local".to_string(), ".env".to_string()];
        if let Some(dir) = self.get("GENVX_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
            // node joins paths lexically ("a/../b" is "b"); the system does
            // not when "a" is a symlink. Leading ".." are the same for both.
            if cfg!(windows) || has_inner_parent_step(&dir) {
                return Err(HandBack);
            }
            for name in [".env.local", ".env"] {
                paths.push(Path::new(&dir).join(name).to_str().ok_or(HandBack)?.to_string());
            }
        }
        paths.push(format!("{}{sep}.genvx{sep}.env.local", self.home));
        paths.push(format!("{}{sep}.genvx{sep}.env", self.home));

        for path in paths {
            // existsSync
            if fs::metadata(&path).is_err() {
                continue;
            }
            // The TypeScript crashes with bun's own error dump when it cannot
            // read a file that exists (a directory, no permission).
            let content = js::utf8(&fs::read(&path).map_err(|_| HandBack)?);
            for line in content.split('\n') {
                let trimmed = js::trim(line);
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                let Some(eq) = trimmed.find('=') else { continue };
                let key = js::trim(&trimmed[..eq]);
                let value = js::trim(&trimmed[eq + 1..]);
                if key.is_empty() {
                    continue;
                }
                if key.contains('\0') || value.contains('\0') || OBJECT_MEMBERS.contains(&key) {
                    return Err(HandBack);
                }
                // `!process.env[key]`: unset or empty.
                if self.get(key).is_none_or(|current| current.is_empty()) {
                    self.set(key, value);
                }
            }
        }
        Ok(())
    }

    /// Gives a child process the variables added on top of the real environment.
    pub fn apply(&self, command: &mut std::process::Command) {
        for (key, value) in &self.added {
            command.env(key, value);
        }
    }
}

/// Names for which `process.env[name]` may answer with something inherited
/// from Object.prototype instead of a variable.
const OBJECT_MEMBERS: [&str; 12] = [
    "constructor",
    "toString",
    "toLocaleString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

/// Environment variable names are case-insensitive on Windows.
fn same_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// `os.homedir()` where it is simply the variable; anything else goes back.
fn home_dir() -> Result<String, HandBack> {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(name).ok_or(HandBack)?.into_string().map_err(|_| HandBack)?;
    let path = Path::new(&home);
    let plain = path.is_absolute()
        && path.components().all(|c| !matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir))
        && !home.contains('$');
    // Unix: must already be in the form node's path functions would give it.
    if !plain || (cfg!(unix) && (home.contains("//") || (home.len() > 1 && home.ends_with('/')) || home.contains("/./") || home.ends_with("/."))) {
        return Err(HandBack);
    }
    Ok(home)
}

/// True for "a/../b": a ".." that follows a real directory name.
fn has_inner_parent_step(path: &str) -> bool {
    let mut seen_name = false;
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if seen_name => return true,
            ".." => {}
            _ => seen_name = true,
        }
    }
    false
}

/// Variables that would change how bun or the program itself behaves if a
/// `.env` file set them (where the home directory is, which programs are
/// found, which files bun loads).
fn changes_the_runtime(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(key.as_str(), "HOME" | "USERPROFILE" | "PATH" | "XDG_CONFIG_HOME" | "TMPDIR" | "TEMP" | "TMP")
        || key.starts_with("BUN_")
        || key.starts_with("NODE_")
}

/// Reads one of the files bun loads, if it is written in the plain subset
/// where there is nothing to interpret:
///
/// - empty lines, and lines starting with `#`;
/// - `KEY=value` with KEY made of letters, digits and `_`, no space before
///   `=`, and a value without quotes (`"`, `'`, `` ` ``), `#`, `$` or control
///   characters. Spaces and tabs around the value are dropped, as bun does.
///
/// Lines end in LF or CRLF. Anything else — `export`, indentation, a quoted
/// or multi-line value, an inline comment, a variable reference, a BOM, the
/// same key twice — is `HandBack`.
fn read_plain_dotenv(path: &str) -> Result<Vec<(String, String)>, HandBack> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(HandBack),
    };
    if !meta.is_file() {
        return Err(HandBack);
    }
    let bytes = fs::read(path).map_err(|_| HandBack)?;
    parse_plain_dotenv(std::str::from_utf8(&bytes).map_err(|_| HandBack)?)
}

fn parse_plain_dotenv(text: &str) -> Result<Vec<(String, String)>, HandBack> {
    let mut vars: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.contains('\r') {
            return Err(HandBack);
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = line.split_once('=').ok_or(HandBack)?;
        let key_is_plain = key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
            && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let value = value.trim_matches([' ', '\t']);
        let value_is_plain = value.chars().all(|c| {
            !c.is_control() && !matches!(c, '"' | '\'' | '`' | '#' | '$') && (c == ' ' || !(js::is_space(c) || c == '\u{85}'))
        });
        if !key_is_plain || !value_is_plain || changes_the_runtime(key) || vars.iter().any(|(k, _)| same_name(k, key)) {
            return Err(HandBack);
        }
        vars.push((key.to_string(), value.to_string()));
    }
    Ok(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> Result<Vec<(String, String)>, HandBack> {
        parse_plain_dotenv(text)
    }

    fn pairs(list: &[(&str, &str)]) -> Result<Vec<(String, String)>, HandBack> {
        Ok(list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    #[test]
    fn plain_dotenv_lines_are_read() {
        assert_eq!(parsed(""), pairs(&[]));
        assert_eq!(parsed("A=1\nB=two words\n"), pairs(&[("A", "1"), ("B", "two words")]));
        assert_eq!(parsed("# it's a \"comment\" with $x\r\n\r\nA=1\r\nB= \t padded \t \r\nC="), pairs(&[("A", "1"), ("B", "padded"), ("C", "")]));
        assert_eq!(
            parsed("URL=https://user:pa.ss@host.example.com:8080/a/b.git?x=1&y=2\nWIN=C:\\Users\\me\nU=héllo→世界"),
            pairs(&[("URL", "https://user:pa.ss@host.example.com:8080/a/b.git?x=1&y=2"), ("WIN", "C:\\Users\\me"), ("U", "héllo→世界")])
        );
    }

    #[test]
    fn anything_bun_would_interpret_goes_back() {
        for text in [
            "A=\"quoted\"",
            "A='quoted'",
            "A=`quoted`",
            "A=it's",
            "A=1 # comment",
            "A=a#b",
            "A=$HOME/x",
            "A=cost$",
            "export A=1",
            " A=1",
            "A =1",
            "A",
            "A.B=1",
            "A-B=1",
            "1A=1",
            "A=1\nA=2",
            "A=a\tb",
            "A=a\u{a0}b",
            "A=1\rB=2",
            "\u{feff}A=1",
            "   ",
            "NODE_ENV=production",
            "BUN_ENV=test",
            "PATH=/x",
            "Path=/x",
            "HOME=/x",
            "BUN_CONFIG_X=1",
            "NODE_OPTIONS=--x",
            "XDG_CONFIG_HOME=/x",
        ] {
            assert_eq!(parsed(text), Err(HandBack), "{text:?}");
        }
    }

    #[test]
    fn parent_steps_inside_a_path_are_noticed() {
        assert!(!has_inner_parent_step("../cfg"));
        assert!(!has_inner_parent_step("../../cfg/./x"));
        assert!(!has_inner_parent_step("/etc/genvx"));
        assert!(has_inner_parent_step("a/../b"));
        assert!(has_inner_parent_step("/a/b/.."));
        assert!(has_inner_parent_step("../a/.."));
    }
}
