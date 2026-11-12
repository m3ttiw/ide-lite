//! `git worktree` listing, per-worktree status and creation.

use crate::git::parse_status_v2;
use crate::gitcmd::{self, Mode, lossy};
use crate::paths::{canonical_slash, compare_key, is_within, root_dir, to_slash};
use crate::types::{Worktree, WorktreeStatus};
use std::path::{Path, PathBuf};

/// One record of `git worktree list --porcelain -z`.
#[derive(Debug, Default, Clone)]
struct RawWorktree {
    path: String,
    head: String,
    branch: Option<String>,
    detached: bool,
    bare: bool,
    locked: bool,
    prunable: bool,
}

fn parse_porcelain(bytes: &[u8]) -> Vec<RawWorktree> {
    let mut list = Vec::new();
    let mut cur: Option<RawWorktree> = None;
    // Records are NUL-terminated lines; an empty line ends a worktree.
    for line in bytes.split(|b| *b == 0) {
        if line.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let line = lossy(line);
        let (key, val) = line.split_once(' ').unwrap_or((line.as_str(), ""));
        match key {
            "worktree" => {
                if let Some(w) = cur.take() {
                    list.push(w);
                }
                cur = Some(RawWorktree { path: val.to_string(), ..Default::default() });
            }
            _ => {
                let Some(w) = cur.as_mut() else { continue };
                match key {
                    "HEAD" => w.head = val.to_string(),
                    "branch" => w.branch = Some(val.strip_prefix("refs/heads/").unwrap_or(val).to_string()),
                    "detached" => w.detached = true,
                    "bare" => w.bare = true,
                    "locked" => w.locked = true,
                    "prunable" => w.prunable = true,
                    _ => {}
                }
            }
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }
    list
}

/// Raw list, main worktree first. `None` outside a repository.
fn raw_list(dir: &Path) -> Result<Option<Vec<RawWorktree>>, String> {
    let out = gitcmd::run(dir, Mode::Read, &["worktree", "list", "--porcelain", "-z"])?;
    if out.not_repo() {
        return Ok(None);
    }
    if !out.ok() {
        return Err(gitcmd::failure("worktree list", &out));
    }
    Ok(Some(parse_porcelain(&out.stdout)))
}

pub fn list_worktrees(root: &str) -> Result<Vec<Worktree>, String> {
    let dir = root_dir(root)?;
    let Some(raw) = raw_list(&dir)? else {
        return Ok(Vec::new());
    };
    let root_key = compare_key(&canonical_slash(&dir));
    // The current worktree is the deepest one that contains `root`.
    let keys: Vec<String> = raw.iter().map(|w| compare_key(&canonical_slash(Path::new(&w.path)))).collect();
    let current = keys
        .iter()
        .enumerate()
        .filter(|(i, k)| !raw[*i].bare && is_within(&root_key, k))
        .max_by_key(|(_, k)| k.len())
        .map(|(i, _)| i);
    Ok(raw
        .into_iter()
        .enumerate()
        // A bare main repository has no working tree to show.
        .filter(|(_, w)| !w.bare)
        .map(|(i, w)| Worktree {
            path: to_slash(Path::new(&w.path)),
            branch: w.branch,
            head: w.head,
            is_main: i == 0,
            is_current: current == Some(i),
            detached: w.detached,
            locked: w.locked,
            prunable: w.prunable,
        })
        .collect())
}

pub fn worktree_status(worktree_path: &str, base: Option<&str>) -> Result<WorktreeStatus, String> {
    let dir = root_dir(worktree_path)?;
    // Same untracked mode as `git_status`, so this number equals the length of
    // the changes list shown for the same folder.
    let st = gitcmd::run_ok(&dir, Mode::Read, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?;
    let dirty = parse_status_v2(&st.stdout).len() as u32;
    let (mut ahead, mut behind) = (0, 0);
    if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) {
        // "HEAD...<base>" is a single argument, so `base` cannot act as an option.
        let range = format!("HEAD...{base}");
        let out = gitcmd::run_ok(&dir, Mode::Read, &["rev-list", "--left-right", "--count", &range, "--"])?;
        let s = out.stdout_str();
        let mut it = s.split_whitespace();
        ahead = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        behind = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
    }
    Ok(WorktreeStatus { ahead, behind, dirty })
}

/// Folder for a new worktree: `<main parent>/<main folder>.<branch, "/" -> "-">`.
pub fn worktree_dir_for(main: &Path, branch: &str) -> Result<PathBuf, String> {
    let name = main
        .file_name()
        .ok_or_else(|| format!("cannot derive a folder name from {}", main.display()))?
        .to_string_lossy();
    let parent = main.parent().ok_or_else(|| format!("{} has no parent folder", main.display()))?;
    Ok(parent.join(format!("{name}.{}", branch.replace('/', "-"))))
}

pub fn add_worktree(root: &str, branch: &str) -> Result<Worktree, String> {
    let dir = root_dir(root)?;
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.contains("@{") {
        return Err(format!("invalid branch name: {branch:?}"));
    }
    let check = gitcmd::run(&dir, Mode::Read, &["check-ref-format", "--branch", branch])?;
    if !check.ok() {
        return Err(format!("invalid branch name: {branch:?}"));
    }
    let raw = raw_list(&dir)?.ok_or("not a git repository")?;
    let main = raw.first().ok_or("git worktree list returned nothing")?;
    let target = worktree_dir_for(Path::new(&main.path), branch)?;
    if target.exists() {
        return Err(format!("{} already exists", to_slash(&target)));
    }
    let local_ref = format!("refs/heads/{branch}");
    let exists = gitcmd::run(&dir, Mode::Read, &["show-ref", "--verify", "--quiet", &local_ref])?.ok();
    let target_os = target.as_os_str();
    let out = if exists {
        gitcmd::run(&dir, Mode::Write, &[std::ffi::OsStr::new("worktree"), "add".as_ref(), target_os, branch.as_ref()])?
    } else {
        gitcmd::run(
            &dir,
            Mode::Write,
            &[
                std::ffi::OsStr::new("worktree"),
                "add".as_ref(),
                "-b".as_ref(),
                branch.as_ref(),
                target_os,
                "HEAD".as_ref(),
            ],
        )?
    };
    if !out.ok() {
        return Err(gitcmd::failure("worktree add", &out));
    }
    let target_key = compare_key(&canonical_slash(&target));
    list_worktrees(root)?
        .into_iter()
        .find(|w| compare_key(&canonical_slash(Path::new(&w.path))) == target_key)
        .ok_or_else(|| format!("worktree created at {} but not listed", to_slash(&target)))
}
