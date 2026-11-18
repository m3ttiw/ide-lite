//! Review of a worktree: every file its branch changes against a base branch
//! (committed or not, untracked included), the blob id of each file as it is
//! on disk, and diffs either against the base or against a reviewed snapshot.
//!
//! A snapshot is the file's content written to the object database with
//! `git hash-object -w` when the user marks it as reviewed: later the review
//! shows only what changed since then. Unreferenced objects are pruned by
//! `git gc` after two weeks; a missing snapshot is reported as an error and the
//! interface falls back to the full diff.

use crate::diff::{WORK_DIFF, check_hash, empty_diff, finish, not_repo_err, parse_raw_numstat, run_patch, untracked_diff};
use crate::gitcmd::{self, Mode, nul_tokens, lossy};
use crate::paths::{clean_rel, root_dir};
use crate::types::{FileDiff, FileStatus, FileText, ReviewFile, ReviewInfo};
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};

/// `git hash-object -t tree /dev/null`: the base of a repository without commits.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Top folder of the worktree that contains `root`: every path here is relative to it.
pub(crate) fn toplevel(root: &str) -> Result<PathBuf, String> {
    let dir = root_dir(root)?;
    let out = gitcmd::run(&dir, Mode::Read, &["rev-parse", "--show-toplevel"])?;
    if out.not_repo() {
        return Err(not_repo_err());
    }
    if !out.ok() {
        return Err(gitcmd::failure("rev-parse", &out));
    }
    Ok(PathBuf::from(out.stdout_str().trim()))
}

/// The commit to compare with (see `ReviewInfo::base_commit`).
fn base_commit(dir: &Path, base: Option<&str>) -> Result<String, String> {
    let head = gitcmd::run(dir, Mode::Read, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?;
    if !head.ok() {
        return Ok(EMPTY_TREE.to_string());
    }
    let head = head.stdout_str().trim().to_string();
    let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) else {
        return Ok(head);
    };
    if base.starts_with('-') {
        return Err(format!("invalid base branch: {base:?}"));
    }
    let out = gitcmd::run(dir, Mode::Read, &["merge-base", "HEAD", base])?;
    match out.code {
        Some(0) => Ok(out.stdout_str().trim().to_string()),
        Some(1) => Err(format!("HEAD and {base} have no commit in common")),
        _ => Err(gitcmd::failure("merge-base", &out)),
    }
}

/// Line count and binary flag of a file that git does not track yet.
fn count_lines(path: &Path) -> (u32, bool) {
    let Ok(file) = std::fs::File::open(path) else {
        return (0, false);
    };
    let mut r = std::io::BufReader::with_capacity(64 * 1024, file);
    match r.fill_buf() {
        Ok(head) if head[..head.len().min(8000)].contains(&0) => return (0, true),
        Ok(_) => {}
        Err(_) => return (0, false),
    }
    let mut lines = 0u32;
    let mut last = b'\n';
    let mut buf = vec![0u8; 64 * 1024];
    while let Ok(n) = r.read(&mut buf) {
        if n == 0 {
            break;
        }
        lines += buf[..n].iter().filter(|b| **b == b'\n').count() as u32;
        last = buf[n - 1];
    }
    (lines + u32::from(last != b'\n'), false)
}

/// Blob ids of files on disk, in order (`None` where hashing failed).
/// `write` also stores the contents in the object database.
fn hash_files(dir: &Path, paths: &[&str], write: bool) -> Vec<Option<String>> {
    if paths.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["hash-object"];
    if write {
        args.push("-w");
    }
    args.push("--stdin-paths");
    let mode = if write { Mode::Write } else { Mode::Read };
    let input = paths.join("\n").into_bytes();
    if let Ok(out) = gitcmd::run_input(dir, mode, &args, input) {
        let ids: Vec<Option<String>> = out.stdout_str().lines().map(|l| Some(l.trim().to_string())).collect();
        if out.ok() && ids.len() == paths.len() {
            return ids;
        }
    }
    // One file failed (vanished, unreadable): hash them one by one.
    paths
        .iter()
        .map(|p| {
            let mut a = args[..args.len() - 1].to_vec();
            a.extend(["--", p]);
            gitcmd::run(dir, mode, &a).ok().filter(|o| o.ok()).map(|o| o.stdout_str().trim().to_string())
        })
        .collect()
}

/// Files that differ between `from` and `to` (a commit), or between `from`
/// and the working tree (untracked files included) when `to` is None.
/// `blobs`: also hash each file on disk (working tree only).
fn changed_files(dir: &Path, from: &str, to: Option<&str>, blobs: bool) -> Result<Vec<ReviewFile>, String> {
    let mut args = vec!["diff", "--raw", "--numstat", "-z", "-M", "--no-ext-diff", "--no-textconv", "--no-relative", from];
    if let Some(to) = to {
        args.push(to);
    }
    args.push("--");
    let out = gitcmd::run_ok(dir, Mode::Read, &args)?;
    let (raw, num) = parse_raw_numstat(&out.stdout);
    let mut files: Vec<ReviewFile> = raw
        .into_iter()
        .map(|e| {
            let n = num.get(&e.path);
            ReviewFile {
                additions: n.map_or(0, |n| n.additions),
                deletions: n.map_or(0, |n| n.deletions),
                binary: n.is_some_and(|n| n.binary),
                path: e.path,
                orig_path: e.orig_path,
                status: e.status,
                blob: None,
            }
        })
        .collect();
    if to.is_some() {
        return Ok(files);
    }

    let others = gitcmd::run_ok(dir, Mode::Read, &["ls-files", "-z", "--others", "--exclude-standard"])?;
    for tok in nul_tokens(&others.stdout) {
        let path = lossy(tok);
        // a nested repository is listed as "dir/" and not entered
        if path.is_empty() || path.ends_with('/') {
            continue;
        }
        let (additions, binary) = count_lines(&dir.join(&path));
        files.push(ReviewFile { path, orig_path: None, status: FileStatus::Untracked, additions, deletions: 0, binary, blob: None });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    if blobs {
        let present: Vec<usize> = (0..files.len()).filter(|i| files[*i].status != FileStatus::Deleted).collect();
        let paths: Vec<&str> = present.iter().map(|i| files[*i].path.as_str()).collect();
        let ids = hash_files(dir, &paths, false);
        for (i, id) in present.into_iter().zip(ids) {
            files[i].blob = id;
        }
    }
    Ok(files)
}

pub fn review_files(root: &str, base: Option<&str>) -> Result<ReviewInfo, String> {
    let dir = toplevel(root)?;
    let base_commit = base_commit(&dir, base)?;
    let files = changed_files(&dir, &base_commit, None, true)?;
    Ok(ReviewInfo { base_commit, files })
}

/// A commit given by the interface (hash, branch, "HEAD~1"…), or the empty tree.
fn commit_id(dir: &Path, spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    if spec == EMPTY_TREE {
        return Ok(EMPTY_TREE.into());
    }
    if spec.is_empty() || spec.starts_with('-') {
        return Err(format!("invalid revision: {spec:?}"));
    }
    let out = gitcmd::run(dir, Mode::Read, &["rev-parse", "--verify", "--quiet", &format!("{spec}^{{commit}}")])?;
    if !out.ok() {
        return Err(format!("unknown revision: {spec}"));
    }
    Ok(out.stdout_str().trim().to_string())
}

/// Files that differ between two commits, or between a commit and the working tree.
pub fn compare_files(root: &str, from: &str, to: Option<&str>) -> Result<Vec<ReviewFile>, String> {
    let dir = toplevel(root)?;
    let from = commit_id(&dir, from)?;
    let to = to.map(|t| commit_id(&dir, t)).transpose()?;
    changed_files(&dir, &from, to.as_deref(), false)
}

/// Files over this size are not loaded for a side-by-side comparison.
const MAX_TEXT: u64 = 5 * 1024 * 1024;

fn text_of(bytes: Vec<u8>) -> FileText {
    if bytes[..bytes.len().min(8000)].contains(&0) {
        return FileText { kind: "binary".into(), text: None };
    }
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    };
    FileText { kind: "text".into(), text: Some(text) }
}

fn no_text(kind: &str) -> FileText {
    FileText { kind: kind.into(), text: None }
}

/// Content of a file in a commit (`rev`), a blob (`rev` is its id), or on disk (`rev` None).
pub fn file_text(root: &str, rev: Option<&str>, path: &str) -> Result<FileText, String> {
    let dir = toplevel(root)?;
    let rel = clean_rel(path)?;
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    let Some(rev) = rev.map(str::trim) else {
        let abs = dir.join(&rel);
        let Ok(meta) = std::fs::metadata(&abs) else { return Ok(no_text("missing")) };
        if !meta.is_file() {
            return Ok(no_text("missing"));
        }
        if meta.len() > MAX_TEXT {
            return Ok(no_text("tooLarge"));
        }
        return std::fs::read(&abs).map(text_of).map_err(|e| format!("{rel}: {e}"));
    };
    if rev == EMPTY_TREE {
        return Ok(no_text("missing"));
    }
    if rev.is_empty() || rev.starts_with('-') {
        return Err(format!("invalid revision: {rev:?}"));
    }
    let is_blob = check_hash(rev).is_ok() && {
        let t = gitcmd::run(&dir, Mode::Read, &["cat-file", "-t", rev])?;
        t.ok() && t.stdout_str().trim() == "blob"
    };
    let object = if is_blob { rev.to_string() } else { format!("{rev}:{rel}") };
    let size = gitcmd::run(&dir, Mode::Read, &["cat-file", "-s", &object])?;
    if !size.ok() {
        return Ok(no_text("missing"));
    }
    if size.stdout_str().trim().parse::<u64>().unwrap_or(0) > MAX_TEXT {
        return Ok(no_text("tooLarge"));
    }
    let out = gitcmd::run_ok(&dir, Mode::Read, &["cat-file", "blob", &object])?;
    Ok(text_of(out.stdout))
}

/// Stores the current content of each file as a snapshot; returns its blob id
/// (`None` for a file that is not on disk: reviewed as deleted).
pub fn mark_reviewed(root: &str, paths: &[String]) -> Result<Vec<Option<String>>, String> {
    let dir = toplevel(root)?;
    let mut rels = Vec::with_capacity(paths.len());
    for p in paths {
        rels.push(clean_rel(p)?);
    }
    let present: Vec<usize> = (0..rels.len()).filter(|i| dir.join(&rels[*i]).is_file()).collect();
    let list: Vec<&str> = present.iter().map(|i| rels[*i].as_str()).collect();
    let ids = hash_files(&dir, &list, true);
    let mut out = vec![None; rels.len()];
    for (i, id) in present.into_iter().zip(ids) {
        out[i] = id;
    }
    Ok(out)
}

/// The empty blob, written so that a diff from or to "no content" works.
fn empty_blob(dir: &Path) -> Result<String, String> {
    let out = gitcmd::run_input(dir, Mode::Write, &["hash-object", "-w", "--stdin"], Vec::new())?;
    if !out.ok() {
        return Err(gitcmd::failure("hash-object", &out));
    }
    Ok(out.stdout_str().trim().to_string())
}

/// Diff of one file: against the base commit, or (with `since`) against the
/// snapshot taken when it was marked as reviewed.
pub fn review_file_diff(root: &str, base_commit: &str, path: &str, orig_path: Option<&str>, since: Option<&str>) -> Result<FileDiff, String> {
    let dir = toplevel(root)?;
    let rel = clean_rel(path)?;
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    let abs = dir.join(&rel);

    if let Some(since) = since {
        check_hash(since)?;
        let exists = gitcmd::run(&dir, Mode::Read, &["cat-file", "-e", &format!("{since}^{{blob}}")])?;
        if !exists.ok() {
            return Err("the reviewed version is no longer available".into());
        }
        let on_disk = abs.is_file();
        let now = if on_disk {
            hash_files(&dir, &[rel.as_str()], true).pop().flatten().ok_or_else(|| format!("{rel}: cannot read the file"))?
        } else {
            empty_blob(&dir)?
        };
        let status = if on_disk { FileStatus::Modified } else { FileStatus::Deleted };
        if now == since {
            return Ok(empty_diff(rel, None, status));
        }
        let mut args: Vec<&str> = vec!["diff"];
        args.extend(WORK_DIFF.iter().filter(|a| **a != "--no-relative" && **a != "-M"));
        args.extend([since, now.as_str()]);
        let p = run_patch(&dir, &args)?.ok_or_else(not_repo_err)?;
        return Ok(finish(rel, None, status, p));
    }

    if base_commit != EMPTY_TREE {
        check_hash(base_commit)?;
    }
    let orig = orig_path.map(clean_rel).transpose()?.filter(|o| !o.is_empty() && *o != rel);
    let mut args: Vec<&str> = vec!["--literal-pathspecs", "diff"];
    args.extend(WORK_DIFF);
    args.extend([base_commit, "--"]);
    if let Some(o) = &orig {
        args.push(o);
    }
    args.push(&rel);
    let p = run_patch(&dir, &args)?.ok_or_else(not_repo_err)?;
    if p.has_file {
        let status = p.status.unwrap_or(FileStatus::Modified);
        return Ok(finish(rel, orig, status, p));
    }
    // No diff: unchanged, or not tracked at all.
    let ls = gitcmd::run_ok(&dir, Mode::Read, &["--literal-pathspecs", "ls-files", "-z", "--", rel.as_str()])?;
    if ls.stdout.is_empty() && abs.is_file() {
        return untracked_diff(&abs, rel);
    }
    Ok(empty_diff(rel, None, FileStatus::Modified))
}
