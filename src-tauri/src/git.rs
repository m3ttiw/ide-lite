//! Repository info, status and history.

use crate::gitcmd::{self, Mode, lossy, nul_tokens};
use crate::paths::{canonical_slash, root_dir, to_slash};
use crate::types::{Commit, CommitRef, FileStatus, RefKind, RepoInfo, StatusEntry};
use std::path::Path;

pub fn repo_info(root: &str) -> Result<RepoInfo, String> {
    let dir = root_dir(root)?;
    let top = gitcmd::run(&dir, Mode::Read, &["rev-parse", "--show-toplevel"])?;
    if top.not_repo() || (top.ok() && top.stdout_str().trim().is_empty()) {
        return Ok(RepoInfo {
            root: canonical_slash(&dir),
            is_repo: false,
            branch: None,
            head: None,
            upstream: None,
            ahead: 0,
            behind: 0,
        });
    }
    if !top.ok() {
        return Err(gitcmd::failure("rev-parse", &top));
    }
    let toplevel = to_slash(Path::new(top.stdout_str().trim()));

    // One status call gives branch, HEAD, upstream and ahead/behind.
    // `-uno` and ignored submodules keep it cheap: no untracked scan.
    let st = gitcmd::run_ok(
        &dir,
        Mode::Read,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no", "--ignore-submodules=all"],
    )?;
    let mut info = RepoInfo {
        root: toplevel,
        is_repo: true,
        branch: None,
        head: None,
        upstream: None,
        ahead: 0,
        behind: 0,
    };
    for tok in nul_tokens(&st.stdout) {
        let Some(h) = tok.strip_prefix(b"# ") else { continue };
        let h = lossy(h);
        if let Some(v) = h.strip_prefix("branch.oid ") {
            if v != "(initial)" {
                info.head = Some(v.to_string());
            }
        } else if let Some(v) = h.strip_prefix("branch.head ") {
            if v != "(detached)" {
                info.branch = Some(v.to_string());
            }
        } else if let Some(v) = h.strip_prefix("branch.upstream ") {
            info.upstream = Some(v.to_string());
        } else if let Some(v) = h.strip_prefix("branch.ab ") {
            for part in v.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    info.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    info.behind = n.parse().unwrap_or(0);
                }
            }
        }
    }
    Ok(info)
}

/// Parses `git status --porcelain=v2 -z` entries (headers and ignored entries skipped).
pub fn parse_status_v2(bytes: &[u8]) -> Vec<StatusEntry> {
    let mut out = Vec::new();
    let mut it = nul_tokens(bytes);
    while let Some(tok) = it.next() {
        if tok.len() < 2 {
            continue;
        }
        match tok[0] {
            b'1' => {
                let f: Vec<&[u8]> = tok.splitn(9, |b| *b == b' ').collect();
                if f.len() == 9 && f[1].len() == 2 {
                    out.push(StatusEntry {
                        path: lossy(f[8]),
                        orig_path: None,
                        index: FileStatus::from_code(f[1][0]),
                        worktree: FileStatus::from_code(f[1][1]),
                    });
                }
            }
            b'2' => {
                let f: Vec<&[u8]> = tok.splitn(10, |b| *b == b' ').collect();
                let orig = it.next();
                if f.len() == 10 && f[1].len() == 2 {
                    out.push(StatusEntry {
                        path: lossy(f[9]),
                        orig_path: orig.map(lossy),
                        index: FileStatus::from_code(f[1][0]),
                        worktree: FileStatus::from_code(f[1][1]),
                    });
                }
            }
            b'u' => {
                let f: Vec<&[u8]> = tok.splitn(11, |b| *b == b' ').collect();
                if f.len() == 11 {
                    out.push(StatusEntry {
                        path: lossy(f[10]),
                        orig_path: None,
                        index: Some(FileStatus::Unmerged),
                        worktree: Some(FileStatus::Unmerged),
                    });
                }
            }
            b'?' => out.push(StatusEntry {
                path: lossy(&tok[2..]),
                orig_path: None,
                index: None,
                worktree: Some(FileStatus::Untracked),
            }),
            _ => {}
        }
    }
    out
}

pub fn git_status(root: &str) -> Result<Vec<StatusEntry>, String> {
    let dir = root_dir(root)?;
    let out = gitcmd::run(
        &dir,
        Mode::Read,
        &["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames"],
    )?;
    if out.not_repo() {
        return Ok(Vec::new());
    }
    if !out.ok() {
        return Err(gitcmd::failure("status", &out));
    }
    Ok(parse_status_v2(&out.stdout))
}

const FIELD: char = '\u{1f}';

/// Parses one `%D` decoration list produced with `--decorate=full`.
/// Returns (refs, HEAD points here).
pub fn parse_decorations(d: &str) -> (Vec<CommitRef>, bool) {
    let mut refs = Vec::new();
    let mut is_head = false;
    for item in d.split(", ").map(str::trim).filter(|s| !s.is_empty()) {
        let item = if let Some(rest) = item.strip_prefix("HEAD -> ") {
            is_head = true;
            rest
        } else if item == "HEAD" {
            is_head = true;
            continue;
        } else {
            item
        };
        let item = item.strip_prefix("tag: ").unwrap_or(item);
        if let Some(n) = item.strip_prefix("refs/heads/") {
            refs.push(CommitRef { name: n.to_string(), kind: RefKind::Branch });
        } else if let Some(n) = item.strip_prefix("refs/remotes/") {
            // `origin/HEAD` is a symbolic alias of a remote branch: noise.
            if !n.ends_with("/HEAD") {
                refs.push(CommitRef { name: n.to_string(), kind: RefKind::Remote });
            }
        } else if let Some(n) = item.strip_prefix("refs/tags/") {
            refs.push(CommitRef { name: n.to_string(), kind: RefKind::Tag });
        }
    }
    (refs, is_head)
}

pub fn git_log(root: &str, skip: u32, limit: u32, all: bool) -> Result<Vec<Commit>, String> {
    let dir = root_dir(root)?;
    if limit == 0 {
        return Ok(Vec::new());
    }
    let skip_arg = format!("--skip={skip}");
    let max_arg = format!("--max-count={limit}");
    let mut args: Vec<&str> = vec![
        "-c",
        "i18n.logOutputEncoding=UTF-8",
        "log",
        "--date-order",
        "--no-show-signature",
        "--no-color",
        "-z",
        "--decorate=full",
        "--decorate-refs=HEAD",
        "--decorate-refs=refs/heads/",
        "--decorate-refs=refs/remotes/",
        "--decorate-refs=refs/tags/",
        "--format=%H%x1f%P%x1f%at%x1f%an%x1f%D%x1f%s",
        &skip_arg,
        &max_arg,
        "--ignore-missing",
    ];
    if all {
        args.extend(["--branches", "--remotes", "--tags"]);
    }
    args.extend(["HEAD", "--"]);
    let out = gitcmd::run(&dir, Mode::Read, &args)?;
    if out.not_repo() {
        return Ok(Vec::new());
    }
    if !out.ok() {
        // A repository without any commit has nothing to show.
        if out.stderr.contains("does not have any commits yet") {
            return Ok(Vec::new());
        }
        return Err(gitcmd::failure("log", &out));
    }
    let mut commits = Vec::new();
    for rec in nul_tokens(&out.stdout) {
        let rec = lossy(rec);
        let rec = rec.trim_start_matches('\n');
        let f: Vec<&str> = rec.splitn(6, FIELD).collect();
        if f.len() < 6 || f[0].is_empty() {
            continue;
        }
        let (refs, is_head) = parse_decorations(f[4]);
        commits.push(Commit {
            hash: f[0].to_string(),
            parents: f[1].split(' ').filter(|s| !s.is_empty()).map(str::to_string).collect(),
            date: f[2].trim().parse().unwrap_or(0),
            author: f[3].to_string(),
            refs,
            is_head,
            subject: f[5].to_string(),
        });
    }
    Ok(commits)
}
