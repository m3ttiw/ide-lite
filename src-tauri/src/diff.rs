//! Commit file lists and unified-diff parsing.

use crate::gitcmd::{self, Mode, Streamed, lossy, nul_tokens};
use crate::paths::{clean_rel, resolve, root_dir};
use crate::types::{CommitFile, DiffHunk, DiffLine, FileDiff, FileStatus, LineKind};
use std::collections::HashMap;
use std::io::{BufRead, Read};
use std::path::Path;

/// Maximum number of diff lines returned for one file.
pub const MAX_DIFF_LINES: usize = 20_000;

/// One entry of `--raw -z` output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub status: FileStatus,
    pub orig_path: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumStat {
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// Parses a `-z` token stream that mixes `--raw` and `--numstat` records.
pub fn parse_raw_numstat(bytes: &[u8]) -> (Vec<RawEntry>, HashMap<String, NumStat>) {
    let mut raw = Vec::new();
    let mut num = HashMap::new();
    let mut it = nul_tokens(bytes);
    while let Some(tok) = it.next() {
        if tok.first() == Some(&b':') {
            // ":old_mode new_mode old_sha new_sha STATUS[score]"
            let status_field = tok.rsplit(|b| *b == b' ').next().unwrap_or(b"");
            let code = status_field.first().copied().unwrap_or(b'M');
            let status = FileStatus::from_code(code).unwrap_or(FileStatus::Modified);
            let first = it.next().map(lossy).unwrap_or_default();
            if matches!(code, b'R' | b'C') {
                let second = it.next().map(lossy).unwrap_or_default();
                raw.push(RawEntry { status, orig_path: Some(first), path: second });
            } else {
                raw.push(RawEntry { status, orig_path: None, path: first });
            }
        } else {
            // "add\tdel\tpath" or, for renames/copies, "add\tdel\t" + old + new.
            let mut parts = tok.splitn(3, |b| *b == b'\t');
            let a = parts.next().unwrap_or(b"");
            let d = parts.next().unwrap_or(b"");
            let p = parts.next().unwrap_or(b"");
            let path = if p.is_empty() {
                let _old = it.next();
                it.next().map(lossy).unwrap_or_default()
            } else {
                lossy(p)
            };
            let binary = a == b"-" || d == b"-";
            let parse = |x: &[u8]| std::str::from_utf8(x).ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            num.insert(
                path,
                NumStat {
                    additions: if binary { 0 } else { parse(a) },
                    deletions: if binary { 0 } else { parse(d) },
                    binary,
                },
            );
        }
    }
    (raw, num)
}

/// A commit id: hex only, so it can never be read as an option or a range.
pub(crate) fn check_hash(hash: &str) -> Result<(), String> {
    if (4..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(format!("invalid commit hash: {hash:?}"))
    }
}

/// `git diff-tree` arguments that compare a commit with its first parent
/// (merge) or the empty tree (root).
const COMMIT_DIFF: [&str; 6] = ["-r", "-M", "--root", "--diff-merges=first-parent", "--no-commit-id", "-z"];

fn commit_raw(dir: &Path, hash: &str, numstat: bool) -> Result<Option<Vec<u8>>, String> {
    let mut args: Vec<&str> = vec!["diff-tree"];
    args.extend(COMMIT_DIFF);
    args.push("--raw");
    if numstat {
        args.push("--numstat");
    }
    args.push(hash);
    let out = gitcmd::run(dir, Mode::Read, &args)?;
    if out.not_repo() {
        return Ok(None);
    }
    if !out.ok() {
        return Err(gitcmd::failure("diff-tree", &out));
    }
    Ok(Some(out.stdout))
}

pub fn commit_files(root: &str, hash: &str) -> Result<Vec<CommitFile>, String> {
    let dir = root_dir(root)?;
    check_hash(hash)?;
    let Some(bytes) = commit_raw(&dir, hash, true)? else {
        return Ok(Vec::new());
    };
    let (raw, num) = parse_raw_numstat(&bytes);
    Ok(raw
        .into_iter()
        .map(|e| {
            let n = num.get(&e.path).cloned().unwrap_or(NumStat { additions: 0, deletions: 0, binary: false });
            CommitFile {
                path: e.path,
                orig_path: e.orig_path,
                status: e.status,
                additions: n.additions,
                deletions: n.deletions,
                binary: n.binary,
            }
        })
        .collect())
}

/// Result of parsing one file's patch.
#[derive(Debug, Default)]
pub struct ParsedPatch {
    /// A `diff --git` / `diff --cc` header was seen.
    pub has_file: bool,
    /// Status implied by the extended header lines.
    pub status: Option<FileStatus>,
    pub binary: bool,
    pub truncated: bool,
    pub hunks: Vec<DiffHunk>,
}

/// Parses "@@ -a[,b] +c[,d] @@" into (a, b, c, d).
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let end = rest.find(" @@")?;
    let mut parts = rest[..end].split(" +");
    let range = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (a, b) = range(parts.next()?)?;
    let (c, d) = range(parts.next()?)?;
    Some((a, b, c, d))
}

fn strip_eol(mut b: &[u8]) -> &[u8] {
    if let Some(x) = b.strip_suffix(b"\n") {
        b = x;
        if let Some(x) = b.strip_suffix(b"\r") {
            b = x;
        }
    }
    b
}

/// Streams a unified diff of a single file. Stops after `cap` lines (setting
/// `truncated`) or at the header of a second file. Returns (parsed, stopped early).
pub fn parse_patch(r: &mut dyn BufRead, cap: usize) -> std::io::Result<(ParsedPatch, bool)> {
    let mut p = ParsedPatch::default();
    let mut buf = Vec::with_capacity(256);
    let mut count = 0usize;
    // Lines still expected in the current hunk (old side, new side).
    let mut rem_old = 0u32;
    let mut rem_new = 0u32;
    let mut old_no = 0u32;
    let mut new_no = 0u32;
    let mut combined = false;
    loop {
        buf.clear();
        if r.read_until(b'\n', &mut buf)? == 0 {
            return Ok((p, false));
        }
        let line = strip_eol(&buf);
        let in_hunk = rem_old > 0 || rem_new > 0;
        if in_hunk {
            let (kind, text) = match line.first() {
                Some(b' ') => (LineKind::Ctx, &line[1..]),
                Some(b'+') => (LineKind::Add, &line[1..]),
                Some(b'-') => (LineKind::Del, &line[1..]),
                Some(b'\\') => continue, // "\ No newline at end of file"
                // Some configurations emit an empty context line as "".
                None => (LineKind::Ctx, &line[..0]),
                Some(_) => {
                    // Malformed: leave the hunk and treat the line as a header.
                    rem_old = 0;
                    rem_new = 0;
                    (LineKind::Ctx, &line[..0])
                }
            };
            if rem_old > 0 || rem_new > 0 {
                if count >= cap {
                    p.truncated = true;
                    return Ok((p, true));
                }
                count += 1;
                let (o, n) = match kind {
                    LineKind::Ctx => {
                        rem_old = rem_old.saturating_sub(1);
                        rem_new = rem_new.saturating_sub(1);
                        (Some(old_no), Some(new_no))
                    }
                    LineKind::Del => {
                        rem_old = rem_old.saturating_sub(1);
                        (Some(old_no), None)
                    }
                    LineKind::Add => {
                        rem_new = rem_new.saturating_sub(1);
                        (None, Some(new_no))
                    }
                };
                if o.is_some() {
                    old_no += 1;
                }
                if n.is_some() {
                    new_no += 1;
                }
                if let Some(h) = p.hunks.last_mut() {
                    h.lines.push(DiffLine { kind, old_no: o, new_no: n, text: lossy(text) });
                }
                continue;
            }
        }
        // Outside a hunk: file headers, extended headers, hunk headers.
        if line.starts_with(b"diff --git ") || line.starts_with(b"diff --cc ") || line.starts_with(b"diff --combined ") {
            if p.has_file {
                return Ok((p, true));
            }
            p.has_file = true;
            if !line.starts_with(b"diff --git ") {
                combined = true;
                p.status = Some(FileStatus::Unmerged);
            }
        } else if line.starts_with(b"* Unmerged path ") {
            p.has_file = true;
            p.status = Some(FileStatus::Unmerged);
        } else if line.starts_with(b"@@ ") && !combined {
            let s = lossy(line);
            if let Some((a, b, c, d)) = parse_hunk_header(&s) {
                rem_old = b;
                rem_new = d;
                // For an empty side git prints start 0; the first real line is 1.
                old_no = if b == 0 { a + 1 } else { a };
                new_no = if d == 0 { c + 1 } else { c };
                p.hunks.push(DiffHunk { header: s, lines: Vec::new() });
            }
        } else if line.starts_with(b"new file mode") {
            p.status = Some(FileStatus::Added);
        } else if line.starts_with(b"deleted file mode") {
            p.status = Some(FileStatus::Deleted);
        } else if line.starts_with(b"rename from ") {
            p.status = Some(FileStatus::Renamed);
        } else if line.starts_with(b"copy from ") {
            p.status = Some(FileStatus::Copied);
        } else if line.starts_with(b"Binary files ") || line.starts_with(b"GIT binary patch") {
            p.binary = true;
        }
    }
}

pub(crate) fn empty_diff(path: String, orig_path: Option<String>, status: FileStatus) -> FileDiff {
    FileDiff { path, orig_path, status, binary: false, truncated: false, hunks: Vec::new() }
}

/// Runs a patch-producing git command and parses it.
pub(crate) fn run_patch(dir: &Path, args: &[&str]) -> Result<Option<ParsedPatch>, String> {
    match gitcmd::stream(dir, args, |r| parse_patch(r, MAX_DIFF_LINES))? {
        Streamed::Done(p) => Ok(Some(p)),
        Streamed::NotRepo => Ok(None),
    }
}

pub(crate) fn not_repo_err() -> String {
    "not a git repository".to_string()
}

pub(crate) fn finish(path: String, orig_path: Option<String>, status: FileStatus, p: ParsedPatch) -> FileDiff {
    FileDiff { path, orig_path, status, binary: p.binary, truncated: p.truncated, hunks: p.hunks }
}

pub fn commit_file_diff(root: &str, hash: &str, path: &str) -> Result<FileDiff, String> {
    let dir = root_dir(root)?;
    check_hash(hash)?;
    let rel = clean_rel(path)?;
    // Raw pass (no content) to find the status and, for a rename, the old path:
    // filtering the patch by the new path alone would break rename pairing.
    let bytes = commit_raw(&dir, hash, false)?.ok_or_else(not_repo_err)?;
    let (raw, _) = parse_raw_numstat(&bytes);
    let entry = raw
        .into_iter()
        .find(|e| e.path == rel)
        .ok_or_else(|| format!("{rel} is not changed in commit {hash}"))?;
    let mut args: Vec<&str> = vec!["--literal-pathspecs", "diff-tree", "-p", "-U3"];
    args.extend(COMMIT_DIFF.iter().filter(|a| **a != "-z"));
    args.extend([hash, "--"]);
    if let Some(o) = &entry.orig_path {
        args.push(o);
    }
    args.push(&rel);
    let p = run_patch(&dir, &args)?.ok_or_else(not_repo_err)?;
    Ok(finish(entry.path, entry.orig_path, entry.status, p))
}

/// Options shared by the porcelain `git diff` calls.
pub(crate) const WORK_DIFF: [&str; 7] = ["-p", "-U3", "--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "-M"];

pub fn working_file_diff(root: &str, path: &str, staged: bool) -> Result<FileDiff, String> {
    let (abs, rel) = resolve(root, path)?;
    let dir = root_dir(root)?;
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    if staged {
        let out = gitcmd::run(&dir, Mode::Read, &["diff", "--cached", "--raw", "-z", "-M", "--no-relative"])?;
        if out.not_repo() {
            return Err(not_repo_err());
        }
        if !out.ok() {
            return Err(gitcmd::failure("diff", &out));
        }
        let (raw, _) = parse_raw_numstat(&out.stdout);
        let Some(entry) = raw.into_iter().find(|e| e.path == rel) else {
            return Ok(empty_diff(rel, None, FileStatus::Modified));
        };
        let mut args: Vec<&str> = vec!["--literal-pathspecs", "diff", "--cached"];
        args.extend(WORK_DIFF);
        args.push("--");
        if let Some(o) = &entry.orig_path {
            args.push(o);
        }
        args.push(&rel);
        let p = run_patch(&dir, &args)?.ok_or_else(not_repo_err)?;
        return Ok(finish(entry.path, entry.orig_path, entry.status, p));
    }

    let mut args: Vec<&str> = vec!["--literal-pathspecs", "diff"];
    args.extend(WORK_DIFF);
    args.extend(["--", rel.as_str()]);
    let p = run_patch(&dir, &args)?.ok_or_else(not_repo_err)?;
    if p.has_file {
        let status = p.status.unwrap_or(FileStatus::Modified);
        return Ok(finish(rel, None, status, p));
    }
    // No diff: either unchanged, or not in the index at all (untracked).
    let ls = gitcmd::run_ok(&dir, Mode::Read, &["--literal-pathspecs", "ls-files", "-z", "--", rel.as_str()])?;
    if !ls.stdout.is_empty() {
        return Ok(empty_diff(rel, None, FileStatus::Modified));
    }
    untracked_diff(&abs, rel)
}

/// Builds the diff of an untracked file: one hunk of added lines.
pub fn untracked_diff(abs: &Path, rel: String) -> Result<FileDiff, String> {
    let file = std::fs::File::open(abs).map_err(|e| format!("{rel}: {e}"))?;
    let mut r = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut d = empty_diff(rel, None, FileStatus::Untracked);

    // git's heuristic: a NUL byte in the first 8000 bytes means binary.
    let head = r.fill_buf().map_err(|e| e.to_string())?;
    if head[..head.len().min(8000)].contains(&0) {
        d.binary = true;
        return Ok(d);
    }
    let mut lines = Vec::new();
    let mut total = 0u32;
    let mut buf = Vec::new();
    loop {
        buf.clear();
        let n = r.read_until(b'\n', &mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += 1;
        if lines.len() < MAX_DIFF_LINES {
            lines.push(DiffLine {
                kind: LineKind::Add,
                old_no: None,
                new_no: Some(total),
                text: lossy(strip_eol(&buf)),
            });
        } else {
            d.truncated = true;
            // Keep counting so the header is right, without storing the lines.
            let mut rest = Vec::new();
            r.read_to_end(&mut rest).map_err(|e| e.to_string())?;
            let nl = rest.iter().filter(|b| **b == b'\n').count() as u32;
            total += nl + u32::from(!rest.is_empty() && !rest.ends_with(b"\n"));
            break;
        }
    }
    if total > 0 {
        let range = if total == 1 { "1".to_string() } else { format!("1,{total}") };
        d.hunks.push(DiffHunk { header: format!("@@ -0,0 +{range} @@"), lines });
    }
    Ok(d)
}
