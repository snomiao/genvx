//! genvx — Rust entry point.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and a parity test shows it behaves like the
//! TypeScript; until then it is handed back to the JavaScript the package
//! still ships, so nothing changes for users.

mod args;
mod crypto;
mod env;
mod git;
mod hooks;
mod js;
mod js_fallback;
mod out;
mod project;
mod setup;
mod sync;

use std::io::IsTerminal;

use args::Command;
use env::{Env, HandBack};
use sync::{PullOptions, Stop};

/// The package's JavaScript entry, relative to the package root.
const JS_ENTRY: &str = "src/cli.ts";

/// `GENVX_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
fn native() -> bool {
    std::env::var_os("GENVX_NO_NATIVE").is_none()
}

fn main() {
    // Arguments that are not UTF-8 are for the JavaScript to deal with.
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    let command = args.as_deref().and_then(args::parse);
    let result = match command {
        // Ported commands, one arm each, switched on once their parity cases
        // (rs/parity.json) pass. Each returns `Err(HandBack)` for an
        // invocation it does not take, before printing or changing anything.
        Some(Command::Branch) if native() => branch(),
        Some(Command::Diff(flags)) if native() => sync_command(Direction::Diff, &flags),
        Some(Command::Pull(flags)) if native() => sync_command(Direction::Pull, &flags),
        Some(Command::Push(flags)) if native() => sync_command(Direction::Push, &flags),
        Some(Command::HooksRun { event }) if native() => hooks_run(event.as_deref()),
        Some(Command::HooksStatus) if native() => hooks_command(hooks::cmd_status),
        Some(Command::HooksInstall { mode }) if native() => hooks_command(|env| hooks::cmd_install(env, mode)),
        Some(Command::HooksUninstall) if native() => hooks_command(hooks::cmd_uninstall),
        _ => Err(HandBack),
    };
    match result {
        Ok(code) => std::process::exit(code),
        Err(HandBack) => js_fallback::run(JS_ENTRY),
    }
}

/// The process exit code, or `HandBack`.
type Exit = Result<i32, HandBack>;

/// `console.error(`Error: ${message}`); process.exit(1)`
fn error_exit(message: &str) -> Exit {
    out::error(&format!("Error: {message}"));
    Ok(1)
}

/// `genvx branch`
fn branch() -> Exit {
    let env = Env::startup()?;
    let remote = match project::git_remote(&env) {
        Ok(remote) => remote,
        Err(message) => return error_exit(&message),
    };
    project::only_ascii(&remote)?;
    match project::project(&remote) {
        Ok(project) => {
            out::log(&project.branch);
            Ok(0)
        }
        Err(message) => error_exit(&message),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    Push,
    Pull,
    Diff,
}

/// `genvx push | pull | diff`: resolveGitstore, guardGitstore, withCleanup.
fn sync_command(direction: Direction, flags: &args::Sync) -> Exit {
    // A terminal on standard input means the TypeScript asks before it
    // writes. Asking is not ported.
    if direction != Direction::Diff && !flags.yes && std::io::stdin().is_terminal() {
        return Err(HandBack);
    }
    let cwd = std::env::current_dir().map_err(|_| HandBack)?.into_os_string().into_string().map_err(|_| HandBack)?;
    let mut env = Env::startup()?;

    // resolveGitstore()
    let gitstore = match &flags.gitstore {
        Some(gitstore) => gitstore.clone(),
        None => {
            env.load_config()?;
            match env.get("GENVX_STORE").filter(|store| !store.is_empty()) {
                Some(store) => store,
                None => {
                    out::error("Error: GENVX_STORE not configured");
                    out::error("Set it via --gitstore flag, GENVX_STORE env var, or in ~/.genvx/.env.local");
                    return Ok(1);
                }
            }
        }
    };
    project::only_ascii(&gitstore)?;

    // guardGitstore(): not inside a gitstore working copy, and the project
    // must not be the gitstore itself.
    if sync::inside_gitstore_dir(&cwd) {
        return error_exit("Cannot run genvx inside the gitstore directory");
    }
    if let Ok(remote) = project::git_remote(&env) {
        project::only_ascii(&remote)?;
        if project::same_repository(&remote, &gitstore) {
            return error_exit("Cannot run genvx inside the gitstore repository itself");
        }
    }

    // withCleanup(): on an error the working directory is left as it is.
    let result = match direction {
        Direction::Push => sync::push(&mut env, &gitstore),
        Direction::Pull => sync::pull(&mut env, &gitstore, PullOptions { quiet: false, backup: false }).map(|_| ()),
        Direction::Diff => sync::diff(&mut env, &gitstore),
    };
    finish(result, sync::cleanup)
}

/// The end of a command: `Error: <message>` and exit code 1 for an error the
/// TypeScript throws; `after` only runs on success.
fn finish(result: Result<(), Stop>, after: fn()) -> Exit {
    match result {
        Ok(()) => {
            after();
            Ok(0)
        }
        Err(Stop::Fail(message)) => error_exit(&message),
        Err(Stop::HandBack) => Err(HandBack),
    }
}

/// `genvx hooks install | uninstall | status`
fn hooks_command(run: impl FnOnce(&Env) -> Result<(), Stop>) -> Exit {
    let env = Env::startup()?;
    finish(run(&env), || {})
}

/// `genvx hooks run [event]`: always exit code 0.
fn hooks_run(event: Option<&str>) -> Exit {
    let mut env = Env::startup()?;
    hooks::cmd_run(&mut env, event.unwrap_or("manual"))?;
    Ok(0)
}

/// `genvx setup` without questions.
#[allow(dead_code)]
fn setup_command(yes: bool, options: &setup::Options) -> Exit {
    if !yes && std::io::stdin().is_terminal() {
        return Err(HandBack);
    }
    let env = Env::startup()?;
    finish(setup::run(&env, options), || {})
}
