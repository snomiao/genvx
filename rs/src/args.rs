//! Which invocations the Rust binary takes.
//!
//! The TypeScript parses its arguments with yargs, which accepts far more
//! spellings than anyone types (flags before the command, `--yes=false`,
//! `-yg url`, `--no-yes`, repeated flags that turn into arrays, …) and owns
//! `--help`, `--version` and every usage error. None of that is imitated.
//! `parse` recognises only the plain shapes below, read exactly as yargs
//! reads them; everything else is `None` and goes back to the JavaScript.
//!
//!   branch | b
//!   push | p | save      [-y|--yes] [--no-encrypt] [-g|--gitstore <url>]
//!   pull | load          (same flags)
//!   diff | d             (same flags)
//!   hooks install        [--mode auto|local|lefthook|shared]
//!   hooks uninstall
//!   hooks status
//!   hooks run [event]
//!   setup | init         [-y|--yes] [-g|--gitstore <url>] [--dir <dir>] [--hooks|--no-hooks]
//!
//! A flag may be given once. A value is `--flag value` or `--flag=value`
//! (`-g value` for the short one), is not empty and starts with neither `-`
//! nor a quote.

use crate::hooks::Mode;

#[derive(Debug, PartialEq)]
pub enum Command {
    Branch,
    Push(Sync),
    Pull(Sync),
    Diff(Sync),
    HooksInstall { mode: Option<Mode> },
    HooksUninstall,
    HooksStatus,
    HooksRun { event: Option<String> },
    Setup { yes: bool, gitstore: Option<String>, dir: Option<String>, hooks: bool },
}

/// The flags push, pull and diff share.
#[derive(Debug, PartialEq, Default)]
pub struct Sync {
    pub yes: bool,
    pub gitstore: Option<String>,
    // `--no-encrypt` is accepted and changes nothing, as in the TypeScript:
    // yargs reads it as "encrypt = false", and the program looks at an
    // option called "no-encrypt", which stays false.
}

/// A value yargs passes through untouched.
fn plain_value(value: &str) -> bool {
    !value.is_empty() && !value.starts_with(['-', '"', '\''])
}

/// Walks the arguments after the command.
struct Words<'a> {
    rest: std::slice::Iter<'a, String>,
}

impl<'a> Words<'a> {
    /// The value of the option `long` (or `short`) if `word` is that option:
    /// `Some(None)` if the option is there without a usable value.
    fn value_of(&mut self, word: &'a str, long: &str, short: Option<&str>) -> Option<Option<&'a str>> {
        if word == long || Some(word) == short {
            let value = self.rest.next().map(String::as_str).filter(|v| plain_value(v));
            return Some(value);
        }
        let inline = word.strip_prefix(long)?.strip_prefix('=')?;
        Some(Some(inline).filter(|v| plain_value(v)))
    }
}

/// Sets `slot` once; a second time is not a shape handled here.
fn once<T>(slot: &mut Option<T>, value: T) -> Option<()> {
    if slot.is_some() {
        return None;
    }
    *slot = Some(value);
    Some(())
}

pub fn parse(args: &[String]) -> Option<Command> {
    let (command, rest) = args.split_first()?;
    let mut words = Words { rest: rest.iter() };
    match command.as_str() {
        "branch" | "b" => rest.is_empty().then_some(Command::Branch),
        "push" | "p" | "save" => sync_flags(&mut words).map(Command::Push),
        "pull" | "load" => sync_flags(&mut words).map(Command::Pull),
        "diff" | "d" => sync_flags(&mut words).map(Command::Diff),
        "hooks" => hooks(&mut words),
        "setup" | "init" => setup(&mut words),
        _ => None,
    }
}

fn sync_flags(words: &mut Words) -> Option<Sync> {
    let (mut yes, mut no_encrypt, mut gitstore) = (None, None, None);
    while let Some(word) = words.rest.next() {
        match word.as_str() {
            "-y" | "--yes" => once(&mut yes, true)?,
            "--no-encrypt" => once(&mut no_encrypt, true)?,
            word => once(&mut gitstore, words.value_of(word, "--gitstore", Some("-g"))??.to_string())?,
        }
    }
    Some(Sync { yes: yes.unwrap_or(false), gitstore })
}

fn hooks(words: &mut Words) -> Option<Command> {
    let mut mode = None;
    let mut positional: Vec<&str> = Vec::new();
    while let Some(word) = words.rest.next() {
        if let Some(value) = words.value_of(word, "--mode", None) {
            let value = match value? {
                "auto" => None,
                "local" => Some(Mode::Local),
                "lefthook" => Some(Mode::Lefthook),
                "shared" => Some(Mode::Shared),
                _ => return None,
            };
            once(&mut mode, value)?;
        } else if word.starts_with('-') {
            return None;
        } else {
            positional.push(word);
        }
    }
    match (positional.as_slice(), mode) {
        (["install"], mode) => Some(Command::HooksInstall { mode: mode.flatten() }),
        (["uninstall"], None) => Some(Command::HooksUninstall),
        (["status"], None) => Some(Command::HooksStatus),
        (["run"], None) => Some(Command::HooksRun { event: None }),
        (["run", event], None) if plain_event(event) => Some(Command::HooksRun { event: Some(event.to_string()) }),
        _ => None,
    }
}

/// A hook name as git passes it (`post-merge`); nothing yargs could read as
/// a number or a boolean.
fn plain_event(event: &str) -> bool {
    event.starts_with(|c: char| c.is_ascii_alphabetic())
        && event.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && event != "true"
        && event != "false"
}

fn setup(words: &mut Words) -> Option<Command> {
    let (mut yes, mut gitstore, mut dir, mut hooks) = (None, None, None, None);
    while let Some(word) = words.rest.next() {
        match word.as_str() {
            "-y" | "--yes" => once(&mut yes, true)?,
            "--hooks" => once(&mut hooks, true)?,
            "--no-hooks" => once(&mut hooks, false)?,
            word => {
                if let Some(value) = words.value_of(word, "--gitstore", Some("-g")) {
                    once(&mut gitstore, value?.to_string())?;
                } else {
                    once(&mut dir, words.value_of(word, "--dir", None)??.to_string())?;
                }
            }
        }
    }
    Some(Command::Setup { yes: yes.unwrap_or(false), gitstore, dir, hooks: hooks.unwrap_or(true) })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(line: &str) -> Option<Command> {
        let args: Vec<String> = line.split_whitespace().map(String::from).collect();
        parse(&args)
    }

    fn sync(yes: bool, gitstore: Option<&str>) -> Sync {
        Sync { yes, gitstore: gitstore.map(String::from) }
    }

    #[test]
    fn the_shapes_taken() {
        assert_eq!(p("branch"), Some(Command::Branch));
        assert_eq!(p("b"), Some(Command::Branch));
        assert_eq!(p("push"), Some(Command::Push(sync(false, None))));
        assert_eq!(p("p -y"), Some(Command::Push(sync(true, None))));
        assert_eq!(p("save --yes --no-encrypt"), Some(Command::Push(sync(true, None))));
        assert_eq!(p("pull -g ../s.git"), Some(Command::Pull(sync(false, Some("../s.git")))));
        assert_eq!(p("load --gitstore ../s.git -y"), Some(Command::Pull(sync(true, Some("../s.git")))));
        assert_eq!(p("diff --gitstore=https://h/o/r.git?a=b"), Some(Command::Diff(sync(false, Some("https://h/o/r.git?a=b")))));
        assert_eq!(p("d"), Some(Command::Diff(sync(false, None))));
        assert_eq!(p("hooks install"), Some(Command::HooksInstall { mode: None }));
        assert_eq!(p("hooks install --mode auto"), Some(Command::HooksInstall { mode: None }));
        assert_eq!(p("hooks install --mode=shared"), Some(Command::HooksInstall { mode: Some(Mode::Shared) }));
        assert_eq!(p("hooks --mode local install"), Some(Command::HooksInstall { mode: Some(Mode::Local) }));
        assert_eq!(p("hooks install --mode lefthook"), Some(Command::HooksInstall { mode: Some(Mode::Lefthook) }));
        assert_eq!(p("hooks uninstall"), Some(Command::HooksUninstall));
        assert_eq!(p("hooks status"), Some(Command::HooksStatus));
        assert_eq!(p("hooks run"), Some(Command::HooksRun { event: None }));
        assert_eq!(p("hooks run post-merge"), Some(Command::HooksRun { event: Some("post-merge".into()) }));
        assert_eq!(
            p("setup -y -g https://h/o/r --dir ~/x --no-hooks"),
            Some(Command::Setup { yes: true, gitstore: Some("https://h/o/r".into()), dir: Some("~/x".into()), hooks: false })
        );
        assert_eq!(p("init"), Some(Command::Setup { yes: false, gitstore: None, dir: None, hooks: true }));
        assert_eq!(p("init --hooks --dir=."), Some(Command::Setup { yes: false, gitstore: None, dir: Some(".".into()), hooks: true }));
    }

    #[test]
    fn everything_else_goes_back() {
        for line in [
            "",
            "--help",
            "-h",
            "--version",
            "-v",
            "version",
            "frobnicate",
            "PUSH",
            "branch extra",
            "branch -y",
            "branch --help",
            "-y push",
            "push pull",
            "push extra",
            "push --help",
            "push -h",
            "push --version",
            "push -y -y",
            "push --yes -y",
            "push --yes=true",
            "push --yes true",
            "push --yes false",
            "push --no-yes",
            "push -yg x",
            "push -g=x",
            "push -g",
            "push --gitstore",
            "push --gitstore=",
            "push --gitstore -y",
            "push --gitstore=-x",
            "push --gitstore \"x\"",
            "push --gitstore='x'",
            "push -g a -g b",
            "push --gitstore a --gitstore=b",
            "push --gitstorex=a",
            "push --no-encrypt --no-encrypt",
            "push --no-encrypt=true",
            "push --noEncrypt",
            "push --no-no-encrypt",
            "push --encrypt",
            "push --frobnicate",
            "push --",
            "push --mode local",
            "push --dir x",
            "diff now",
            "hooks",
            "hooks bogus",
            "hooks --help",
            "hooks install extra",
            "hooks install -y",
            "hooks install --mode",
            "hooks install --mode bogus",
            "hooks install --mode=",
            "hooks install --mode local --mode shared",
            "hooks status --mode shared",
            "hooks uninstall --mode=auto",
            "hooks run --mode=auto",
            "hooks run a b",
            "hooks run 42",
            "hooks run true",
            "hooks run -x",
            "hooks run post.merge",
            "hooks status a b",
            "hooks install status",
            "setup extra",
            "setup --dir",
            "setup --dir -g x",
            "setup --dir=",
            "setup --hooks=false",
            "setup --hooks --no-hooks",
            "setup --no-encrypt",
            "setup --help",
            "setup -g",
        ] {
            assert_eq!(p(line), None, "{line:?}");
        }
        assert_eq!(parse(&["".to_string()]), None);
        assert_eq!(parse(&["hooks".to_string(), "run".to_string(), "".to_string()]), None);
        assert_eq!(parse(&["push".to_string(), "".to_string()]), None);
    }
}
