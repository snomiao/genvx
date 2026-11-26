//! `console.log` and `console.error`: whole lines, and a closed pipe is not
//! this program's problem.

use std::io::Write;

/// `console.log(text)`
pub fn log(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush());
}

/// `console.error(text)`
pub fn error(text: &str) {
    let mut err = std::io::stderr().lock();
    let _ = err.write_all(text.as_bytes()).and_then(|_| err.write_all(b"\n")).and_then(|_| err.flush());
}
