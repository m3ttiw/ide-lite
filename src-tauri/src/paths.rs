//! Path conventions shared by every command.
//!
//! - Absolute paths returned to the UI use forward slashes and never carry the
//!   Windows verbatim prefix (`\\?\`) that `canonicalize` produces.
//! - Relative paths (`path` / `dir`) are validated so they cannot leave `root`.

use std::path::{Path, PathBuf};

/// Forward-slash form of an absolute path, without the `\\?\` / `\\?\UNC\` prefix.
pub fn to_slash(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    };
    s.replace('\\', "/")
}

/// Canonical forward-slash form when the path exists, plain conversion otherwise.
pub fn canonical_slash(p: &Path) -> String {
    match p.canonicalize() {
        Ok(c) => to_slash(&c),
        Err(_) => to_slash(p),
    }
}

/// Validates `root` (an absolute folder passed by the UI) and returns it as a path.
pub fn root_dir(root: &str) -> Result<PathBuf, String> {
    if root.is_empty() {
        return Err("root is empty".into());
    }
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    Ok(p)
}

/// Normalizes a relative path (`a\b`, `./a//b/` -> `a/b`) and rejects anything
/// that could address a location outside the root: `..`, absolute paths,
/// drive prefixes, NUL bytes, and (on Windows) `:` and all-dot names.
pub fn clean_rel(rel: &str) -> Result<String, String> {
    let bad = || Err(format!("invalid relative path: {rel:?}"));
    if rel.contains('\0') {
        return bad();
    }
    let s = rel.replace('\\', "/");
    if s.starts_with('/') {
        return bad();
    }
    let mut out: Vec<&str> = Vec::new();
    for seg in s.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return bad();
        }
        // Drive prefix such as `C:` in the first segment, on every platform.
        if out.is_empty() {
            let b = seg.as_bytes();
            if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
                return bad();
            }
        }
        if cfg!(windows) {
            // `:` would be a drive or an alternate data stream; Win32 strips
            // trailing dots and spaces, so `...` or `.. ` would act as `..`.
            if seg.contains(':') || seg.trim_end_matches([' ', '.']).is_empty() {
                return bad();
            }
        }
        out.push(seg);
    }
    Ok(out.join("/"))
}

/// Joins a validated relative path onto `root`. Returns the absolute path and
/// the normalized relative form.
pub fn resolve(root: &str, rel: &str) -> Result<(PathBuf, String), String> {
    let base = root_dir(root)?;
    let clean = clean_rel(rel)?;
    let mut p = base;
    if !clean.is_empty() {
        for seg in clean.split('/') {
            p.push(seg);
        }
    }
    Ok((p, clean))
}

/// Key used to compare two absolute paths for equality / containment.
pub fn compare_key(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.pop();
    }
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// `inner` equals `outer` or lies below it (both already `compare_key`ed).
pub fn is_within(inner: &str, outer: &str) -> bool {
    if inner == outer {
        return true;
    }
    match inner.strip_prefix(outer) {
        Some(rest) => rest.starts_with('/') || outer.ends_with('/'),
        None => false,
    }
}
