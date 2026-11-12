//! Spawning the `git` CLI.
//!
//! Every invocation gets the same base configuration: no console window on
//! Windows, unquoted UTF-8 paths, no colors / pager / prompts, English
//! messages (so "not a git repository" can be recognised), and no inherited
//! `GIT_DIR`-style variables that would redirect it to another repository.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }

    /// The working directory is not inside a git repository.
    pub fn not_repo(&self) -> bool {
        self.code == Some(128) && self.stderr.contains("not a git repository")
    }

    pub fn stdout_str(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// How git is invoked.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Read-only query: `GIT_OPTIONAL_LOCKS=0` so it never takes the index lock.
    Read,
    /// A command that is allowed to write (worktree add).
    Write,
}

pub fn command(cwd: &Path, mode: Mode) -> Command {
    let mut c = Command::new("git");
    c.current_dir(cwd)
        .arg("--no-pager")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .env("LC_ALL", "C")
        .env("LANGUAGE", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_PREFIX")
        .stdin(Stdio::null());
    if mode == Mode::Read {
        c.env("GIT_OPTIONAL_LOCKS", "0");
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn spawn_err(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "git executable not found in PATH".into()
    } else {
        format!("failed to run git: {e}")
    }
}

/// Runs git and collects its output, whatever the exit code.
pub fn run<S: AsRef<std::ffi::OsStr>>(cwd: &Path, mode: Mode, args: &[S]) -> Result<Output, String> {
    let out = command(cwd, mode)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(spawn_err)?;
    Ok(Output {
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Runs git, feeding `input` on stdin from a separate thread (no pipe deadlock).
pub fn run_input<S: AsRef<std::ffi::OsStr>>(
    cwd: &Path,
    mode: Mode,
    args: &[S],
    input: Vec<u8>,
) -> Result<Output, String> {
    let mut child = command(cwd, mode)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_err)?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    let writer = std::thread::spawn(move || {
        // A write error just means git exited early; its exit code tells why.
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output().map_err(spawn_err)?;
    let _ = writer.join();
    Ok(Output {
        code: out.status.code(),
        stdout: out.stdout,
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Error message for a failed git call.
pub fn failure(args_hint: &str, out: &Output) -> String {
    let msg = out.stderr.trim();
    if msg.is_empty() {
        format!("git {args_hint} failed (exit code {:?})", out.code)
    } else {
        format!("git {args_hint} failed: {msg}")
    }
}

/// Runs git and requires exit code 0.
pub fn run_ok<S: AsRef<std::ffi::OsStr>>(cwd: &Path, mode: Mode, args: &[S]) -> Result<Output, String> {
    let out = run(cwd, mode, args)?;
    if out.ok() {
        Ok(out)
    } else {
        let hint = args.first().map(|a| a.as_ref().to_string_lossy().into_owned()).unwrap_or_default();
        Err(failure(&hint, &out))
    }
}

/// Outcome of a streamed call.
pub enum Streamed<T> {
    Done(T),
    NotRepo,
}

/// Runs git and hands its stdout to `consume` as a buffered reader, so large
/// outputs (diffs) are parsed incrementally. `consume` returns its value and
/// whether it stopped before the end; in that case the process is killed and
/// its exit code ignored.
pub fn stream<S, T, F>(cwd: &Path, args: &[S], consume: F) -> Result<Streamed<T>, String>
where
    S: AsRef<std::ffi::OsStr>,
    F: FnOnce(&mut dyn BufRead) -> std::io::Result<(T, bool)>,
{
    let mut child = command(cwd, Mode::Read)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_err)?;
    let mut stderr = child.stderr.take().expect("piped stderr");
    let err_reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s);
        String::from_utf8_lossy(&s).into_owned()
    });
    let stdout = child.stdout.take().expect("piped stdout");
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let result = consume(&mut reader);
    let stopped_early = matches!(result, Ok((_, true)));
    if stopped_early {
        let _ = child.kill();
    }
    drop(reader);
    let status = child.wait().map_err(spawn_err)?;
    let stderr = err_reader.join().unwrap_or_default();
    let out = Output { code: status.code(), stdout: Vec::new(), stderr };
    let (value, _) = result.map_err(|e| format!("reading git output: {e}"))?;
    if stopped_early || out.ok() {
        Ok(Streamed::Done(value))
    } else if out.not_repo() {
        Ok(Streamed::NotRepo)
    } else {
        let hint = args.first().map(|a| a.as_ref().to_string_lossy().into_owned()).unwrap_or_default();
        Err(failure(&hint, &out))
    }
}

/// Splits NUL-separated output into tokens (a trailing NUL yields no empty token).
pub fn nul_tokens(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    let trimmed = bytes.strip_suffix(b"\0").unwrap_or(bytes);
    let empty = trimmed.is_empty();
    trimmed.split(|b| *b == 0).filter(move |_| !empty)
}

pub fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}
