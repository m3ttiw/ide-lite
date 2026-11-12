//! Workspace file system access: directory listing, quick-open file list,
//! reading and writing files.

use crate::gitcmd::{self, Mode, lossy, nul_tokens};
use crate::paths::{resolve, root_dir};
use crate::types::{DirEntry, EntryKind, Eol, FileContent};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

/// Files above this size are not loaded.
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// Cap of the non-repository walk in `list_files`.
pub const MAX_WALK_FILES: usize = 50_000;

pub fn list_dir(root: &str, dir: &str) -> Result<Vec<DirEntry>, String> {
    let (abs, rel) = resolve(root, dir)?;
    let rd = fs::read_dir(&abs).map_err(|e| format!("{}: {e}", if rel.is_empty() { "." } else { &rel }))?;
    let mut entries = Vec::new();
    for ent in rd {
        let Ok(ent) = ent else { continue };
        let name = ent.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let is_dir = match ent.file_type() {
            Ok(t) if t.is_symlink() => fs::metadata(ent.path()).map(|m| m.is_dir()).unwrap_or(false),
            Ok(t) => t.is_dir(),
            Err(_) => false,
        };
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        entries.push(DirEntry {
            name,
            path,
            kind: if is_dir { EntryKind::Dir } else { EntryKind::File },
            ignored: false,
        });
    }
    entries.sort_by(|a, b| {
        (a.kind != EntryKind::Dir)
            .cmp(&(b.kind != EntryKind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    mark_ignored(&root_dir(root)?, &mut entries)?;
    Ok(entries)
}

/// Sets `ignored` with a single `git check-ignore --stdin` call.
/// Outside a repository (or if git cannot answer) everything stays false.
fn mark_ignored(root: &Path, entries: &mut [DirEntry]) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let mut input = Vec::new();
    for e in entries.iter() {
        input.extend_from_slice(e.path.as_bytes());
        input.push(0);
    }
    let out = gitcmd::run_input(root, Mode::Read, &["check-ignore", "-z", "--stdin"], input)?;
    // 0: some paths ignored, 1: none, anything else: not a repo / not applicable.
    if out.code != Some(0) {
        return Ok(());
    }
    let ignored: HashSet<String> = nul_tokens(&out.stdout).map(lossy).collect();
    for e in entries.iter_mut() {
        e.ignored = ignored.contains(&e.path);
    }
    Ok(())
}

pub fn list_files(root: &str) -> Result<Vec<String>, String> {
    let dir = root_dir(root)?;
    // -c tracked, -o untracked (minus ignored), -d deleted; -t tags each line
    // so files deleted from disk ("R") can be dropped.
    let out = gitcmd::run(
        &dir,
        Mode::Read,
        &["ls-files", "-z", "-t", "--cached", "--others", "--deleted", "--exclude-standard"],
    )?;
    if out.ok() {
        let mut deleted = HashSet::new();
        let mut items = Vec::new();
        for tok in nul_tokens(&out.stdout) {
            if tok.len() < 3 || tok[1] != b' ' {
                continue;
            }
            let path = &tok[2..];
            if tok[0] == b'R' {
                deleted.insert(path);
            } else if !path.ends_with(b"/") {
                items.push(path);
            }
        }
        let mut seen = HashSet::new();
        let files = items
            .into_iter()
            .filter(|p| !deleted.contains(p) && seen.insert(*p))
            .map(lossy)
            .collect();
        return Ok(files);
    }
    if !out.not_repo() {
        return Err(gitcmd::failure("ls-files", &out));
    }
    Ok(walk(&dir, MAX_WALK_FILES))
}

/// Recursive walk for folders outside a repository: skips dot-folders and
/// does not follow directory symlinks.
pub fn walk(root: &Path, cap: usize) -> Vec<String> {
    let mut files = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((abs, rel)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&abs) else { continue };
        let mut subdirs = Vec::new();
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(t) = ent.file_type() else { continue };
            let is_file = if t.is_symlink() {
                fs::metadata(ent.path()).map(|m| m.is_file()).unwrap_or(false)
            } else {
                t.is_file()
            };
            if t.is_dir() {
                if !name.starts_with('.') {
                    subdirs.push((ent.path(), child_rel));
                }
            } else if is_file {
                files.push(child_rel);
                if files.len() >= cap {
                    return files;
                }
            }
        }
        // Reverse so the stack pops subfolders in directory order.
        stack.extend(subdirs.into_iter().rev());
    }
    files
}

/// Dominant line ending: CRLF only when it outnumbers bare LF.
pub fn detect_eol(bytes: &[u8]) -> Eol {
    let mut crlf = 0usize;
    let mut lf = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    if crlf > lf { Eol::Crlf } else { Eol::Lf }
}

pub fn read_file(root: &str, path: &str) -> Result<FileContent, String> {
    let (abs, rel) = resolve(root, path)?;
    let meta = fs::metadata(&abs).map_err(|e| format!("{rel}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("{rel}: is a directory"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Ok(FileContent { text: String::new(), binary: false, too_large: true, eol: Eol::Lf });
    }
    let bytes = fs::read(&abs).map_err(|e| format!("{rel}: {e}"))?;
    let eol = detect_eol(&bytes);
    if bytes.contains(&0) {
        return Ok(FileContent { text: String::new(), binary: true, too_large: false, eol });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent { text, binary: false, too_large: false, eol }),
        Err(_) => Ok(FileContent { text: String::new(), binary: true, too_large: false, eol }),
    }
}

pub fn write_file(root: &str, path: &str, text: &str) -> Result<(), String> {
    let (abs, rel) = resolve(root, path)?;
    if rel.is_empty() {
        return Err("path is empty".into());
    }
    if abs.is_dir() {
        return Err(format!("{rel}: is a directory"));
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("{rel}: {e}"))?;
    }
    fs::write(&abs, text.as_bytes()).map_err(|e| format!("{rel}: {e}"))
}
