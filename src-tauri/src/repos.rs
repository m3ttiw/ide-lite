//! Filesystem-only repository discovery and the folder browser. Nothing here
//! spawns git: a repository is a folder that contains a `.git` entry.

use crate::paths::{root_dir, to_slash};
use crate::types::{FolderEntry, FolderListing, RepoEntry};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};

/// Cap of `find_repos` results.
pub const MAX_REPOS: usize = 500;

/// Folder names `find_repos` never descends into (dot-folders are skipped too).
const SKIP_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", "vendor"];

/// Repository facts read from the filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitEntry {
    /// `.git` is a file (linked worktree or submodule).
    pub linked: bool,
    pub branch: Option<String>,
}

/// `Some` when `dir` contains a `.git` entry.
pub fn git_entry(dir: &Path) -> Option<GitEntry> {
    let dot_git = dir.join(".git");
    let meta = fs::metadata(&dot_git).ok()?;
    if meta.is_dir() {
        return Some(GitEntry { linked: false, branch: read_head_branch(&dot_git) });
    }
    let branch = gitdir_of(dir, &dot_git).and_then(|gd| read_head_branch(&gd));
    Some(GitEntry { linked: true, branch })
}

/// Follows the `gitdir:` line of a `.git` file (relative to `dir` when not absolute).
fn gitdir_of(dir: &Path, dot_git_file: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(dot_git_file).ok()?;
    let line = text.lines().find_map(|l| l.trim().strip_prefix("gitdir:"))?.trim();
    if line.is_empty() {
        return None;
    }
    let p = PathBuf::from(line);
    Some(if p.is_absolute() { p } else { dir.join(p) })
}

/// Short branch name from `<git_dir>/HEAD`; `None` when detached or unreadable.
fn read_head_branch(git_dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let name = head.trim().strip_prefix("ref:")?.trim().strip_prefix("refs/heads/")?;
    (!name.is_empty()).then(|| name.to_string())
}

fn sort_key(s: &str) -> (String, String) {
    (s.to_lowercase(), s.to_string())
}

pub fn find_repos(root: &str, max_depth: u32) -> Result<Vec<RepoEntry>, String> {
    find_repos_capped(root, max_depth, MAX_REPOS)
}

/// Breadth-first walk, so the cap keeps the shallowest repositories.
pub fn find_repos_capped(root: &str, max_depth: u32, cap: usize) -> Result<Vec<RepoEntry>, String> {
    let dir = root_dir(root)?;
    let base = dir.canonicalize().unwrap_or(dir);
    let mut found = Vec::new();
    let mut queue: VecDeque<(PathBuf, String, u32)> = VecDeque::new();
    if max_depth > 0 {
        queue.push_back((base, String::new(), 0));
    }
    'walk: while let Some((abs, rel, depth)) = queue.pop_front() {
        let Ok(rd) = fs::read_dir(&abs) else { continue };
        for ent in rd.flatten() {
            // `file_type` does not follow links; on Windows junctions report as symlinks.
            let Ok(t) = ent.file_type() else { continue };
            if !t.is_dir() || t.is_symlink() {
                continue;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let child = ent.path();
            let child_rel = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if let Some(g) = git_entry(&child) {
                found.push(RepoEntry {
                    path: to_slash(&child),
                    rel_path: child_rel,
                    branch: g.branch,
                    linked: g.linked,
                });
                if found.len() >= cap {
                    break 'walk;
                }
            } else if depth + 1 < max_depth {
                queue.push_back((child, child_rel, depth + 1));
            }
        }
    }
    found.sort_by_key(|r| sort_key(&r.rel_path));
    Ok(found)
}

fn folder_entry(name: String, abs: &Path) -> FolderEntry {
    let g = git_entry(abs);
    FolderEntry {
        name,
        path: to_slash(abs),
        is_repo: g.is_some(),
        branch: g.and_then(|g| g.branch),
    }
}

/// Filesystem roots: existing drive letters on Windows, `/` elsewhere.
fn roots() -> Vec<FolderEntry> {
    if cfg!(windows) {
        (b'A'..=b'Z')
            .filter_map(|l| {
                let p = PathBuf::from(format!("{}:\\", l as char));
                p.is_dir().then(|| folder_entry(format!("{}:/", l as char), &p))
            })
            .collect()
    } else {
        vec![folder_entry("/".into(), Path::new("/"))]
    }
}

pub fn browse_dir(path: &str) -> Result<FolderListing, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Ok(FolderListing { path: String::new(), parent: None, dirs: roots() });
    }
    let mut s = trimmed.replace('\\', "/");
    // "C:" alone means "current folder of drive C"; the user means its root.
    if s.len() == 2 && s.as_bytes()[1] == b':' {
        s.push('/');
    }
    let p = PathBuf::from(&s);
    if !p.is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }
    let canon = p.canonicalize().map_err(|e| format!("cannot open folder {s}: {e}"))?;
    if !canon.is_dir() {
        return Err(format!("not a folder: {s}"));
    }
    let rd = fs::read_dir(&canon).map_err(|e| format!("cannot read folder {s}: {e}"))?;
    let mut dirs = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let abs = ent.path();
        let is_dir = match ent.file_type() {
            Ok(t) if t.is_symlink() => match fs::metadata(&abs) {
                Ok(m) => m.is_dir(),
                Err(_) => continue,
            },
            Ok(t) => t.is_dir(),
            Err(_) => continue,
        };
        if is_dir {
            dirs.push(folder_entry(name, &abs));
        }
    }
    dirs.sort_by_key(|d| sort_key(&d.name));
    let parent = Some(canon.parent().map(to_slash).unwrap_or_default());
    Ok(FolderListing { path: to_slash(&canon), parent, dirs })
}
