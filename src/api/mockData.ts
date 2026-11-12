// Sample file contents for the in-browser mock.

export const LOG_RS = `use std::path::Path;
use std::process::Command;

pub struct Commit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
}

/// Legge la cronologia a pagine: mai tutto il log in memoria.
pub fn log(repo: &Path, page: Page) -> Result<Vec<Commit>> {
    let out = Command::new("git")
        .current_dir(repo)
        .args(["log", "--format=%H%x00%P%x00%s"])
        .arg(format!("--skip={}", page.skip))
        .arg(format!("--max-count={}", page.limit))
        .output()?;
    parse(&out.stdout)
}

pub struct Page {
    pub skip: usize,
    pub limit: usize,
}

fn parse(raw: &[u8]) -> Result<Vec<Commit>> {
    let text = String::from_utf8_lossy(raw);
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\\0');
        let hash = parts.next().unwrap_or_default().to_string();
        let parents = parts
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let subject = parts.next().unwrap_or_default().to_string();
        out.push(Commit { hash, parents, subject });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_one_line() {
        let raw = b"abc\\0def\\0primo commit\\n";
        let commits = parse(raw).unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "primo commit");
    }
}
`;

export const LOG_RS_HEAD = LOG_RS.replace(
  `        .args(["log", "--format=%H%x00%P%x00%s"])
        .arg(format!("--skip={}", page.skip))`,
  `        .args(["log", "--format=%H%x00%P%x00%s"])`,
).replace("/// Legge la cronologia a pagine: mai tutto il log in memoria.\n", "");

export const DIFF_RS = `use std::path::Path;
use std::process::Command;

use crate::git::Result;

#[derive(Debug, Clone, PartialEq)]
pub enum LineKind {
    Context,
    Added,
    Deleted,
}

#[derive(Debug, Clone)]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
}

pub fn diff(repo: &Path, rev: &str) -> Result<Vec<DiffLine>> {
    let out = Command::new("git")
        .current_dir(repo)
        .args(["show", "--patch", rev])
        .arg("--no-color")
        .arg("--find-renames")
        .output()?;
    parse_patch(&out.stdout)
}

fn parse_patch(raw: &[u8]) -> Result<Vec<DiffLine>> {
    let text = String::from_utf8_lossy(raw);
    let mut lines = Vec::new();
    let (mut old_no, mut new_no) = (0u32, 0u32);
    for l in text.lines() {
        if let Some(rest) = l.strip_prefix("@@ ") {
            let (a, b) = header(rest);
            old_no = a;
            new_no = b;
            continue;
        }
        let (kind, body) = match l.chars().next() {
            Some('+') => (LineKind::Added, &l[1..]),
            Some('-') => (LineKind::Deleted, &l[1..]),
            _ => (LineKind::Context, l.get(1..).unwrap_or("")),
        };
        let line = DiffLine {
            old_no: (kind != LineKind::Added).then_some(old_no),
            new_no: (kind != LineKind::Deleted).then_some(new_no),
            kind: kind.clone(),
            text: body.to_string(),
        };
        if kind != LineKind::Added { old_no += 1; }
        if kind != LineKind::Deleted { new_no += 1; }
        lines.push(line);
    }
    Ok(lines)
}

fn header(rest: &str) -> (u32, u32) {
    let mut it = rest.split_whitespace();
    let num = |s: Option<&str>| {
        s.and_then(|s| s[1..].split(',').next())
            .and_then(|n| n.parse().ok())
            .unwrap_or(1)
    };
    (num(it.next()), num(it.next()))
}
`;

export const WORKTREE_RS = `use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
    pub head: String,
    pub is_main: bool,
}

/// Elenca i worktree con \`git worktree list --porcelain\`.
pub fn list(repo: &Path) -> std::io::Result<Vec<Worktree>> {
    let out = Command::new("git")
        .current_dir(repo)
        .args(["worktree", "list", "--porcelain"])
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut all = Vec::new();
    for block in text.split("\\n\\n").filter(|b| !b.trim().is_empty()) {
        let mut wt = Worktree { path: PathBuf::new(), branch: None, head: String::new(), is_main: all.is_empty() };
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") { wt.path = PathBuf::from(p); }
            if let Some(h) = line.strip_prefix("HEAD ") { wt.head = h.to_string(); }
            if let Some(b) = line.strip_prefix("branch refs/heads/") { wt.branch = Some(b.to_string()); }
        }
        all.push(wt);
    }
    Ok(all)
}
`;

export const GIT_MOD_RS = `pub mod diff;
pub mod log;
pub mod worktree;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Git(String),
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
`;

export const MAIN_RS = `mod editor;
mod git;
mod tree;

use std::env;
use std::path::PathBuf;

/// Punto di ingresso: apre la cartella passata come argomento.
fn main() {
    let root = env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| env::current_dir().expect("cartella corrente"));
    println!("ide-lite su {}", root.display());
    let files = tree::list(&root).unwrap_or_default();
    for f in files.iter().take(10) {
        println!("  {}", f);
    }
}
`;

export const TREE_RS = `use std::fs;
use std::path::Path;

/// Figli diretti di una cartella: prima le cartelle, poi i file.
pub fn list(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            dirs.push(name);
        } else {
            files.push(name);
        }
    }
    dirs.sort_by_key(|n| n.to_lowercase());
    files.sort_by_key(|n| n.to_lowercase());
    dirs.extend(files);
    Ok(dirs)
}
`;

export const EDITOR_MOD_RS = `pub mod buffer;
pub mod keymap;

pub use buffer::Buffer;
`;

export const BUFFER_RS = `#[derive(Debug, Default)]
pub struct Buffer {
    pub path: String,
    pub text: String,
    pub dirty: bool,
    pub crlf: bool,
}

impl Buffer {
    pub fn new(path: &str, raw: &str) -> Self {
        let crlf = raw.contains("\\r\\n");
        Buffer { path: path.into(), text: raw.replace("\\r\\n", "\\n"), dirty: false, crlf }
    }

    pub fn to_disk(&self) -> String {
        if self.crlf { self.text.replace('\\n', "\\r\\n") } else { self.text.clone() }
    }
}
`;

export const KEYMAP_RS = `use std::collections::HashMap;

/// Tabella dei tasti: sequenza -> comando.
pub struct Keymap {
    pub bindings: HashMap<&'static str, &'static str>,
}

impl Keymap {
    pub fn emacs() -> Self {
        let mut bindings = HashMap::new();
        bindings.insert("C-x C-f", "file.quickOpen");
        bindings.insert("C-x C-s", "file.save");
        bindings.insert("C-x b", "buffer.switch");
        bindings.insert("M-x", "palette.open");
        Keymap { bindings }
    }
}
`;

export const APP_TS_HEAD = `import { createSignal } from "solid-js";

export interface Settings {
  theme: "dark" | "light";
  fontSize: number;
}

export const defaults: Settings = {
  theme: "dark",
  fontSize: 13,
};

export function useSettings() {
  const [settings, setSettings] = createSignal<Settings>(defaults);
  return { settings, setSettings };
}
`;

export const APP_TS_INDEX = APP_TS_HEAD.replace("fontSize: 13,", "fontSize: 12.5,");

export const APP_TS = APP_TS_INDEX.replace(
  "export function useSettings() {",
  `/** Legge le impostazioni salvate, se ci sono. */
export function loadSettings(raw: string | null): Settings {
  if (!raw) return defaults;
  try {
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export function useSettings() {`,
);

export const MAIN_TSX = `import { render } from "solid-js/web";
import { For, createSignal } from "solid-js";
import { Button } from "./components/Button";

function App() {
  const [count, setCount] = createSignal(0);
  const items = ["uno", "due", "tre"];
  return (
    <main class="app">
      <h1>Esempio</h1>
      <Button onClick={() => setCount(count() + 1)}>Cliccato {count()} volte</Button>
      <ul>
        <For each={items}>{(item) => <li>{item}</li>}</For>
      </ul>
    </main>
  );
}

render(() => <App />, document.getElementById("root")!);
`;

export const BUTTON_JSX = `export function Button(props) {
  return (
    <button type="button" class="btn" onClick={props.onClick}>
      {props.children}
    </button>
  );
}
`;

export const LIST_TSX = `import { For, type JSX } from "solid-js";

export interface ListProps<T> {
  items: T[];
  render: (item: T, index: number) => JSX.Element;
  empty?: string;
}

export function List<T>(props: ListProps<T>) {
  return (
    <ul class="list">
      <For each={props.items} fallback={<li class="empty">{props.empty ?? "Nessun elemento"}</li>}>
        {(item, i) => <li>{props.render(item, i())}</li>}
      </For>
    </ul>
  );
}
`;

export const LIST_VIEW_TSX = LIST_TSX.replace(/List</g, "ListView<").replace("function List<", "function ListView<").replace("ListProps", "ListViewProps");

export const UTIL_JS = `// Piccole utilità senza dipendenze.
export const debounce = (fn, ms = 200) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

export const STYLES_CSS = `:root {
  --bg: #17191c;
  --panel: #1e2126;
  --line: #2f343b;
  --text: #d7dae0;
  --muted: #9aa0aa;
  --accent: #e8b04a;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 13px/1.45 Inter, system-ui, sans-serif;
}

.btn {
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: inherit;
}

.btn:hover {
  border-color: var(--accent);
}
`;

export const THEME_JSON = `{
  "name": "ide-lite scuro",
  "colors": {
    "background": "#17191c",
    "panel": "#1e2126",
    "accent": "#e8b04a"
  },
  "fontSize": 12.5,
  "ligatures": false
}
`;

export const PACKAGE_JSON = `{
  "name": "ide-lite-demo",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build"
  },
  "dependencies": {
    "solid-js": "^1.9.3"
  }
}
`;

export const TSCONFIG_JSON = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "strict": true,
    "jsx": "preserve",
    "jsxImportSource": "solid-js"
  },
  "include": ["ui"]
}
`;

export const INDEX_HTML = `<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <title>ide-lite</title>
    <link rel="stylesheet" href="/ui/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/ui/main.tsx"></script>
  </body>
</html>
`;

export const README_MD = `# ide-lite

Un IDE **leggerissimo** pensato per la tastiera.

## Obiettivi

- avvio istantaneo
- scorciatoie Emacs mostrate a schermo
- cronologia git e worktree a portata di mano

## Tasti principali

| Tasto     | Comando          |
|-----------|------------------|
| \`C-x C-f\` | apri file        |
| \`C-x C-s\` | salva            |
| \`C-x w\`   | cerca worktree   |

> Suggerimento: \`C-h\` mostra tutte le scorciatoie.
`;

export const CARGO_TOML = `[package]
name = "ide-lite"
version = "0.3.0"
edition = "2021"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
lto = true
codegen-units = 1
strip = true
`;

export const CI_YML = `name: ci
on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm run build
      - run: cargo test --manifest-path src-tauri/Cargo.toml
`;

export const SETTINGS_YAML = `# Impostazioni di esempio
editor:
  font_size: 12.5
  tab_size: 4
  keymap: emacs
git:
  log_page: 200
  show_remote_branches: true
`;

export const RELEASE_PY = `#!/usr/bin/env python3
"""Prepara una release: aggiorna la versione e crea il tag."""

import re
import subprocess
import sys
from pathlib import Path

VERSION_RE = re.compile(r'^version = "(\\d+)\\.(\\d+)\\.(\\d+)"', re.M)


def bump(kind: str) -> str:
    cargo = Path("Cargo.toml")
    text = cargo.read_text(encoding="utf-8")
    major, minor, patch = map(int, VERSION_RE.search(text).groups())
    if kind == "major":
        major, minor, patch = major + 1, 0, 0
    elif kind == "minor":
        minor, patch = minor + 1, 0
    else:
        patch += 1
    version = f"{major}.{minor}.{patch}"
    cargo.write_text(VERSION_RE.sub(f'version = "{version}"', text), encoding="utf-8")
    return version


def main() -> int:
    kind = sys.argv[1] if len(sys.argv) > 1 else "patch"
    version = bump(kind)
    subprocess.run(["git", "tag", f"v{version}"], check=True)
    print(f"creato v{version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

export const GITIGNORE = `target/
node_modules/
dist/
.env
`;

export const ARCH_MD = [
  "# Architettura",
  "",
  "Questo file usa fine riga **CRLF** (Windows).",
  "",
  "- `src/git`: comandi git",
  "- `src/tree`: albero dei file",
  "- `ui`: interfaccia",
  "",
].join("\r\n");

export const NOTE_WINDOWS = ["Note per Windows", "", "I percorsi lunghi richiedono core.longpaths = true.", "Le fine riga sono CRLF.", ""].join("\r\n");

export const TODO_MD = `# Da fare

- [ ] ricerca nel progetto
- [ ] diff affiancato
- [x] selettore worktree
`;

export const LEGACY_RS = `// Vecchio parser, sostituito da git/log.rs
pub fn parse_old(raw: &str) -> Vec<String> {
    raw.lines().map(|l| l.to_string()).collect()
}
`;

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect x="3" y="3" width="18" height="18" rx="4" fill="#e8b04a" />
  <path d="M8 8h8M8 12h5M8 16h8" stroke="#17191c" stroke-width="2" />
</svg>
`;

export function generatedTables(): string {
  const lines = ["// File generato: non modificare a mano.", "", "pub static TABLE: [(u32, &str); 3000] = ["];
  for (let i = 0; i < 3000; i++) lines.push(`    (${i}, "voce-${String(i).padStart(4, "0")}"),`);
  lines.push("];", "");
  return lines.join("\n");
}

export function fixture(i: number): string {
  return `{\n  "id": ${i},\n  "nome": "elemento ${i}",\n  "attivo": ${i % 3 !== 0}\n}\n`;
}

export function dumpSql(lines: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(`INSERT INTO voci (id, nome) VALUES (${i}, 'voce ${i}');`);
  return out;
}

export const SUBJECTS = [
  "aggiunge test", "corregge un caso limite", "semplifica il codice", "migliora i messaggi d'errore",
  "riduce le allocazioni", "rinomina le funzioni", "aggiorna la documentazione", "gestisce i percorsi Windows",
  "evita un panic", "carica i dati a pagine", "aggiunge la cache", "pulisce gli import", "supporta CRLF",
  "mostra lo stato", "ordina le voci", "virtualizza l'elenco", "tasti Emacs", "colori del tema",
  "gestisce i file binari", "limita la dimensione", "corregge il focus", "aggiunge un'opzione",
];

export const SCOPES = ["git", "tree", "editor", "keys", "ui", "worktree", "diff", "log", "theme", "build"];
export const KINDS = ["feat", "fix", "perf", "refactor", "chore", "docs", "test"];
export const AUTHORS = ["Mattia Rossi", "Giulia Bianchi", "Luca Verdi", "Sara Neri", "Paolo Gallo"];

export const WT_BRANCHES = [
  "fix/tree-perf", "feat/worktree-picker", "feat/hint-bar", "feat/emacs-keymap", "feat/quick-open",
  "feat/project-search", "feat/syntax-highlight", "feat/diff-side-by-side", "feat/file-watcher",
  "feat/session-restore", "fix/crlf-diff", "fix/windows-long-paths", "fix/log-pagination", "fix/tree-symlinks",
  "perf/lazy-git-log", "perf/startup-time", "refactor/git-module", "refactor/keymap-table", "chore/ci-windows",
  "chore/deps-update", "docs/readme", "spike/tui-ratatui",
];
