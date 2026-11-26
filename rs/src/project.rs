//! Which project this is: the origin remote, and the store branch and
//! project id derived from it.

use crate::crypto;
use crate::env::{Env, HandBack};
use crate::git;
use crate::js;

/// `getGitRemote()`: the message is what the TypeScript throws.
pub fn git_remote(env: &Env) -> Result<String, String> {
    let output = git::git(env, &["config", "--get", "remote.origin.url"]);
    if output.ok() {
        Ok(js::trim(&output.stdout).to_string())
    } else {
        Err("Not in a git repository or no remote origin found".to_string())
    }
}

/// `parseGitRemote(remoteUrl)`: host, owner and repo, or `None` where the
/// TypeScript throws "Invalid git remote URL".
///
/// It only understands `http(s)://host/owner/repo` and `git@host.com:owner/repo`
/// (the `.com` is literal in the TypeScript), with an optional `.git`.
pub fn parse_remote(remote: &str) -> Option<(String, String, String)> {
    let url = match remote.strip_prefix("git@") {
        Some(rest) => format!("https://{rest}").replacen(".com:", ".com/", 1),
        None => remote.to_string(),
    };
    let url = url.strip_suffix(".git").unwrap_or(&url);

    // url.match(/https?:\/\/([^/]+)\/([^/]+)\/(.+)$/): the first place in the
    // string where the pattern fits.
    let mut from = 0;
    while let Some(found) = url[from..].find("http") {
        let start = from + found;
        from = start + 1;
        let after = &url[start + 4..];
        let Some(rest) = after.strip_prefix("s://").or_else(|| after.strip_prefix("://")) else { continue };
        let Some((host, rest)) = rest.split_once('/') else { continue };
        let Some((owner, repo)) = rest.split_once('/') else { continue };
        if host.is_empty() || owner.is_empty() || repo.is_empty() || repo.contains(js::is_line_terminator) {
            continue;
        }
        return Some((host.to_string(), owner.to_string(), repo.to_string()));
    }
    None
}

pub struct Project {
    /// `getBranchName(remote)`: `env/` and 16 hex digits.
    pub branch: String,
    /// `getProjectId(remote)`: `host/owner/repo`, lower case.
    pub id: String,
}

/// Branch and id for a remote; `Err` carries the TypeScript's error message.
pub fn project(remote: &str) -> Result<Project, String> {
    let (host, owner, repo) = parse_remote(remote).ok_or_else(|| format!("Invalid git remote URL: {remote}"))?;
    let id = format!("{host}/{owner}/{repo}").to_ascii_lowercase();
    let branch = format!("env/{}", &crypto::sha256_hex(id.as_bytes())[..16]);
    Ok(Project { branch, id })
}

/// JavaScript's `toLowerCase` is Unicode-aware; here only ASCII is lowered,
/// so anything else goes back to the JavaScript.
pub fn only_ascii(text: &str) -> Result<(), HandBack> {
    if text.is_ascii() {
        Ok(())
    } else {
        Err(HandBack)
    }
}

/// `s.replace(/\.git$/, "").toLowerCase()`, used to tell whether the project
/// is the gitstore itself.
pub fn same_repository(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.strip_suffix(".git").unwrap_or(s).to_ascii_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(remote: &str) -> Option<(&'static str, &'static str, &'static str)> {
        parse_remote(remote).map(|(h, o, r)| (&*h.leak(), &*o.leak(), &*r.leak()))
    }

    #[test]
    fn remotes() {
        assert_eq!(parts("https://github.com/Acme/App.git"), Some(("github.com", "Acme", "App")));
        assert_eq!(parts("git@github.com:Acme/App.git"), Some(("github.com", "Acme", "App")));
        assert_eq!(parts("http://h/o/r"), Some(("h", "o", "r")));
        assert_eq!(parts("https://gitlab.com/group/sub/repo.git"), Some(("gitlab.com", "group", "sub/repo")));
        assert_eq!(parts("https://user@git.example.com:8443/o/r.git"), Some(("user@git.example.com:8443", "o", "r")));
        assert_eq!(parts("git+https://github.com/Acme/App.git"), Some(("github.com", "Acme", "App")));
        assert_eq!(parts("https:///https://h/o/r"), Some(("h", "o", "r")));
        assert_eq!(parts("https://h/o/r.git.git"), Some(("h", "o", "r.git")));
        assert_eq!(parts("https://h/o/r/"), Some(("h", "o", "r/")));
        assert_eq!(parts("git@gitlab.example.org:team/app.git"), None);
        assert_eq!(parts("ssh://git@github.com/Acme/App.git"), None);
        assert_eq!(parts("/srv/git/app.git"), None);
        assert_eq!(parts("https://github.com/app.git"), None);
        assert_eq!(parts("https://h/o/"), None);
        assert_eq!(parts("https://h//r"), None);
        assert_eq!(parts("https://h/o/r\nx"), None);
        assert_eq!(parts(""), None);
    }

    #[test]
    fn branch_and_id() {
        let p = project("git@GitHub.com:Acme/App.git").unwrap();
        assert_eq!(p.id, "github.com/acme/app");
        assert_eq!(p.branch, "env/98d9fc12e0202ede");
        assert_eq!(project("nope").err().unwrap(), "Invalid git remote URL: nope");
    }

    #[test]
    fn gitstore_guard() {
        assert!(same_repository("https://github.com/Acme/Secrets.git", "https://GitHub.com/acme/secrets"));
        assert!(!same_repository("https://github.com/Acme/Secrets.git.git", "https://github.com/acme/secrets"));
    }
}
