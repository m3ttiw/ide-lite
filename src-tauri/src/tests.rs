//! Behaviour tests against real repositories built with the `git` CLI in
//! temporary folders.

use crate::paths::{canonical_slash, clean_rel, to_slash};
use crate::types::*;
use crate::{diff, fsops, git, repos, update, worktree};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

// ---------------------------------------------------------------- helpers

static CLOCK: AtomicU64 = AtomicU64::new(0);

/// Runs a real git command in `dir`, panicking on failure; returns trimmed stdout.
fn g(dir: &Path, args: &[&str]) -> String {
    // Strictly increasing dates keep --date-order deterministic.
    let t = 1_700_000_000 + CLOCK.fetch_add(1, Ordering::SeqCst) * 60;
    let date = format!("{t} +0000");
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .env("LC_ALL", "C")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    g(dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("core.autocrlf", "false"),
        ("core.safecrlf", "false"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
    ] {
        g(dir, &["config", k, v]);
    }
}

fn new_repo() -> (TempDir, PathBuf, String) {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("repo");
    init_repo(&dir);
    let root = to_slash(&dir);
    (tmp, dir, root)
}

fn write(dir: &Path, rel: &str, content: impl AsRef<[u8]>) {
    let p = dir.join(rel);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(p, content).unwrap();
}

/// Stages everything and commits; returns the new HEAD hash.
fn commit_all(dir: &Path, msg: &str) -> String {
    g(dir, &["add", "-A"]);
    g(dir, &["commit", "-q", "-m", msg]);
    g(dir, &["rev-parse", "HEAD"])
}

fn numbered_lines(n: usize) -> String {
    (1..=n).map(|i| format!("line {i}\n")).collect()
}

fn find<'a>(files: &'a [CommitFile], path: &str) -> &'a CommitFile {
    files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} not in {files:?}"))
}

fn all_lines(d: &FileDiff) -> Vec<&DiffLine> {
    d.hunks.iter().flat_map(|h| h.lines.iter()).collect()
}

// ---------------------------------------------------------------- contract

fn keys(v: &serde_json::Value) -> Vec<String> {
    let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
    k.sort();
    k
}

fn expect_keys<T: serde::Serialize>(value: &T, expected: &[&str]) -> serde_json::Value {
    let v = serde_json::to_value(value).unwrap();
    let mut e: Vec<String> = expected.iter().map(|s| s.to_string()).collect();
    e.sort();
    assert_eq!(keys(&v), e, "keys of {v}");
    v
}

#[test]
fn contract_json_shapes() {
    let v = expect_keys(
        &DirEntry { name: "a".into(), path: "d/a".into(), kind: EntryKind::Dir, ignored: true },
        &["name", "path", "kind", "ignored"],
    );
    assert_eq!(v["kind"], "dir");
    assert_eq!(serde_json::to_value(EntryKind::File).unwrap(), "file");

    let v = expect_keys(
        &FileContent { text: String::new(), binary: false, too_large: true, eol: Eol::Crlf },
        &["text", "binary", "tooLarge", "eol"],
    );
    assert_eq!(v["eol"], "crlf");
    assert_eq!(serde_json::to_value(Eol::Lf).unwrap(), "lf");

    let v = expect_keys(
        &RepoInfo {
            root: "C:/r".into(),
            is_repo: true,
            branch: None,
            head: None,
            upstream: Some("origin/main".into()),
            ahead: 1,
            behind: 2,
        },
        &["root", "isRepo", "branch", "head", "upstream", "ahead", "behind"],
    );
    assert!(v["branch"].is_null());

    let v = expect_keys(
        &StatusEntry {
            path: "b".into(),
            orig_path: Some("a".into()),
            index: Some(FileStatus::Renamed),
            worktree: Some(FileStatus::Untracked),
        },
        &["path", "origPath", "index", "worktree"],
    );
    assert_eq!(v["index"], "R");
    assert_eq!(v["worktree"], "?");
    let codes: Vec<serde_json::Value> = [
        FileStatus::Modified,
        FileStatus::Added,
        FileStatus::Deleted,
        FileStatus::Renamed,
        FileStatus::Copied,
        FileStatus::Unmerged,
        FileStatus::Untracked,
    ]
    .iter()
    .map(|s| serde_json::to_value(s).unwrap())
    .collect();
    assert_eq!(codes, ["M", "A", "D", "R", "C", "U", "?"]);

    let r = CommitRef { name: "v1".into(), kind: RefKind::Tag };
    let v = expect_keys(&r, &["name", "kind"]);
    assert_eq!(v["kind"], "tag");
    assert_eq!(serde_json::to_value(RefKind::Branch).unwrap(), "branch");
    assert_eq!(serde_json::to_value(RefKind::Remote).unwrap(), "remote");

    expect_keys(
        &Commit {
            hash: "h".into(),
            parents: vec![],
            subject: "s".into(),
            author: "a".into(),
            date: 1,
            is_head: true,
            refs: vec![r],
        },
        &["hash", "parents", "subject", "author", "date", "isHead", "refs"],
    );

    expect_keys(
        &CommitFile {
            path: "p".into(),
            orig_path: None,
            status: FileStatus::Modified,
            additions: 1,
            deletions: 0,
            binary: false,
        },
        &["path", "origPath", "status", "additions", "deletions", "binary"],
    );

    let line = DiffLine { kind: LineKind::Add, old_no: None, new_no: Some(1), text: "x".into() };
    let v = expect_keys(&line, &["kind", "oldNo", "newNo", "text"]);
    assert_eq!(v["kind"], "add");
    assert_eq!(serde_json::to_value(LineKind::Ctx).unwrap(), "ctx");
    assert_eq!(serde_json::to_value(LineKind::Del).unwrap(), "del");
    let hunk = DiffHunk { header: "@@ -0,0 +1 @@".into(), lines: vec![line] };
    expect_keys(&hunk, &["header", "lines"]);
    expect_keys(
        &FileDiff {
            path: "p".into(),
            orig_path: None,
            status: FileStatus::Added,
            binary: false,
            truncated: false,
            hunks: vec![hunk],
        },
        &["path", "origPath", "status", "binary", "truncated", "hunks"],
    );

    expect_keys(
        &Worktree {
            path: "C:/r".into(),
            branch: None,
            head: "h".into(),
            is_main: true,
            is_current: false,
            detached: true,
            locked: false,
            prunable: false,
        },
        &["path", "branch", "head", "isMain", "isCurrent", "detached", "locked", "prunable"],
    );
    expect_keys(&WorktreeStatus { ahead: 0, behind: 0, dirty: 0 }, &["ahead", "behind", "dirty"]);

    expect_keys(
        &RepoEntry { path: "C:/p/r".into(), rel_path: "r".into(), branch: None, linked: true },
        &["path", "relPath", "branch", "linked"],
    );
    let folder = FolderEntry { name: "r".into(), path: "C:/p/r".into(), is_repo: true, branch: Some("main".into()) };
    expect_keys(&folder, &["name", "path", "isRepo", "branch"]);
    let v = expect_keys(
        &FolderListing { path: String::new(), parent: None, dirs: vec![folder] },
        &["path", "parent", "dirs"],
    );
    assert!(v["parent"].is_null());
}

// ---------------------------------------------------------------- paths

#[test]
fn rel_paths_are_normalized_and_confined() {
    assert_eq!(clean_rel("").unwrap(), "");
    assert_eq!(clean_rel("a\\b/./c//").unwrap(), "a/b/c");
    assert_eq!(clean_rel("dir with space/ü.txt").unwrap(), "dir with space/ü.txt");
    for bad in ["..", "../x", "a/../../b", "a/..", "/etc/passwd", "\\x", "C:/x", "c:x", "a\0b"] {
        assert!(clean_rel(bad).is_err(), "{bad:?} must be rejected");
    }
    if cfg!(windows) {
        for bad in ["a/...", "a/.. ", "file.txt:stream"] {
            assert!(clean_rel(bad).is_err(), "{bad:?} must be rejected");
        }
    }
}

#[test]
fn absolute_paths_use_forward_slashes_without_verbatim_prefix() {
    assert_eq!(to_slash(Path::new(r"\\?\C:\Users\me\repo")), "C:/Users/me/repo");
    assert_eq!(to_slash(Path::new(r"\\?\UNC\server\share\x")), "//server/share/x");
    let tmp = TempDir::new().unwrap();
    let c = canonical_slash(tmp.path());
    assert!(!c.contains('\\') && !c.starts_with("//?/"), "{c}");
}

#[test]
fn initial_root_is_the_dir_argument_else_the_home_folder() {
    let tmp = TempDir::new().unwrap();
    let home = TempDir::new().unwrap();
    let h = || Some(home.path().to_path_buf());
    let got = crate::initial_root_impl(Some(tmp.path().as_os_str().to_owned()), h()).unwrap();
    assert_eq!(got, canonical_slash(tmp.path()));
    // no folder asked for (Start menu), or one that does not exist: the home folder
    let missing = tmp.path().join("nope");
    assert_eq!(crate::initial_root_impl(Some(missing.into_os_string()), h()).unwrap(), canonical_slash(home.path()));
    assert_eq!(crate::initial_root_impl(None, h()).unwrap(), canonical_slash(home.path()));
    // no usable home folder either: the current directory
    let cwd = canonical_slash(&std::env::current_dir().unwrap());
    assert_eq!(crate::initial_root_impl(None, None).unwrap(), cwd);
    assert_eq!(crate::initial_root_impl(None, Some(tmp.path().join("gone"))).unwrap(), cwd);
}

#[test]
fn home_folder_is_the_user_profile() {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    assert_eq!(crate::home_folder(), std::env::var_os(var).map(std::path::PathBuf::from));
}

#[test]
fn launch_folder_is_only_an_existing_dir_argument() {
    let tmp = TempDir::new().unwrap();
    let got = crate::launch_folder_impl(Some(tmp.path().as_os_str().to_owned()));
    assert_eq!(got, Some(canonical_slash(tmp.path())));
    // no argument, a missing path, a file: the app was not asked to open a folder
    assert_eq!(crate::launch_folder_impl(None), None);
    assert_eq!(crate::launch_folder_impl(Some(tmp.path().join("nope").into_os_string())), None);
    let file = tmp.path().join("a.txt");
    std::fs::write(&file, "x").unwrap();
    assert_eq!(crate::launch_folder_impl(Some(file.into_os_string())), None);
}

// ---------------------------------------------------------------- fs

#[test]
fn list_dir_orders_hides_git_and_flags_ignored() {
    let (_t, dir, root) = new_repo();
    write(&dir, ".gitignore", "*.log\nbuild/\n");
    write(&dir, "b.txt", "b");
    write(&dir, "A.txt", "a");
    write(&dir, "c.log", "log");
    write(&dir, "zdir/x.txt", "x");
    write(&dir, "Bdir/y.txt", "y");
    write(&dir, "build/out.bin", "o");
    write(&dir, "build/deep/z.txt", "z");
    write(&dir, "dir sp ü/f ü.txt", "f");
    commit_all(&dir, "init");

    let list = fsops::list_dir(&root, "").unwrap();
    let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["Bdir", "build", "dir sp ü", "zdir", ".gitignore", "A.txt", "b.txt", "c.log"]);
    let kinds: Vec<EntryKind> = list.iter().map(|e| e.kind).collect();
    assert_eq!(&kinds[..4], &[EntryKind::Dir; 4]);
    let ignored: Vec<&str> = list.iter().filter(|e| e.ignored).map(|e| e.name.as_str()).collect();
    assert_eq!(ignored, ["build", "c.log"]);
    assert_eq!(list[0].path, "Bdir");

    let sub = fsops::list_dir(&root, "build").unwrap();
    assert_eq!(sub.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["build/deep", "build/out.bin"]);
    assert!(sub.iter().all(|e| e.ignored), "children of an ignored folder are ignored");

    let sub = fsops::list_dir(&root, "dir sp ü\\").unwrap();
    assert_eq!(sub[0].path, "dir sp ü/f ü.txt");
    assert!(!sub[0].ignored);
}

#[test]
fn read_file_reports_eol_binary_and_size() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    let root = to_slash(dir);
    write(dir, "lf.txt", "a\nb\n");
    write(dir, "crlf.txt", "a\r\nb\r\nc\n");
    write(dir, "nul.bin", b"ab\0cd");
    write(dir, "latin1.txt", b"caf\xe9\n");
    write(dir, "empty.txt", "");
    write(dir, "big.txt", vec![b'a'; fsops::MAX_FILE_BYTES as usize + 1]);
    write(dir, "edge.txt", vec![b'a'; fsops::MAX_FILE_BYTES as usize]);

    let f = fsops::read_file(&root, "lf.txt").unwrap();
    assert_eq!((f.text.as_str(), f.eol, f.binary, f.too_large), ("a\nb\n", Eol::Lf, false, false));
    let f = fsops::read_file(&root, "crlf.txt").unwrap();
    assert_eq!((f.text.as_str(), f.eol), ("a\r\nb\r\nc\n", Eol::Crlf));
    let f = fsops::read_file(&root, "nul.bin").unwrap();
    assert!(f.binary && f.text.is_empty());
    let f = fsops::read_file(&root, "latin1.txt").unwrap();
    assert!(f.binary && f.text.is_empty());
    let f = fsops::read_file(&root, "empty.txt").unwrap();
    assert_eq!((f.text.as_str(), f.eol, f.binary), ("", Eol::Lf, false));
    let f = fsops::read_file(&root, "big.txt").unwrap();
    assert!(f.too_large && f.text.is_empty() && !f.binary);
    let f = fsops::read_file(&root, "edge.txt").unwrap();
    assert!(!f.too_large && f.text.len() == fsops::MAX_FILE_BYTES as usize);
    assert!(fsops::read_file(&root, "missing.txt").is_err());
}

#[test]
fn write_file_round_trips_exact_text() {
    let tmp = TempDir::new().unwrap();
    let root = to_slash(tmp.path());
    let text = "héllo\r\nwörld\nno newline ✓";
    fsops::write_file(&root, "new dir/ü file.txt", text).unwrap();
    assert_eq!(std::fs::read(tmp.path().join("new dir").join("ü file.txt")).unwrap(), text.as_bytes());
    let f = fsops::read_file(&root, "new dir/ü file.txt").unwrap();
    assert_eq!(f.text, text);
    fsops::write_file(&root, "new dir/ü file.txt", "").unwrap();
    assert_eq!(fsops::read_file(&root, "new dir/ü file.txt").unwrap().text, "");
}

#[test]
fn relative_paths_cannot_escape_root() {
    let tmp = TempDir::new().unwrap();
    let inner = tmp.path().join("inner");
    std::fs::create_dir_all(&inner).unwrap();
    write(tmp.path(), "secret.txt", "s");
    let root = to_slash(&inner);
    let abs = to_slash(&tmp.path().join("secret.txt"));
    for bad in ["../secret.txt", "a/../../secret.txt", abs.as_str(), "/secret.txt"] {
        assert!(fsops::read_file(&root, bad).is_err(), "read {bad}");
        assert!(fsops::write_file(&root, bad, "x").is_err(), "write {bad}");
        assert!(fsops::list_dir(&root, bad).is_err(), "list {bad}");
        assert!(diff::working_file_diff(&root, bad, false).is_err(), "diff {bad}");
    }
    assert_eq!(std::fs::read_to_string(tmp.path().join("secret.txt")).unwrap(), "s");
}

#[test]
fn non_repo_folder_behaviour() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("plain ü");
    write(&dir, "a.txt", "a");
    write(&dir, "sub/b.txt", "b");
    write(&dir, ".hidden/c.txt", "c");
    write(&dir, ".env", "e");
    let root = to_slash(&dir);

    let info = git::repo_info(&root).unwrap();
    assert!(!info.is_repo);
    assert_eq!(info.root, canonical_slash(&dir));
    assert_eq!((info.branch, info.head, info.upstream, info.ahead, info.behind), (None, None, None, 0, 0));
    assert!(git::git_status(&root).unwrap().is_empty());
    assert!(git::git_log(&root, 0, 50, true).unwrap().is_empty());
    assert!(diff::commit_files(&root, "0123456789abcdef0123456789abcdef01234567").unwrap().is_empty());
    assert!(worktree::list_worktrees(&root).unwrap().is_empty());
    assert!(fsops::list_dir(&root, "").unwrap().iter().all(|e| !e.ignored));

    let mut files = fsops::list_files(&root).unwrap();
    files.sort();
    assert_eq!(files, [".env", "a.txt", "sub/b.txt"]);
    assert_eq!(fsops::walk(&dir, 2).len(), 2, "walk stops at the cap");
}

#[test]
fn list_files_in_repo_tracked_plus_untracked_minus_ignored() {
    let (_t, dir, root) = new_repo();
    write(&dir, ".gitignore", "*.log\n");
    write(&dir, "tracked.txt", "t");
    write(&dir, "gone.txt", "g");
    write(&dir, "sub dir/ü.txt", "u");
    commit_all(&dir, "init");
    write(&dir, "untracked new.txt", "n");
    write(&dir, "x.log", "ignored");
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    let mut files = fsops::list_files(&root).unwrap();
    files.sort();
    assert_eq!(files, [".gitignore", "sub dir/ü.txt", "tracked.txt", "untracked new.txt"]);
}

// ---------------------------------------------------------------- repo info / status

#[test]
fn repo_info_branch_head_upstream() {
    let (tmp, dir, root) = new_repo();
    let info = git::repo_info(&root).unwrap();
    assert!(info.is_repo);
    assert_eq!(info.branch.as_deref(), Some("main"));
    assert_eq!(info.head, None, "no commits yet");

    write(&dir, "a.txt", "1");
    let c1 = commit_all(&dir, "one");
    // A subfolder resolves to the worktree root.
    write(&dir, "sub/x.txt", "x");
    let info = git::repo_info(&to_slash(&dir.join("sub"))).unwrap();
    assert_eq!(info.root, canonical_slash(&dir));
    assert_eq!(info.head.as_deref(), Some(c1.as_str()));
    assert_eq!(info.upstream, None);

    let clone = tmp.path().join("clone");
    g(tmp.path(), &["clone", "-q", &to_slash(&dir), &to_slash(&clone)]);
    for (k, v) in [("user.name", "C"), ("user.email", "c@x"), ("commit.gpgsign", "false")] {
        g(&clone, &["config", k, v]);
    }
    write(&clone, "b.txt", "b");
    commit_all(&clone, "local");
    write(&dir, "a.txt", "2");
    commit_all(&dir, "upstream 1");
    write(&dir, "a.txt", "3");
    commit_all(&dir, "upstream 2");
    g(&clone, &["fetch", "-q"]);
    let info = git::repo_info(&to_slash(&clone)).unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (1, 2));

    g(&dir, &["checkout", "-q", "--detach", &c1]);
    let info = git::repo_info(&root).unwrap();
    assert_eq!(info.branch, None);
    assert_eq!(info.head.as_deref(), Some(c1.as_str()));
}

#[test]
fn status_staged_unstaged_untracked_rename_delete() {
    let (_t, dir, root) = new_repo();
    write(&dir, "staged.txt", "1\n");
    write(&dir, "unstaged.txt", "1\n");
    write(&dir, "both.txt", "1\n");
    write(&dir, "old name.txt", numbered_lines(20));
    write(&dir, "del work.txt", "d\n");
    write(&dir, "del index.txt", "d\n");
    write(&dir, "dir ü/tracked é.txt", "1\n");
    commit_all(&dir, "init");

    write(&dir, "staged.txt", "2\n");
    g(&dir, &["add", "staged.txt"]);
    write(&dir, "unstaged.txt", "2\n");
    write(&dir, "both.txt", "2\n");
    g(&dir, &["add", "both.txt"]);
    write(&dir, "both.txt", "3\n");
    g(&dir, &["mv", "old name.txt", "new name ü.txt"]);
    std::fs::remove_file(dir.join("del work.txt")).unwrap();
    g(&dir, &["rm", "-q", "del index.txt"]);
    write(&dir, "dir ü/tracked é.txt", "2\n");
    write(&dir, "new dir/a b/ünï cødé.txt", "u");
    write(&dir, "new dir/second.txt", "u");

    let st = git::git_status(&root).unwrap();
    let get = |p: &str| st.iter().find(|e| e.path == p).unwrap_or_else(|| panic!("{p} missing in {st:?}"));
    use FileStatus::*;
    assert_eq!((get("staged.txt").index, get("staged.txt").worktree), (Some(Modified), None));
    assert_eq!((get("unstaged.txt").index, get("unstaged.txt").worktree), (None, Some(Modified)));
    assert_eq!((get("both.txt").index, get("both.txt").worktree), (Some(Modified), Some(Modified)));
    let r = get("new name ü.txt");
    assert_eq!((r.index, r.worktree, r.orig_path.as_deref()), (Some(Renamed), None, Some("old name.txt")));
    assert_eq!(get("del work.txt").worktree, Some(Deleted));
    assert_eq!(get("del index.txt").index, Some(Deleted));
    assert_eq!(get("dir ü/tracked é.txt").worktree, Some(Modified));
    // --untracked-files=all: each untracked file individually.
    let u = get("new dir/a b/ünï cødé.txt");
    assert_eq!((u.index, u.worktree, u.orig_path.clone()), (None, Some(Untracked), None));
    assert_eq!(get("new dir/second.txt").worktree, Some(Untracked));
    assert_eq!(st.len(), 9, "{st:?}");
    assert!(st.iter().filter(|e| e.path != "new name ü.txt").all(|e| e.orig_path.is_none()));
}

#[test]
fn status_unmerged_conflict() {
    let (_t, dir, root) = new_repo();
    write(&dir, "c.txt", "base\n");
    commit_all(&dir, "base");
    g(&dir, &["checkout", "-q", "-b", "other"]);
    write(&dir, "c.txt", "other\n");
    commit_all(&dir, "other");
    g(&dir, &["checkout", "-q", "main"]);
    write(&dir, "c.txt", "main\n");
    commit_all(&dir, "main");
    let out = Command::new("git").current_dir(&dir).args(["merge", "-q", "other"]).output().unwrap();
    assert!(!out.status.success());
    let st = git::git_status(&root).unwrap();
    assert_eq!(st.len(), 1);
    assert_eq!((st[0].index, st[0].worktree), (Some(FileStatus::Unmerged), Some(FileStatus::Unmerged)));
    let d = diff::working_file_diff(&root, "c.txt", false).unwrap();
    assert_eq!(d.status, FileStatus::Unmerged);
}

// ---------------------------------------------------------------- log

struct History {
    c1: String,
    c2: String,
    c3: String,
    c4: String,
    merge: String,
    side: String,
}

fn build_history(dir: &Path) -> History {
    write(dir, "f.txt", "1\n");
    let c1 = commit_all(dir, "c1 root");
    write(dir, "f.txt", "2\n");
    let c2 = commit_all(dir, "c2");
    g(dir, &["tag", "-a", "v1.0", "-m", "release"]);
    g(dir, &["tag", "light", &c1]);
    g(dir, &["checkout", "-q", "-b", "feat"]);
    write(dir, "feat.txt", "feat\n");
    let c3 = commit_all(dir, "c3 on feat");
    g(dir, &["checkout", "-q", "main"]);
    write(dir, "main.txt", "main\n");
    let c4 = commit_all(dir, "c4 on main");
    g(dir, &["merge", "-q", "--no-ff", "-m", "merge feat", "feat"]);
    let merge = g(dir, &["rev-parse", "HEAD"]);
    g(dir, &["update-ref", "refs/remotes/origin/main", &c4]);
    g(dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    g(dir, &["checkout", "-q", "-b", "side", &c1]);
    write(dir, "side.txt", "side\n");
    let side = commit_all(dir, "side work");
    g(dir, &["checkout", "-q", "main"]);
    // A stash is not part of "all" history.
    write(dir, "f.txt", "stash me\n");
    g(dir, &["stash", "-q"]);
    History { c1, c2, c3, c4, merge, side }
}

#[test]
fn log_parents_refs_head_and_scope() {
    let (_t, dir, root) = new_repo();
    let h = build_history(&dir);

    let head_only = git::git_log(&root, 0, 100, false).unwrap();
    let hashes: Vec<&str> = head_only.iter().map(|c| c.hash.as_str()).collect();
    assert_eq!(hashes, [&h.merge, &h.c4, &h.c3, &h.c2, &h.c1].map(String::as_str));

    let all = git::git_log(&root, 0, 100, true).unwrap();
    assert_eq!(all.len(), 6, "{all:#?}");
    assert!(all.iter().any(|c| c.hash == h.side));
    assert!(all.iter().all(|c| !c.subject.starts_with("WIP on") && !c.subject.starts_with("index on")));

    // Children always before parents.
    for (i, c) in all.iter().enumerate() {
        for p in &c.parents {
            let j = all.iter().position(|x| &x.hash == p).unwrap();
            assert!(j > i, "parent {p} listed before child {}", c.hash);
        }
    }

    let by = |hash: &str| all.iter().find(|c| c.hash == hash).unwrap();
    let m = by(&h.merge);
    assert_eq!(m.parents, [h.c4.clone(), h.c3.clone()], "first parent first");
    assert_eq!(m.subject, "merge feat");
    assert_eq!(m.author, "Test User");
    assert!(m.date > 1_700_000_000);
    assert!(m.is_head);
    assert_eq!(m.refs, [CommitRef { name: "main".into(), kind: RefKind::Branch }]);
    assert!(by(&h.c1).parents.is_empty());
    assert_eq!(by(&h.c1).refs, [CommitRef { name: "light".into(), kind: RefKind::Tag }]);
    assert_eq!(by(&h.c2).refs, [CommitRef { name: "v1.0".into(), kind: RefKind::Tag }]);
    assert_eq!(by(&h.c3).refs, [CommitRef { name: "feat".into(), kind: RefKind::Branch }]);
    assert_eq!(
        by(&h.c4).refs,
        [CommitRef { name: "origin/main".into(), kind: RefKind::Remote }],
        "origin/HEAD alias is dropped"
    );
    assert_eq!(by(&h.side).refs, [CommitRef { name: "side".into(), kind: RefKind::Branch }]);
    assert_eq!(all.iter().filter(|c| c.is_head).count(), 1);

    // Detached HEAD.
    g(&dir, &["checkout", "-q", "--detach", &h.c2]);
    let all = git::git_log(&root, 0, 100, true).unwrap();
    let heads: Vec<&str> = all.iter().filter(|c| c.is_head).map(|c| c.hash.as_str()).collect();
    assert_eq!(heads, [h.c2.as_str()]);
    let only = git::git_log(&root, 0, 100, false).unwrap();
    assert_eq!(only.iter().map(|c| c.hash.as_str()).collect::<Vec<_>>(), [&h.c2, &h.c1].map(String::as_str));
}

#[test]
fn log_pagination_is_consistent() {
    let (_t, dir, root) = new_repo();
    build_history(&dir);
    for i in 0..5 {
        write(&dir, "more.txt", format!("{i}\n"));
        commit_all(&dir, &format!("more {i}"));
    }
    for all in [false, true] {
        let full = git::git_log(&root, 0, 1000, all).unwrap();
        let mut paged = Vec::new();
        let mut skip = 0;
        loop {
            let page = git::git_log(&root, skip, 3, all).unwrap();
            assert!(page.len() <= 3);
            if page.is_empty() {
                break;
            }
            skip += page.len() as u32;
            paged.extend(page);
        }
        assert_eq!(paged, full);
    }
    assert!(git::git_log(&root, 0, 0, true).unwrap().is_empty());
    assert!(git::git_log(&root, 10_000, 10, true).unwrap().is_empty());
}

#[test]
fn log_of_repo_without_commits_is_empty() {
    let (_t, _dir, root) = new_repo();
    assert!(git::git_log(&root, 0, 10, false).unwrap().is_empty());
    assert!(git::git_log(&root, 0, 10, true).unwrap().is_empty());
    assert!(git::git_status(&root).unwrap().is_empty());
}

// ---------------------------------------------------------------- commit files / diffs

#[test]
fn commit_files_and_diffs() {
    let (_t, dir, root) = new_repo();
    write(&dir, "keep.txt", numbered_lines(10));
    write(&dir, "to rename.txt", numbered_lines(30));
    write(&dir, "to delete.txt", "x\ny\n");
    write(&dir, "img.bin", b"\x00\x01\x02binary");
    write(&dir, "nonl.txt", "a\nb");
    let root_commit = commit_all(&dir, "root");

    // Root commit: everything added, compared with the empty tree.
    let files = diff::commit_files(&root, &root_commit).unwrap();
    assert_eq!(files.len(), 5);
    assert!(files.iter().all(|f| f.status == FileStatus::Added));
    let k = find(&files, "keep.txt");
    assert_eq!((k.additions, k.deletions, k.binary), (10, 0, false));
    let b = find(&files, "img.bin");
    assert_eq!((b.additions, b.deletions, b.binary), (0, 0, true));
    let d = diff::commit_file_diff(&root, &root_commit, "keep.txt").unwrap();
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.hunks[0].header, "@@ -0,0 +1,10 @@");
    let lines = all_lines(&d);
    assert_eq!(lines.len(), 10);
    assert!(lines.iter().enumerate().all(|(i, l)| l.kind == LineKind::Add
        && l.old_no.is_none()
        && l.new_no == Some(i as u32 + 1)));
    assert_eq!(lines[0].text, "line 1");

    // Second commit: modify, rename (+edit), delete, binary change, new file, no-newline edit.
    let mut keep: Vec<String> = (1..=10).map(|i| format!("line {i}")).collect();
    keep[4] = "line 5 changed".into();
    keep.insert(8, "inserted".into());
    write(&dir, "keep.txt", keep.join("\n") + "\n");
    g(&dir, &["mv", "to rename.txt", "renamed ü.txt"]);
    let mut ren = numbered_lines(30);
    ren.push_str("tail\n");
    write(&dir, "renamed ü.txt", ren);
    std::fs::remove_file(dir.join("to delete.txt")).unwrap();
    write(&dir, "img.bin", b"\x00\x09\x09other");
    write(&dir, "new file.txt", "n1\nn2\n");
    write(&dir, "nonl.txt", "a\nc");
    let c2 = commit_all(&dir, "second");

    let files = diff::commit_files(&root, &c2).unwrap();
    assert_eq!(files.len(), 6, "{files:#?}");
    let k = find(&files, "keep.txt");
    assert_eq!((k.status, k.additions, k.deletions), (FileStatus::Modified, 2, 1));
    let r = find(&files, "renamed ü.txt");
    assert_eq!((r.status, r.orig_path.as_deref(), r.additions, r.deletions), (FileStatus::Renamed, Some("to rename.txt"), 1, 0));
    let del = find(&files, "to delete.txt");
    assert_eq!((del.status, del.additions, del.deletions), (FileStatus::Deleted, 0, 2));
    let b = find(&files, "img.bin");
    assert_eq!((b.status, b.binary, b.additions), (FileStatus::Modified, true, 0));
    assert_eq!(find(&files, "new file.txt").status, FileStatus::Added);
    assert_eq!(find(&files, "nonl.txt").additions, 1);

    // Line numbers across a modification and an insertion.
    let d = diff::commit_file_diff(&root, &c2, "keep.txt").unwrap();
    assert_eq!((d.status, d.binary, d.truncated), (FileStatus::Modified, false, false));
    let lines = all_lines(&d);
    let del5 = lines.iter().find(|l| l.kind == LineKind::Del).unwrap();
    assert_eq!((del5.old_no, del5.new_no, del5.text.as_str()), (Some(5), None, "line 5"));
    let add5 = lines.iter().find(|l| l.text == "line 5 changed").unwrap();
    assert_eq!((add5.kind, add5.old_no, add5.new_no), (LineKind::Add, None, Some(5)));
    let ins = lines.iter().find(|l| l.text == "inserted").unwrap();
    assert_eq!((ins.kind, ins.new_no), (LineKind::Add, Some(9)));
    let l9 = lines.iter().find(|l| l.text == "line 9").unwrap();
    assert_eq!((l9.kind, l9.old_no, l9.new_no), (LineKind::Ctx, Some(9), Some(10)));
    let l4 = lines.iter().find(|l| l.text == "line 4").unwrap();
    assert_eq!((l4.old_no, l4.new_no), (Some(4), Some(4)));
    for h in &d.hunks {
        assert!(h.header.starts_with("@@ -"), "{}", h.header);
    }

    // Rename keeps its pairing even though the patch is filtered by path.
    let d = diff::commit_file_diff(&root, &c2, "renamed ü.txt").unwrap();
    assert_eq!((d.status, d.orig_path.as_deref()), (FileStatus::Renamed, Some("to rename.txt")));
    let lines = all_lines(&d);
    assert_eq!(lines.iter().filter(|l| l.kind == LineKind::Add).count(), 1);
    assert_eq!(lines.iter().filter(|l| l.kind == LineKind::Del).count(), 0);
    let tail = lines.iter().find(|l| l.kind == LineKind::Add).unwrap();
    assert_eq!((tail.text.as_str(), tail.new_no), ("tail", Some(31)));

    // Deleted file: all lines deleted, no new numbers.
    let d = diff::commit_file_diff(&root, &c2, "to delete.txt").unwrap();
    assert_eq!(d.status, FileStatus::Deleted);
    let lines = all_lines(&d);
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|l| l.kind == LineKind::Del && l.new_no.is_none()));
    assert_eq!(lines.iter().map(|l| l.old_no).collect::<Vec<_>>(), [Some(1), Some(2)]);

    // Binary.
    let d = diff::commit_file_diff(&root, &c2, "img.bin").unwrap();
    assert!(d.binary && d.hunks.is_empty());

    // New file.
    let d = diff::commit_file_diff(&root, &c2, "new file.txt").unwrap();
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(all_lines(&d).iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["n1", "n2"]);

    // "\ No newline at end of file" is not emitted as a line.
    let d = diff::commit_file_diff(&root, &c2, "nonl.txt").unwrap();
    let lines = all_lines(&d);
    assert!(lines.iter().all(|l| !l.text.contains("No newline")), "{lines:#?}");
    let summary: Vec<(LineKind, Option<u32>, Option<u32>, &str)> =
        lines.iter().map(|l| (l.kind, l.old_no, l.new_no, l.text.as_str())).collect();
    assert_eq!(
        summary,
        [
            (LineKind::Ctx, Some(1), Some(1), "a"),
            (LineKind::Del, Some(2), None, "b"),
            (LineKind::Add, None, Some(2), "c"),
        ]
    );

    // Path not part of the commit / bad input.
    assert!(diff::commit_file_diff(&root, &c2, "nope.txt").is_err());
    assert!(diff::commit_files(&root, "--all").is_err());
    assert!(diff::commit_files(&root, "HEAD~1").is_err());
}

#[test]
fn merge_commit_compares_with_first_parent() {
    let (_t, dir, root) = new_repo();
    write(&dir, "a.txt", "a\n");
    write(&dir, "b.txt", "b\n");
    commit_all(&dir, "base");
    g(&dir, &["checkout", "-q", "-b", "feat"]);
    write(&dir, "a.txt", "a feat\n");
    commit_all(&dir, "feat");
    g(&dir, &["checkout", "-q", "main"]);
    write(&dir, "b.txt", "b main\n");
    commit_all(&dir, "main");
    g(&dir, &["merge", "-q", "--no-ff", "-m", "merge", "feat"]);
    let merge = g(&dir, &["rev-parse", "HEAD"]);
    let files = diff::commit_files(&root, &merge).unwrap();
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!((files[0].path.as_str(), files[0].additions, files[0].deletions), ("a.txt", 1, 1));
    let d = diff::commit_file_diff(&root, &merge, "a.txt").unwrap();
    let texts: Vec<(LineKind, &str)> = all_lines(&d).iter().map(|l| (l.kind, l.text.as_str())).collect();
    assert_eq!(texts, [(LineKind::Del, "a"), (LineKind::Add, "a feat")]);
}

#[test]
fn large_diffs_are_truncated() {
    let (_t, dir, root) = new_repo();
    write(&dir, "seed.txt", "s\n");
    commit_all(&dir, "seed");
    write(&dir, "huge.txt", numbered_lines(25_000));
    let c = commit_all(&dir, "huge");
    let d = diff::commit_file_diff(&root, &c, "huge.txt").unwrap();
    assert!(d.truncated);
    assert_eq!(all_lines(&d).len(), diff::MAX_DIFF_LINES);
    assert_eq!(all_lines(&d).last().unwrap().new_no, Some(20_000));

    write(&dir, "exact.txt", numbered_lines(diff::MAX_DIFF_LINES));
    let c = commit_all(&dir, "exact");
    let d = diff::commit_file_diff(&root, &c, "exact.txt").unwrap();
    assert!(!d.truncated);
    assert_eq!(all_lines(&d).len(), diff::MAX_DIFF_LINES);

    write(&dir, "untracked huge.txt", numbered_lines(25_000));
    let d = diff::working_file_diff(&root, "untracked huge.txt", false).unwrap();
    assert!(d.truncated);
    assert_eq!(all_lines(&d).len(), diff::MAX_DIFF_LINES);
    assert_eq!(d.hunks[0].header, "@@ -0,0 +1,25000 @@");
}

// ---------------------------------------------------------------- working diffs

#[test]
fn working_diffs_staged_unstaged_untracked() {
    let (_t, dir, root) = new_repo();
    write(&dir, "f.txt", "one\ntwo\nthree\n");
    write(&dir, "old ü.txt", numbered_lines(20));
    write(&dir, "gone.txt", "g\n");
    commit_all(&dir, "init");

    write(&dir, "f.txt", "one\nTWO\nthree\n");
    g(&dir, &["add", "f.txt"]);
    write(&dir, "f.txt", "one\nTWO\nthree\nfour\n");

    let staged = diff::working_file_diff(&root, "f.txt", true).unwrap();
    assert_eq!(staged.status, FileStatus::Modified);
    let s: Vec<(LineKind, &str)> = all_lines(&staged).iter().map(|l| (l.kind, l.text.as_str())).collect();
    assert_eq!(s, [(LineKind::Ctx, "one"), (LineKind::Del, "two"), (LineKind::Add, "TWO"), (LineKind::Ctx, "three")]);

    let unstaged = diff::working_file_diff(&root, "f.txt", false).unwrap();
    let added: Vec<(&str, Option<u32>)> = all_lines(&unstaged)
        .iter()
        .filter(|l| l.kind == LineKind::Add)
        .map(|l| (l.text.as_str(), l.new_no))
        .collect();
    assert_eq!(added, [("four", Some(4))]);
    assert!(all_lines(&unstaged).iter().all(|l| l.kind != LineKind::Del));

    // Staged rename.
    g(&dir, &["mv", "old ü.txt", "new ü.txt"]);
    let d = diff::working_file_diff(&root, "new ü.txt", true).unwrap();
    assert_eq!((d.status, d.orig_path.as_deref()), (FileStatus::Renamed, Some("old ü.txt")));
    assert!(d.hunks.is_empty());

    // Unstaged deletion.
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    let d = diff::working_file_diff(&root, "gone.txt", false).unwrap();
    assert_eq!(d.status, FileStatus::Deleted);
    assert_eq!(all_lines(&d).len(), 1);

    // Untracked file: one hunk of added lines.
    write(&dir, "dir sp/new é.txt", "a\r\nb\nc");
    let d = diff::working_file_diff(&root, "dir sp/new é.txt", false).unwrap();
    assert_eq!(d.status, FileStatus::Untracked);
    assert_eq!(d.hunks.len(), 1);
    assert_eq!(d.hunks[0].header, "@@ -0,0 +1,3 @@");
    let lines: Vec<(LineKind, Option<u32>, Option<u32>, &str)> =
        all_lines(&d).iter().map(|l| (l.kind, l.old_no, l.new_no, l.text.as_str())).collect();
    assert_eq!(
        lines,
        [
            (LineKind::Add, None, Some(1), "a"),
            (LineKind::Add, None, Some(2), "b"),
            (LineKind::Add, None, Some(3), "c"),
        ]
    );
    write(&dir, "one line.txt", "solo\n");
    assert_eq!(diff::working_file_diff(&root, "one line.txt", false).unwrap().hunks[0].header, "@@ -0,0 +1 @@");
    write(&dir, "empty.txt", "");
    assert!(diff::working_file_diff(&root, "empty.txt", false).unwrap().hunks.is_empty());
    write(&dir, "blob.bin", b"\x00\x01");
    let d = diff::working_file_diff(&root, "blob.bin", false).unwrap();
    assert!(d.binary && d.hunks.is_empty());

    // Untracked file has no staged diff; unchanged tracked file has none either.
    let d = diff::working_file_diff(&root, "dir sp/new é.txt", true).unwrap();
    assert!(d.hunks.is_empty());
    g(&dir, &["checkout", "-q", "--", "f.txt"]);
    g(&dir, &["reset", "-q", "--", "f.txt"]);
    g(&dir, &["checkout", "-q", "--", "f.txt"]);
    let d = diff::working_file_diff(&root, "f.txt", false).unwrap();
    assert!(d.hunks.is_empty() && !d.truncated);
}

// ---------------------------------------------------------------- worktrees

#[test]
fn worktrees_list_status_and_add() {
    let tmp = TempDir::new().unwrap();
    let main_dir = tmp.path().join("repo ü");
    init_repo(&main_dir);
    let main_root = to_slash(&main_dir);
    write(&main_dir, "a.txt", "a\n");
    let base = commit_all(&main_dir, "base");
    g(&main_dir, &["branch", "existing"]);

    // New branch, created from HEAD of root.
    let wt = worktree::add_worktree(&main_root, "feature/x").unwrap();
    let expected = tmp.path().join("repo ü.feature-x");
    assert!(expected.is_dir());
    assert_eq!(canonical_slash(Path::new(&wt.path)), canonical_slash(&expected));
    assert!(!wt.path.contains('\\'));
    assert_eq!(wt.branch.as_deref(), Some("feature/x"));
    assert_eq!(wt.head, base);
    assert!(!wt.is_main && !wt.is_current && !wt.detached);

    // Existing branch is checked out, not recreated.
    let wt2 = worktree::add_worktree(&main_root, "existing").unwrap();
    assert!(tmp.path().join("repo ü.existing").is_dir());
    assert_eq!(wt2.branch.as_deref(), Some("existing"));
    // Target folder already present.
    assert!(worktree::add_worktree(&main_root, "existing").is_err());
    assert!(worktree::add_worktree(&main_root, "bad..name").is_err());
    assert!(worktree::add_worktree(&main_root, "-x").is_err());

    // Detached worktree.
    let det = tmp.path().join("detached wt");
    g(&main_dir, &["worktree", "add", "-q", "--detach", &to_slash(&det), &base]);

    let list = worktree::list_worktrees(&main_root).unwrap();
    assert_eq!(list.len(), 4, "{list:#?}");
    assert!(list[0].is_main && list[0].is_current);
    assert_eq!(canonical_slash(Path::new(&list[0].path)), canonical_slash(&main_dir));
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert_eq!(list.iter().filter(|w| w.is_main).count(), 1);
    assert_eq!(list.iter().filter(|w| w.is_current).count(), 1);
    let d = list.iter().find(|w| w.detached).unwrap();
    assert_eq!((d.branch.clone(), d.head.clone()), (None, base.clone()));
    assert!(list.iter().all(|w| !w.locked && !w.prunable));

    // Asked from inside a linked worktree (a subfolder of it).
    write(&expected, "sub/s.txt", "s\n");
    let from_feature = worktree::list_worktrees(&to_slash(&expected.join("sub"))).unwrap();
    assert!(from_feature[0].is_main && !from_feature[0].is_current);
    let cur = from_feature.iter().find(|w| w.is_current).unwrap();
    assert_eq!(cur.branch.as_deref(), Some("feature/x"));

    // Ahead / behind / dirty.
    let feat_root = to_slash(&expected);
    write(&expected, "sub/t.txt", "t\n");
    let st = worktree::worktree_status(&feat_root, Some("main")).unwrap();
    assert_eq!((st.ahead, st.behind, st.dirty), (0, 0, 2), "each untracked file counts, as in git_status");
    assert_eq!(st.dirty as usize, git::git_status(&feat_root).unwrap().len());
    std::fs::remove_dir_all(expected.join("sub")).unwrap();
    write(&expected, "f.txt", "f\n");
    commit_all(&expected, "feature work");
    write(&main_dir, "a.txt", "a2\n");
    commit_all(&main_dir, "main 1");
    write(&main_dir, "a.txt", "a3\n");
    commit_all(&main_dir, "main 2");
    let st = worktree::worktree_status(&feat_root, Some("main")).unwrap();
    assert_eq!((st.ahead, st.behind, st.dirty), (1, 2, 0));
    write(&expected, "a.txt", "dirty\n");
    write(&expected, "u1.txt", "u\n");
    write(&expected, "u2.txt", "u\n");
    let st = worktree::worktree_status(&feat_root, None).unwrap();
    assert_eq!((st.ahead, st.behind, st.dirty), (0, 0, 3));
    let st = worktree::worktree_status(&feat_root, Some(&base)).unwrap();
    assert_eq!((st.ahead, st.behind), (1, 0));
    assert!(worktree::worktree_status(&feat_root, Some("no-such-branch")).is_err());

    // Prunable: folder removed behind git's back.
    std::fs::remove_dir_all(&det).unwrap();
    let list = worktree::list_worktrees(&main_root).unwrap();
    assert!(list.iter().any(|w| w.prunable && w.detached));
}

#[test]
fn worktree_folder_name() {
    let p = worktree::worktree_dir_for(Path::new("/x/my repo"), "feat/a/b").unwrap();
    assert_eq!(to_slash(&p), "/x/my repo.feat-a-b");
}

// ---------------------------------------------------------------- find_repos / browse_dir

/// Workspace folder holding several repositories at different depths.
fn repo_tree() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let ws = tmp.path().join("ws");
    let a = ws.join("a-repo");
    init_repo(&a);
    write(&a, "a.txt", "a\n");
    commit_all(&a, "a");
    // Repository inside a repository: never listed from above.
    init_repo(&a.join("inner"));

    let b = ws.join("Group").join("b repo ü");
    std::fs::create_dir_all(&b).unwrap();
    g(&b, &["init", "-q", "-b", "feature/x"]);

    let c = ws.join("Group").join("deep").join("c-repo");
    init_repo(&c);
    write(&c, "c.txt", "c\n");
    let hash = commit_all(&c, "c");
    g(&c, &["checkout", "-q", "--detach", &hash]);

    for skipped in ["node_modules", "target", "dist", "build", "vendor", ".hidden"] {
        std::fs::create_dir_all(ws.join(skipped).join("r").join(".git")).unwrap();
    }
    std::fs::create_dir_all(ws.join("plain").join("sub")).unwrap();
    write(&ws, "file.txt", "f");

    // Linked worktree made by git (absolute gitdir).
    g(&a, &["worktree", "add", "-q", "-b", "wt/branch", &to_slash(&ws.join("wt-linked"))]);
    // Hand-written `.git` file with a relative gitdir.
    write(&ws, "rel-linked/.git", "gitdir: ../a-repo/.git\n");
    (tmp, ws)
}

#[test]
fn find_repos_depth_skip_linked_sort_and_cap() {
    let (_t, ws) = repo_tree();
    let root = to_slash(&ws);
    let rels = |depth: u32| -> Vec<String> {
        repos::find_repos(&root, depth).unwrap().into_iter().map(|r| r.rel_path).collect()
    };
    assert!(rels(0).is_empty());
    assert_eq!(rels(1), ["a-repo", "rel-linked", "wt-linked"]);
    assert_eq!(rels(2), ["a-repo", "Group/b repo ü", "rel-linked", "wt-linked"]);
    let all = repos::find_repos(&root, 3).unwrap();
    assert_eq!(
        all.iter().map(|r| r.rel_path.as_str()).collect::<Vec<_>>(),
        ["a-repo", "Group/b repo ü", "Group/deep/c-repo", "rel-linked", "wt-linked"]
    );
    assert_eq!(rels(10).len(), 5);

    let by = |rel: &str| all.iter().find(|r| r.rel_path == rel).unwrap();
    assert_eq!((by("a-repo").branch.as_deref(), by("a-repo").linked), (Some("main"), false));
    assert_eq!(by("Group/b repo ü").branch.as_deref(), Some("feature/x"), "unborn branch still named");
    assert_eq!(by("Group/deep/c-repo").branch, None, "detached");
    let wt = by("wt-linked");
    assert_eq!((wt.linked, wt.branch.as_deref()), (true, Some("wt/branch")));
    let rl = by("rel-linked");
    assert_eq!((rl.linked, rl.branch.as_deref()), (true, Some("main")));
    for r in &all {
        assert!(!r.path.contains('\\') &&!r.path.starts_with("//?/"), "{}", r.path);
        assert_eq!(r.path, format!("{}/{}", canonical_slash(&ws), r.rel_path));
    }

    // Cap (breadth-first: the shallow ones are kept).
    let capped = repos::find_repos_capped(&root, 3, 2).unwrap();
    assert_eq!(capped.len(), 2);
    assert!(capped.iter().all(|r| !r.rel_path.contains('/')));

    // `root` itself is a repository: not listed, repositories below it are.
    let inside = repos::find_repos(&to_slash(&ws.join("a-repo")), 3).unwrap();
    assert_eq!(inside.iter().map(|r| r.rel_path.as_str()).collect::<Vec<_>>(), ["inner"]);

    assert!(repos::find_repos(&to_slash(&ws.join("missing")), 2).is_err());
}

#[cfg(windows)]
#[test]
fn find_repos_does_not_follow_junctions() {
    let (_t, ws) = repo_tree();
    let link = ws.join("junction");
    let ok = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(ws.join("Group"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    assert!(ok, "mklink /J failed");
    let all = repos::find_repos(&to_slash(&ws), 3).unwrap();
    assert!(all.iter().all(|r| !r.rel_path.starts_with("junction")), "{all:?}");
}

#[test]
fn browse_dir_lists_folders() {
    let (tmp, ws) = repo_tree();
    let raw = ws.to_string_lossy().replace('/', "\\") + "\\";
    let l = repos::browse_dir(&raw).unwrap();
    assert_eq!(l.path, canonical_slash(&ws));
    assert_eq!(l.parent.as_deref(), Some(canonical_slash(tmp.path()).as_str()));
    let names: Vec<&str> = l.dirs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names,
        [".hidden", "a-repo", "build", "dist", "Group", "node_modules", "plain", "rel-linked", "target", "vendor", "wt-linked"]
    );
    let a = &l.dirs[1];
    assert_eq!((a.is_repo, a.branch.as_deref()), (true, Some("main")));
    assert_eq!(a.path, format!("{}/a-repo", canonical_slash(&ws)));
    let plain = l.dirs.iter().find(|d| d.name == "plain").unwrap();
    assert_eq!((plain.is_repo, plain.branch.clone()), (false, None));
    assert!(l.dirs.iter().find(|d| d.name == "wt-linked").unwrap().is_repo);

    // `.git` is hidden; forward slashes with a trailing slash accepted.
    let inner = repos::browse_dir(&format!("{}/a-repo/", to_slash(&ws))).unwrap();
    assert_eq!(inner.dirs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["inner"]);
    assert_eq!(inner.parent.as_deref(), Some(canonical_slash(&ws).as_str()));

    // Missing folder, a file, a relative path: rejected.
    assert!(repos::browse_dir(&to_slash(&ws.join("missing"))).is_err());
    assert!(repos::browse_dir(&to_slash(&ws.join("file.txt"))).is_err());
    assert!(repos::browse_dir("relative/dir").is_err());
}

#[test]
fn browse_dir_roots() {
    let roots = repos::browse_dir("").unwrap();
    assert_eq!((roots.path.as_str(), roots.parent.clone()), ("", None));
    assert!(!roots.dirs.is_empty());
    assert!(roots.dirs.iter().all(|d| d.path.ends_with('/') && !d.path.contains('\\')));

    let tmp = TempDir::new().unwrap();
    let fs_root = tmp.path().canonicalize().unwrap().ancestors().last().unwrap().to_path_buf();
    let l = repos::browse_dir(&to_slash(&fs_root)).unwrap();
    assert_eq!(l.parent.as_deref(), Some(""));
    assert!(l.path.ends_with('/'), "{}", l.path);
    assert!(roots.dirs.iter().any(|d| d.path == l.path), "{} in roots", l.path);
    if cfg!(windows) {
        let drive = &l.path[..2];
        assert_eq!(repos::browse_dir(drive).unwrap().path, l.path, "bare drive letter");
    }
}

// ---------------------------------------------------------------- self-update state machine

#[test]
fn update_state_json_contract() {
    use update::{UpdatePhase, UpdateState};
    let st = UpdateState {
        phase: UpdatePhase::UpToDate,
        current_version: "0.1.0".into(),
        new_version: None,
        notes: None,
        downloaded: 0,
        total: None,
        error: None,
        checked_at: Some(1),
    };
    let v = expect_keys(
        &st,
        &["phase", "currentVersion", "newVersion", "notes", "downloaded", "total", "error", "checkedAt"],
    );
    assert_eq!(v["phase"], "upToDate");
    let phases: Vec<serde_json::Value> = [
        UpdatePhase::Disabled,
        UpdatePhase::Idle,
        UpdatePhase::Checking,
        UpdatePhase::UpToDate,
        UpdatePhase::Available,
        UpdatePhase::Downloading,
        UpdatePhase::Installing,
        UpdatePhase::Error,
    ]
    .iter()
    .map(|p| serde_json::to_value(p).unwrap())
    .collect();
    assert_eq!(phases, ["disabled", "idle", "checking", "upToDate", "available", "downloading", "installing", "error"]);
}

#[test]
fn update_machine_disabled_never_moves() {
    use update::{Machine, Refused, UpdatePhase};
    let mut m = Machine::new("0.1.0", false);
    assert_eq!(m.phase(), UpdatePhase::Disabled);
    assert_eq!(m.begin_check(), Err(Refused::Disabled));
    assert_eq!(m.begin_download(), Err(Refused::Disabled));
    m.fail("x");
    m.progress(10, Some(20));
    assert_eq!(m.phase(), UpdatePhase::Disabled);
    assert_eq!(m.state().current_version, "0.1.0");
    assert_eq!((m.state().downloaded, m.state().error.clone()), (0, None));
}

#[test]
fn update_machine_check_install_flow() {
    use update::{CheckOutcome, Machine, Refused, UpdatePhase};
    let mut m = Machine::new("0.1.0", true);
    assert_eq!(m.phase(), UpdatePhase::Idle);
    assert_eq!(m.state().checked_at, None);
    // Nothing to download before a check found something.
    assert_eq!(m.begin_download(), Err(Refused::WrongPhase));

    m.begin_check().unwrap();
    assert_eq!(m.phase(), UpdatePhase::Checking);
    assert_eq!(m.begin_check(), Err(Refused::Busy), "no second check while one runs");
    m.finish_check(CheckOutcome::UpToDate, 100).unwrap();
    assert_eq!((m.phase(), m.state().checked_at, m.state().new_version.clone()), (UpdatePhase::UpToDate, Some(100), None));
    assert_eq!(m.finish_check(CheckOutcome::UpToDate, 1), Err(Refused::WrongPhase));

    m.begin_check().unwrap();
    m.finish_check(CheckOutcome::Available { version: "0.2.0".into(), notes: Some("notes".into()) }, 200).unwrap();
    let s = m.state().clone();
    assert_eq!((s.phase, s.new_version.as_deref(), s.notes.as_deref(), s.checked_at), (UpdatePhase::Available, Some("0.2.0"), Some("notes"), Some(200)));

    m.begin_download().unwrap();
    assert_eq!(m.phase(), UpdatePhase::Downloading);
    assert_eq!(m.begin_download(), Err(Refused::Busy), "no second download");
    assert_eq!(m.begin_check(), Err(Refused::Busy));
    m.progress(10, Some(30));
    m.progress(15, None);
    assert_eq!((m.state().downloaded, m.state().total), (25, Some(30)));
    assert_eq!(m.state().new_version.as_deref(), Some("0.2.0"));
    m.begin_install().unwrap();
    assert_eq!(m.phase(), UpdatePhase::Installing);
    assert_eq!(m.begin_check(), Err(Refused::Busy));
    m.progress(5, None);
    assert_eq!(m.state().downloaded, 25, "progress ignored outside downloading");
}

#[test]
fn update_machine_errors_are_recoverable() {
    use update::{CheckOutcome, Machine, UpdatePhase};
    let mut m = Machine::new("0.1.0", true);
    m.begin_check().unwrap();
    m.finish_check(CheckOutcome::Failed("cannot reach the release server".into()), 5).unwrap();
    let s = m.state().clone();
    assert_eq!((s.phase, s.error.as_deref(), s.checked_at), (UpdatePhase::Error, Some("cannot reach the release server"), Some(5)));

    // A new check clears the error.
    m.begin_check().unwrap();
    assert_eq!(m.state().error, None);
    m.finish_check(CheckOutcome::Available { version: "0.3.0".into(), notes: Some("  ".into()) }, 6).unwrap();
    assert_eq!(m.state().notes, None, "blank notes become null");
    m.begin_download().unwrap();
    m.progress(100, Some(1000));
    m.fail("signature mismatch");
    let s = m.state().clone();
    assert_eq!((s.phase, s.downloaded, s.total, s.new_version), (UpdatePhase::Error, 0, None, None));
    m.fail("");
    assert_eq!(m.state().error.as_deref(), Some("update failed"));
    assert!(m.begin_check().is_ok(), "error -> checking");
}

#[test]
fn update_progress_throttle() {
    let mut t = update::Throttle::default();
    assert!(t.should_emit(0, 10, Some(10_000)), "first chunk");
    assert!(!t.should_emit(10, 20, Some(10_000)));
    assert!(t.should_emit(20, 200, Some(10_000)), "1 % more");
    assert!(t.should_emit(200, 210, Some(10_000)), "100 ms later");
    assert!(t.should_emit(201, 10_000, Some(10_000)), "final chunk");
    let mut t = update::Throttle::default();
    assert!(t.should_emit(0, 1, None));
    assert!(!t.should_emit(50, 1_000_000, None), "unknown total: time based only");
    assert!(t.should_emit(150, 1_000_001, None));
}
