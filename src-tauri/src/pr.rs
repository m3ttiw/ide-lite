//! Pull request of the current branch on GitHub or Azure DevOps: its state,
//! reviewers, checks and the comments left on the diff.
//!
//! The token comes from git's own credential helper (the one `git fetch`
//! would use for that remote, asked never to prompt), or else from the
//! `gh` / `az` command-line tools. It is sent only to the host of the remote it
//! was issued for, and never logged nor returned to the interface.

use crate::gitcmd::{self, Mode};
use crate::types::{PrCheck, PrComment, PrLookup, PrReviewer, PullRequest};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A remote ide-lite knows how to ask about pull requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Remote {
    GitHub {
        /// REST API root, e.g. https://api.github.com
        api: String,
        /// Web root, e.g. https://github.com
        web: String,
        owner: String,
        repo: String,
    },
    Azure {
        /// Organization root: https://dev.azure.com/{org} or https://{org}.visualstudio.com
        base: String,
        /// Project and repository, as written in the URL (percent-encoded).
        project: String,
        repo: String,
    },
}

impl Remote {
    fn provider(&self) -> &'static str {
        match self {
            Remote::GitHub { .. } => "github",
            Remote::Azure { .. } => "azure",
        }
    }

    /// Web page of the repository.
    pub fn web_url(&self) -> String {
        match self {
            Remote::GitHub { web, owner, repo, .. } => format!("{web}/{owner}/{repo}"),
            Remote::Azure { base, project, repo } => format!("{base}/{project}/_git/{repo}"),
        }
    }

    /// URL handed to `git credential fill`: the HTTPS form of the remote.
    fn credential_url(&self) -> String {
        match self {
            Remote::GitHub { web, owner, repo, .. } => format!("{web}/{owner}/{repo}.git"),
            Remote::Azure { .. } => self.web_url(),
        }
    }
}

/// Host and path of a remote URL: `scheme://[user@]host[:port]/path` or the
/// scp-like `[user@]host:path`. The user part (which may hold a password) is dropped.
fn split_url(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let url = url.split(['?', '#']).next().unwrap_or(url);
    if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        return (!host.is_empty()).then(|| (host.to_ascii_lowercase(), path.to_string()));
    }
    // scp-like syntax: a colon before any slash
    let colon = url.find(':')?;
    if url[..colon].contains('/') {
        return None;
    }
    let host = url[..colon].rsplit('@').next()?;
    (!host.is_empty()).then(|| (host.to_ascii_lowercase(), url[colon + 1..].to_string()))
}

pub fn parse_remote(url: &str) -> Option<Remote> {
    let (host, path) = split_url(url)?;
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let azure = |base: String, project: &str, repo: &str| Remote::Azure { base, project: project.to_string(), repo: repo.to_string() };

    if host == "ssh.dev.azure.com" || host.ends_with("vs-ssh.visualstudio.com") {
        // v3/{org}/{project}/{repo}
        return match parts.as_slice() {
            ["v3", org, project, repo] => Some(azure(format!("https://dev.azure.com/{org}"), project, repo)),
            _ => None,
        };
    }
    if host == "dev.azure.com" {
        // {org}/{project}/_git/{repo}, or {org}/_git/{repo} when the project is named like the repository
        let g = parts.iter().position(|p| *p == "_git")?;
        let repo = *parts.get(g + 1)?;
        if g == 0 {
            return None;
        }
        let project = if g >= 2 { parts[g - 1] } else { repo };
        return Some(azure(format!("https://dev.azure.com/{}", parts[0]), project, repo));
    }
    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        // [DefaultCollection/]{project}/_git/{repo}, or _git/{repo}
        let g = parts.iter().position(|p| *p == "_git")?;
        let repo = *parts.get(g + 1)?;
        let project = match g.checked_sub(1).map(|i| parts[i]) {
            Some(p) if !p.eq_ignore_ascii_case("DefaultCollection") => p,
            _ => repo,
        };
        return Some(azure(format!("https://{org}.visualstudio.com"), project, repo));
    }
    let public = host == "github.com" || host == "ssh.github.com" || host == "www.github.com";
    if public || host.starts_with("github.") {
        let [owner, repo] = parts.as_slice() else {
            return None;
        };
        let repo = repo.strip_suffix(".git").unwrap_or(repo);
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        let (api, web) = if public {
            ("https://api.github.com".to_string(), "https://github.com".to_string())
        } else {
            (format!("https://{host}/api/v3"), format!("https://{host}"))
        };
        return Some(Remote::GitHub { api, web, owner: owner.to_string(), repo: repo.to_string() });
    }
    None
}

// ---------------------------------------------------------------- credentials

/// Authorization header value. Not `Debug`: it must never end up in a log.
struct Auth(String);

/// Runs a command with an optional stdin and a deadline; stdout when it succeeds.
fn run_with_timeout(mut cmd: Command, input: Option<Vec<u8>>, timeout: Duration) -> Option<Vec<u8>> {
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().ok()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take()?;
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = stdout.read_to_end(&mut v);
        v
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().ok()?;
                return status.success().then_some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(windows)]
fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn no_window(_: &mut Command) {}

/// Password git would use for `url`, from its credential helpers, without prompting.
fn git_credential(dir: &Path, url: &str) -> Option<String> {
    let mut c = gitcmd::command(dir, Mode::Read);
    c.args(["credential", "fill"])
        .env("GCM_INTERACTIVE", "never")
        .env("GCM_GUI_PROMPT", "false")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "");
    let out = run_with_timeout(c, Some(format!("url={url}\n\n").into_bytes()), Duration::from_secs(20))?;
    let text = String::from_utf8(out).ok()?;
    text.lines().find_map(|l| l.strip_prefix("password=")).map(str::to_string).filter(|p| !p.is_empty())
}

/// First line printed by a tool (`gh auth token`, `az account get-access-token`).
fn tool_output(program: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(program);
    c.args(args);
    no_window(&mut c);
    let out = run_with_timeout(c, None, Duration::from_secs(20))?;
    let s = String::from_utf8(out).ok()?;
    s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// Azure DevOps resource id, for an Entra ID token from the Azure CLI.
const AZURE_DEVOPS_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";

fn auth_for(dir: &Path, remote: &Remote) -> Option<Auth> {
    let from_git = git_credential(dir, &remote.credential_url());
    match remote {
        Remote::GitHub { .. } => from_git
            .or_else(|| std::env::var("GH_TOKEN").ok().filter(|t| !t.is_empty()))
            .or_else(|| std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.is_empty()))
            .or_else(|| tool_output("gh", &["auth", "token"]))
            .map(|t| Auth(format!("Bearer {t}"))),
        Remote::Azure { .. } => {
            if let Some(p) = from_git {
                // an OAuth access token (a JWT) from Git Credential Manager, or a personal access token
                return Some(Auth(if p.starts_with("eyJ") && p.matches('.').count() == 2 {
                    format!("Bearer {p}")
                } else {
                    format!("Basic {}", base64(format!(":{p}").as_bytes()))
                }));
            }
            let az = if cfg!(windows) { "az.cmd" } else { "az" };
            tool_output(az, &["account", "get-access-token", "--resource", AZURE_DEVOPS_RESOURCE, "--query", "accessToken", "-o", "tsv"])
                .map(|t| Auth(format!("Bearer {t}")))
        }
    }
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

// ---------------------------------------------------------------- http

enum Fail {
    /// 401, 403 (not a rate limit), or 404 without credentials.
    Auth(String),
    Other(String),
}

/// Percent-encodes a query value.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn with_query(url: &str, q: &[(&str, &str)]) -> String {
    let mut s = url.to_string();
    for (i, (k, v)) in q.iter().enumerate() {
        s.push(if i == 0 { '?' } else { '&' });
        s.push_str(k);
        s.push('=');
        s.push_str(&enc(v));
    }
    s
}

struct Http {
    client: reqwest::Client,
    auth: Option<Auth>,
    github: bool,
    /// Details that could not be read (checks, comments…): the rest is still shown.
    warnings: std::sync::Mutex<Vec<String>>,
}

impl Http {
    fn new(auth: Option<Auth>, github: bool) -> Result<Self, String> {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!("ide-lite/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(Http { client, auth, github, warnings: Default::default() })
    }

    /// A detail of the pull request: a failure is noted and reads as None.
    async fn detail(&self, what: &str, url: &str) -> Option<Value> {
        match self.get(url).await {
            Ok(v) => Some(v),
            Err(Fail::Auth(m) | Fail::Other(m)) => {
                if let Ok(mut w) = self.warnings.lock() {
                    w.push(format!("{what}: {m}"));
                }
                None
            }
        }
    }

    async fn get(&self, url: &str) -> Result<Value, Fail> {
        let mut req = self.client.get(url);
        req = if self.github {
            req.header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28")
        } else {
            req.header("Accept", "application/json")
        };
        if let Some(a) = &self.auth {
            req = req.header("Authorization", a.0.as_str());
        }
        let res = req.send().await.map_err(|e| Fail::Other(format!("request failed: {}", e.without_url())))?;
        let status = res.status().as_u16();
        let rate_limited = res.headers().get("x-ratelimit-remaining").is_some_and(|v| v == "0");
        // Azure DevOps answers an anonymous call with a sign-in page (203 or a redirect to HTML)
        let html = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.contains("text/html"));
        let body = res.text().await.map_err(|e| Fail::Other(format!("reading the response failed: {}", e.without_url())))?;
        let detail = || {
            serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
                .map(|m| format!("HTTP {status}: {m}"))
                .unwrap_or_else(|| format!("HTTP {status}"))
        };
        match status {
            200..=299 if !html && status != 203 => serde_json::from_str(&body).map_err(|e| Fail::Other(format!("unexpected response: {e}"))),
            200..=299 => Err(Fail::Auth("sign-in required".into())),
            403 if rate_limited => Err(Fail::Other(format!("{}: rate limit reached", detail()))),
            401 | 403 => Err(Fail::Auth(detail())),
            404 if self.auth.is_none() => Err(Fail::Auth(detail())),
            _ => Err(Fail::Other(detail())),
        }
    }
}

// ---------------------------------------------------------------- shared helpers

fn s(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr).and_then(Value::as_str).map(str::to_string)
}

const MAX_BODY: usize = 4000;
const MAX_COMMENTS: usize = 600;

fn clip(body: &str) -> String {
    let body = body.trim();
    if body.len() <= MAX_BODY {
        return body.to_string();
    }
    let mut end = MAX_BODY;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &body[..end])
}

fn set_reviewer(list: &mut Vec<PrReviewer>, name: String, state: &str, required: bool) {
    match list.iter_mut().find(|r| r.name == name) {
        Some(r) => r.state = state.to_string(),
        None => list.push(PrReviewer { name, state: state.to_string(), required }),
    }
}

// ---------------------------------------------------------------- GitHub

/// The open pull request for the branch, else the most recently updated one.
pub fn github_pick(list: &Value) -> Option<&Value> {
    let arr = list.as_array()?;
    arr.iter().find(|p| p["state"] == "open").or_else(|| arr.first())
}

pub fn github_pr(p: &Value) -> Option<PullRequest> {
    let state = if !p["merged_at"].is_null() {
        "merged"
    } else if p["state"] == "closed" {
        "closed"
    } else if p["draft"] == true {
        "draft"
    } else {
        "open"
    };
    Some(PullRequest {
        number: p["number"].as_u64()?,
        title: s(p, "/title").unwrap_or_default(),
        url: s(p, "/html_url")?,
        state: state.into(),
        author: s(p, "/user/login"),
        source_branch: s(p, "/head/ref").unwrap_or_default(),
        target_branch: s(p, "/base/ref").unwrap_or_default(),
        base_ref: None,
        head_commit: s(p, "/head/sha"),
        reviewers: Vec::new(),
        checks: Vec::new(),
        comments: Vec::new(),
    })
}

/// Latest verdict of each reviewer, then whoever is (again) asked to review.
pub fn github_reviewers(pr: &Value, reviews: &Value) -> Vec<PrReviewer> {
    let mut out = Vec::new();
    for r in reviews.as_array().into_iter().flatten() {
        let Some(name) = s(r, "/user/login") else { continue };
        let state = match r["state"].as_str() {
            Some("APPROVED") => "approved",
            Some("CHANGES_REQUESTED") => "changes",
            Some("DISMISSED") | Some("COMMENTED") => {
                if !out.iter().any(|x: &PrReviewer| x.name == name) {
                    out.push(PrReviewer { name, state: "commented".into(), required: false });
                } else if r["state"] == "DISMISSED" {
                    set_reviewer(&mut out, name, "commented", false);
                }
                continue;
            }
            _ => continue,
        };
        set_reviewer(&mut out, name, state, false);
    }
    for u in pr["requested_reviewers"].as_array().into_iter().flatten() {
        if let Some(name) = s(u, "/login") {
            set_reviewer(&mut out, name, "pending", false);
        }
    }
    for t in pr["requested_teams"].as_array().into_iter().flatten() {
        if let Some(name) = s(t, "/name") {
            set_reviewer(&mut out, name, "pending", false);
        }
    }
    out
}

pub fn github_checks(runs: &Value, statuses: &Value) -> Vec<PrCheck> {
    let mut out = Vec::new();
    for r in runs["check_runs"].as_array().into_iter().flatten() {
        let state = if r["status"] != "completed" {
            "pending"
        } else {
            match r["conclusion"].as_str() {
                Some("success") => "success",
                Some("skipped") => "skipped",
                Some("neutral") | Some("cancelled") | Some("stale") => "neutral",
                _ => "failure",
            }
        };
        out.push(PrCheck {
            name: s(r, "/name").unwrap_or_default(),
            state: state.into(),
            url: s(r, "/html_url").or_else(|| s(r, "/details_url")),
            required: false,
        });
    }
    for st in statuses["statuses"].as_array().into_iter().flatten() {
        let state = match st["state"].as_str() {
            Some("success") => "success",
            Some("pending") => "pending",
            _ => "failure",
        };
        out.push(PrCheck { name: s(st, "/context").unwrap_or_default(), state: state.into(), url: s(st, "/target_url"), required: false });
    }
    out
}

pub fn github_comments(list: &[Value]) -> Vec<PrComment> {
    list.iter()
        .filter_map(|c| {
            let id = c["id"].as_u64()?;
            let thread = c["in_reply_to_id"].as_u64().unwrap_or(id);
            let line = c["line"].as_u64().or_else(|| c["original_line"].as_u64());
            Some(PrComment {
                thread: thread.to_string(),
                path: s(c, "/path"),
                line: line.map(|l| l as u32),
                side: if c["side"] == "LEFT" { "old" } else { "new" }.into(),
                author: s(c, "/user/login").unwrap_or_default(),
                body: clip(c["body"].as_str().unwrap_or("")),
                at: s(c, "/created_at").unwrap_or_default(),
                resolved: false,
                outdated: c["line"].is_null(),
                url: s(c, "/html_url"),
            })
        })
        .take(MAX_COMMENTS)
        .collect()
}

async fn github(http: &Http, api: &str, owner: &str, repo: &str, branch: &str) -> Result<Option<PullRequest>, Fail> {
    let root = format!("{api}/repos/{owner}/{repo}");
    let head = format!("{owner}:{branch}");
    let list = http
        .get(&with_query(
            &format!("{root}/pulls"),
            &[("head", &head), ("state", "all"), ("sort", "updated"), ("direction", "desc"), ("per_page", "10")],
        ))
        .await?;
    let Some(p) = github_pick(&list) else { return Ok(None) };
    let Some(mut pr) = github_pr(p) else { return Ok(None) };
    let n = pr.number;
    let reviews = http.detail("reviews", &format!("{root}/pulls/{n}/reviews?per_page=100")).await.unwrap_or(Value::Null);
    pr.reviewers = github_reviewers(p, &reviews);
    if let Some(sha) = pr.head_commit.clone() {
        let runs = http.detail("check runs", &format!("{root}/commits/{sha}/check-runs?per_page=100")).await.unwrap_or(Value::Null);
        let statuses = http.detail("commit statuses", &format!("{root}/commits/{sha}/status?per_page=100")).await.unwrap_or(Value::Null);
        pr.checks = github_checks(&runs, &statuses);
    }
    let mut comments = Vec::new();
    for page in 1..=6 {
        let Some(v) = http.detail("comments", &format!("{root}/pulls/{n}/comments?per_page=100&page={page}")).await else { break };
        let batch = v.as_array().cloned().unwrap_or_default();
        let last = batch.len() < 100;
        comments.extend(batch);
        if last {
            break;
        }
    }
    pr.comments = github_comments(&comments);
    Ok(Some(pr))
}

// ---------------------------------------------------------------- Azure DevOps

pub fn azure_pick(list: &Value) -> Option<&Value> {
    let arr = list["value"].as_array()?;
    arr.iter().find(|p| p["status"] == "active").or_else(|| arr.first())
}

fn strip_heads(r: Option<String>) -> String {
    let r = r.unwrap_or_default();
    r.strip_prefix("refs/heads/").map(str::to_string).unwrap_or(r)
}

pub fn azure_pr(p: &Value, repo_web: &str) -> Option<PullRequest> {
    let id = p["pullRequestId"].as_u64()?;
    let state = match p["status"].as_str() {
        Some("completed") => "merged",
        Some("abandoned") => "closed",
        _ if p["isDraft"] == true => "draft",
        _ => "open",
    };
    let reviewers = p["reviewers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let state = match r["vote"].as_i64().unwrap_or(0) {
                10 => "approved",
                5 => "suggestions",
                -5 => "waiting",
                -10 => "rejected",
                _ => "pending",
            };
            Some(PrReviewer { name: s(r, "/displayName")?, state: state.into(), required: r["isRequired"] == true })
        })
        .collect();
    Some(PullRequest {
        number: id,
        title: s(p, "/title").unwrap_or_default(),
        url: format!("{repo_web}/pullrequest/{id}"),
        state: state.into(),
        author: s(p, "/createdBy/displayName"),
        source_branch: strip_heads(s(p, "/sourceRefName")),
        target_branch: strip_heads(s(p, "/targetRefName")),
        base_ref: None,
        head_commit: s(p, "/lastMergeSourceCommit/commitId"),
        reviewers,
        checks: Vec::new(),
        comments: Vec::new(),
    })
}

/// Branch policies of the pull request (builds, required reviewers, linked work items…).
pub fn azure_checks(evals: &Value, base: &str, project: &str) -> Vec<PrCheck> {
    evals["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["configuration"]["isEnabled"] != false && e["configuration"]["isDeleted"] != true)
        .map(|e| {
            let state = match e["status"].as_str() {
                Some("approved") => "success",
                Some("rejected") | Some("broken") => "failure",
                Some("notApplicable") => "skipped",
                _ => "pending",
            };
            let name = s(e, "/configuration/settings/displayName")
                .filter(|n| !n.is_empty())
                .or_else(|| s(e, "/context/buildDefinitionName"))
                .or_else(|| s(e, "/configuration/type/displayName"))
                .unwrap_or_else(|| "Criterio".into());
            let url = e["context"]["buildId"].as_u64().map(|b| format!("{base}/{project}/_build/results?buildId={b}"));
            PrCheck { name, state: state.into(), url, required: e["configuration"]["isBlocking"] == true }
        })
        .collect()
}

pub fn azure_comments(threads: &Value, pr_web: &str) -> Vec<PrComment> {
    let mut out = Vec::new();
    for t in threads["value"].as_array().into_iter().flatten() {
        if t["isDeleted"] == true {
            continue;
        }
        let Some(id) = t["id"].as_u64() else { continue };
        let ctx = &t["threadContext"];
        let path = s(ctx, "/filePath").map(|p| p.trim_start_matches('/').to_string()).filter(|p| !p.is_empty());
        let right = ctx["rightFileStart"]["line"].as_u64();
        let left = ctx["leftFileStart"]["line"].as_u64();
        let (line, side) = match (right, left) {
            (Some(r), _) => (Some(r as u32), "new"),
            (None, Some(l)) => (Some(l as u32), "old"),
            _ => (None, "new"),
        };
        let resolved = matches!(t["status"].as_str(), Some("fixed" | "wontFix" | "closed" | "byDesign"));
        for c in t["comments"].as_array().into_iter().flatten() {
            if c["commentType"] != "text" || c["isDeleted"] == true {
                continue;
            }
            out.push(PrComment {
                thread: id.to_string(),
                path: path.clone(),
                line,
                side: side.into(),
                author: s(c, "/author/displayName").unwrap_or_default(),
                body: clip(c["content"].as_str().unwrap_or("")),
                at: s(c, "/publishedDate").unwrap_or_default(),
                resolved,
                outdated: false,
                url: Some(format!("{pr_web}?discussionId={id}")),
            });
            if out.len() >= MAX_COMMENTS {
                return out;
            }
        }
    }
    out
}

async fn azure(http: &Http, base: &str, project: &str, repo: &str, branch: &str, repo_web: &str) -> Result<Option<PullRequest>, Fail> {
    let api = format!("{base}/{project}/_apis/git/repositories/{repo}");
    let source = format!("refs/heads/{branch}");
    let list = http
        .get(&with_query(
            &format!("{api}/pullrequests"),
            &[("searchCriteria.sourceRefName", &source), ("searchCriteria.status", "all"), ("$top", "10"), ("api-version", "7.1")],
        ))
        .await?;
    let Some(p) = azure_pick(&list) else { return Ok(None) };
    let Some(mut pr) = azure_pr(p, repo_web) else { return Ok(None) };
    let id = pr.number;
    if let Some(project_id) = s(p, "/repository/project/id") {
        let artifact = format!("vstfs:///CodeReview/CodeReviewId/{project_id}/{id}");
        let url = with_query(&format!("{base}/{project}/_apis/policy/evaluations"), &[("artifactId", &artifact), ("api-version", "7.1-preview.1")]);
        if let Some(v) = http.detail("policies", &url).await {
            pr.checks = azure_checks(&v, base, project);
        }
    }
    if let Some(v) = http.detail("threads", &format!("{api}/pullRequests/{id}/threads?api-version=7.1")).await {
        pr.comments = azure_comments(&v, &pr.url);
    }
    Ok(Some(pr))
}

// ---------------------------------------------------------------- lookup

/// What the repository says about the branch, gathered before any network call.
struct Local {
    dir: PathBuf,
    branch: String,
    remote_name: String,
    remote_branch: String,
    remote: Remote,
    auth: Option<Auth>,
}

fn lookup(status: &str) -> PrLookup {
    PrLookup { status: status.into(), provider: None, branch: None, repo_url: None, message: None, pr: None }
}

fn config(dir: &Path, key: &str) -> Option<String> {
    let out = gitcmd::run(dir, Mode::Read, &["config", "--get", key]).ok()?;
    out.ok().then(|| out.stdout_str().trim().to_string()).filter(|v| !v.is_empty())
}

fn local_info(root: &str) -> Result<Result<Local, PrLookup>, String> {
    let dir = crate::review::toplevel(root)?;
    let head = gitcmd::run(&dir, Mode::Read, &["symbolic-ref", "--quiet", "--short", "HEAD"])?;
    if !head.ok() {
        return Ok(Err(lookup("detached")));
    }
    let branch = head.stdout_str().trim().to_string();
    let configured = config(&dir, &format!("branch.{branch}.remote")).filter(|r| r != ".");
    let mut found = None;
    for name in configured.iter().map(String::as_str).chain(["origin"]) {
        let out = gitcmd::run(&dir, Mode::Read, &["remote", "get-url", "--", name])?;
        if out.ok() {
            found = Some((name.to_string(), out.stdout_str().trim().to_string()));
            break;
        }
    }
    let Some((remote_name, url)) = found else {
        return Ok(Err(PrLookup { branch: Some(branch), ..lookup("noremote") }));
    };
    let Some(remote) = parse_remote(&url) else {
        let host = split_url(&url).map(|(h, _)| h).unwrap_or_default();
        return Ok(Err(PrLookup { branch: Some(branch), message: Some(host), ..lookup("unsupported") }));
    };
    let remote_branch = config(&dir, &format!("branch.{branch}.merge"))
        .map(|m| m.strip_prefix("refs/heads/").map(str::to_string).unwrap_or(m))
        .unwrap_or_else(|| branch.clone());
    let auth = auth_for(&dir, &remote);
    Ok(Ok(Local { dir, branch, remote_name, remote_branch, remote, auth }))
}

/// The target branch as a local ref: its remote-tracking branch, else the local branch.
fn resolve_base(dir: &Path, remote: &str, target: &str) -> Option<String> {
    if target.is_empty() || target.starts_with('-') {
        return None;
    }
    for (full, short) in [(format!("refs/remotes/{remote}/{target}"), format!("{remote}/{target}")), (format!("refs/heads/{target}"), target.to_string())] {
        let out = gitcmd::run(dir, Mode::Read, &["rev-parse", "--verify", "--quiet", &format!("{full}^{{commit}}")]).ok()?;
        if out.ok() {
            return Some(short);
        }
    }
    None
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("task failed: {e}"))
}

pub async fn pull_request(root: String) -> Result<PrLookup, String> {
    let local = match blocking(move || local_info(&root)).await?? {
        Ok(l) => l,
        Err(early) => return Ok(early),
    };
    let base = PrLookup {
        provider: Some(local.remote.provider().into()),
        branch: Some(local.branch.clone()),
        repo_url: Some(local.remote.web_url()),
        ..lookup("none")
    };
    let had_auth = local.auth.is_some();
    let http = Http::new(local.auth, matches!(local.remote, Remote::GitHub { .. }))?;
    let found = match &local.remote {
        Remote::GitHub { api, owner, repo, .. } => github(&http, api, owner, repo, &local.remote_branch).await,
        Remote::Azure { base: org, project, repo } => azure(&http, org, project, repo, &local.remote_branch, &local.remote.web_url()).await,
    };
    match found {
        Ok(None) => Ok(base),
        Ok(Some(mut pr)) => {
            let (dir, remote, target) = (local.dir, local.remote_name, pr.target_branch.clone());
            pr.base_ref = blocking(move || resolve_base(&dir, &remote, &target)).await?;
            let warnings = http.warnings.lock().map(|w| w.join("; ")).unwrap_or_default();
            let message = (!warnings.is_empty()).then_some(warnings);
            Ok(PrLookup { status: "found".into(), pr: Some(pr), message, ..base })
        }
        Err(Fail::Auth(m)) => {
            let m = if had_auth { m } else { format!("no credentials ({m})") };
            Ok(PrLookup { status: "auth".into(), message: Some(m), ..base })
        }
        Err(Fail::Other(m)) => Ok(PrLookup { status: "error".into(), message: Some(m), ..base }),
    }
}

// ---------------------------------------------------------------- opening links

/// Opens a web page in the default browser (https only).
pub fn open_url(url: &str) -> Result<(), String> {
    let ok = url.starts_with("https://") && !url.chars().any(|c| c.is_whitespace() || c == '"' || c.is_control());
    if !ok {
        return Err("only https links can be opened".into());
    }
    #[cfg(windows)]
    let mut c = {
        let mut c = Command::new("rundll32.exe");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut c = {
        let mut c = Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut c = {
        let mut c = Command::new("xdg-open");
        c.arg(url);
        c
    };
    no_window(&mut c);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map(|_| ()).map_err(|e| format!("cannot open the browser: {e}"))
}
