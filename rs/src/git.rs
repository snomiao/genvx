//! Running `git` the way the TypeScript does through `Bun.$`: the program
//! found on PATH, the current directory, the whole of `process.env`, standard
//! input passed through, output captured.

use std::process::{Command, Stdio};

use crate::env::Env;
use crate::js;

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
}

/// `` await Bun.$`<program> <args>`.quiet().nothrow() ``
pub fn run(env: &Env, program: &str, args: &[&str]) -> Output {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::inherit()).stdout(Stdio::piped()).stderr(Stdio::piped());
    env.apply(&mut command);
    match command.output() {
        Ok(output) => Output {
            code: exit_code(&output.status),
            stdout: js::utf8(&output.stdout),
            stderr: js::utf8(&output.stderr),
        },
        // What bun's shell reports for a program it cannot find.
        Err(_) => Output { code: 1, stdout: String::new(), stderr: format!("bun: command not found: {program}\n") },
    }
}

pub fn git(env: &Env, args: &[&str]) -> Output {
    run(env, "git", args)
}

fn exit_code(status: &std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(1)
}
