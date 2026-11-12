// In-browser mock of the backend, used by `npm run dev` outside Tauri.
// Everything lives in memory; writes are lost on reload.

import type {
  Api, Commit, CommitFile, CommitRef, DiffHunk, DiffLine, DirEntry, FileContent, FileDiff, FileStatus,
  FolderEntry, FolderListing, RepoEntry, RepoInfo, StatusEntry, UpdateState, Worktree, WorktreeStatus,
} from "./types";
import * as D from "./mockData";

// ---------------------------------------------------------------- helpers

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const latency = (min = 15, max = 70) => sleep(min + Math.random() * (max - min));

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const splitLines = (text: string): string[] => {
  const l = text.split(/\r?\n/);
  if (l.length && l[l.length - 1] === "") l.pop();
  return l;
};

// ---------------------------------------------------------------- files

interface MockFile {
  text?: string;
  gen?: () => string;
  binary?: boolean;
  tooLarge?: boolean;
}

const PARENT = "C:/Users/dev/workspace";
const MAIN = `${PARENT}/ide-lite`;

const repoFs = new Map<string, MockFile>();
const put = (path: string, f: MockFile | string) => repoFs.set(path, typeof f === "string" ? { text: f } : f);

put(".github/workflows/ci.yml", D.CI_YML);
put(".gitignore", D.GITIGNORE);
put("Cargo.toml", D.CARGO_TOML);
put("Cargo.lock", { gen: () => Array.from({ length: 40 }, (_, i) => `[[package]]\nname = "crate-${i}"\nversion = "1.${i}.0"\n`).join("\n") });
put("README.md", D.README_MD);
put("package.json", D.PACKAGE_JSON);
put("tsconfig.json", D.TSCONFIG_JSON);
put("index.html", D.INDEX_HTML);
put("assets/logo.png", { binary: true });
put("assets/icon.svg", D.ICON_SVG);
put("config/settings.yaml", D.SETTINGS_YAML);
put("data/huge.log", { tooLarge: true });
put("docs/architettura.md", D.ARCH_MD);
put("docs/note-windows.txt", D.NOTE_WINDOWS);
put("notes/todo.md", D.TODO_MD);
put("scripts/release.py", D.RELEASE_PY);
put("src/main.rs", D.MAIN_RS);
put("src/editor/mod.rs", D.EDITOR_MOD_RS);
put("src/editor/buffer.rs", D.BUFFER_RS);
put("src/editor/keymap.rs", D.KEYMAP_RS);
put("src/generated/tables.rs", { gen: D.generatedTables });
put("src/git/mod.rs", D.GIT_MOD_RS);
put("src/git/diff.rs", D.DIFF_RS);
put("src/git/log.rs", D.LOG_RS);
put("src/git/worktree.rs", D.WORKTREE_RS);
put("src/tree/mod.rs", D.TREE_RS);
put("ui/app.ts", D.APP_TS);
put("ui/main.tsx", D.MAIN_TSX);
put("ui/util.js", D.UTIL_JS);
put("ui/styles.css", D.STYLES_CSS);
put("ui/theme.json", D.THEME_JSON);
put("ui/components/Button.jsx", D.BUTTON_JSX);
put("ui/components/List.tsx", D.LIST_TSX);
for (let i = 1; i <= 2500; i++) {
  const n = i;
  put(`fixtures/many/item-${String(n).padStart(4, "0")}.json`, { gen: () => D.fixture(n) });
}
put("target/debug/ide-lite.exe", { binary: true });
put("target/.rustc_info.json", '{"rustc": "1.90.0"}\n');
put("node_modules/solid-js/package.json", '{ "name": "solid-js", "version": "1.9.3" }\n');
put("dist/index.html", D.INDEX_HTML);

const plainFs = new Map<string, MockFile>([
  ["leggimi.txt", { text: "Cartella senza git.\nQui le viste git sono vuote.\n" }],
  ["esempio.py", { text: 'def saluta(nome: str) -> str:\n    return f"Ciao {nome}"\n\nprint(saluta("mondo"))\n' }],
  ["dati/valori.json", { text: '{\n  "a": 1,\n  "b": [2, 3]\n}\n' }],
]);

const isIgnored = (path: string) => /^(target|node_modules|dist)(\/|$)/.test(path) || path === ".env";

function fileText(f: MockFile): string {
  return f.text ?? f.gen?.() ?? "";
}

/** Original contents of files modified through writeFile, for diffs and status. */
const original = new Map<string, string | null>();

// ---------------------------------------------------------------- history

interface Raw {
  hash: string;
  parents: string[];
  subject: string;
  author: string;
  date: number;
}

function buildHistory() {
  const r = rng(7);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const hex = () => {
    let s = "";
    for (let i = 0; i < 40; i++) s += "0123456789abcdef"[Math.floor(r() * 16)];
    return s;
  };
  const list: Raw[] = [];
  let t = Math.floor(Date.now() / 1000) - 296 * 5 * 3600 - 3 * 3600;
  const mk = (subject: string, parents: string[]) => {
    t += 900 + Math.floor(r() * 9 * 3600);
    const c: Raw = { hash: hex(), parents, subject, author: pick(D.AUTHORS), date: t };
    list.push(c);
    return c.hash;
  };
  const subj = (branch?: string) => {
    const scope = branch ? branch.split("/")[1].split("-")[0] : pick(D.SCOPES);
    const kind = branch ? branch.split("/")[0] : pick(D.KINDS);
    return `${kind}(${scope}): ${pick(D.SUBJECTS)}`;
  };
  let main = mk("chore: scheletro del progetto", []);
  const mainLine: string[] = [main];
  const active: { name: string; tip: string }[] = [];
  const done: { name: string; tip: string }[] = [];
  const names = [...D.WT_BRANCHES];
  let extra = 0;
  let octopus = false;
  while (list.length < 296) {
    const x = r();
    if (active.length < 6 && (x < 0.12 || (active.length === 0 && x < 0.5))) {
      const name = names.shift() ?? `fix/varie-${++extra}`;
      active.push({ name, tip: mk(subj(name), [main]) });
    } else if (active.length === 0 || x < 0.4) {
      main = mk(subj(), [main]);
      mainLine.push(main);
    } else if (x < 0.86) {
      const b = pick(active);
      b.tip = mk(subj(b.name), [b.tip]);
    } else if (!octopus && active.length >= 3 && list.length > 100) {
      const [a, b] = active.splice(0, 2);
      main = mk(`merge ${a.name} e ${b.name}`, [main, a.tip, b.tip]);
      mainLine.push(main);
      done.push(a, b);
      octopus = true;
    } else {
      const [b] = active.splice(Math.floor(r() * active.length), 1);
      main = mk(`merge ${b.name}`, [main, b.tip]);
      mainLine.push(main);
      done.push(b);
    }
  }
  const g1 = mk("feat(git): grafo dei commit", [main]);
  const g2 = mk("feat(git): diff per commit", [g1]);
  // the newest commit is two hours old
  const shift = Math.floor(Date.now() / 1000) - 2 * 3600 - t;
  for (const c of list) c.date += shift;
  const branchTips = new Map<string, string>();
  for (const b of [...done, ...active]) branchTips.set(b.name, b.tip);
  branchTips.set("main", main);
  branchTips.set("feat/git-graph", g2);
  for (const n of names) branchTips.set(n, mainLine[Math.floor(mainLine.length * 0.7)]);

  const refs = new Map<string, CommitRef[]>();
  const addRef = (hash: string, ref: CommitRef) => refs.set(hash, [...(refs.get(hash) ?? []), ref]);
  for (const [name, tip] of branchTips) if (name !== "spike/tui-ratatui") addRef(tip, { name, kind: "branch" });
  addRef(mainLine[mainLine.length - 2], { name: "origin/main", kind: "remote" });
  addRef(g1, { name: "origin/feat/git-graph", kind: "remote" });
  for (const b of active.slice(0, 2)) addRef(b.tip, { name: `origin/${b.name}`, kind: "remote" });
  [0.2, 0.4, 0.6, 0.8].forEach((f, i) => addRef(mainLine[Math.floor(mainLine.length * f)], { name: `v0.${i + 1}.0`, kind: "tag" }));

  const newestFirst = list.slice().reverse();
  return { commits: newestFirst, refs, branchTips, mainTip: main, g1, g2, mainLine };
}

const H = buildHistory();
const byHash = new Map(H.commits.map((c) => [c.hash, c]));

function ancestors(hash: string): Set<string> {
  const seen = new Set<string>();
  const stack = [hash];
  while (stack.length) {
    const h = stack.pop()!;
    if (seen.has(h)) continue;
    seen.add(h);
    const c = byHash.get(h);
    if (c) stack.push(...c.parents);
  }
  return seen;
}

function resolve(rev: string | null): string | null {
  if (!rev) return null;
  if (H.branchTips.has(rev)) return H.branchTips.get(rev)!;
  if (byHash.has(rev)) return rev;
  for (const [h, rs] of H.refs) if (rs.some((r) => r.name === rev)) return h;
  return null;
}

function aheadBehind(a: string, b: string): { ahead: number; behind: number } {
  const A = ancestors(a);
  const B = ancestors(b);
  let ahead = 0;
  let behind = 0;
  for (const h of A) if (!B.has(h)) ahead++;
  for (const h of B) if (!A.has(h)) behind++;
  return { ahead, behind };
}

// ---------------------------------------------------------------- worktrees

const INITIAL = `${PARENT}/ide-lite.feat-git-graph`;

const worktrees: Worktree[] = [
  { path: MAIN, branch: "main", head: H.mainTip, isMain: true, isCurrent: false, detached: false, locked: false, prunable: false },
  { path: INITIAL, branch: "feat/git-graph", head: H.g2, isMain: false, isCurrent: false, detached: false, locked: false, prunable: false },
  ...D.WT_BRANCHES.map((b): Worktree => {
    const detached = b === "spike/tui-ratatui";
    return {
      path: `${PARENT}/ide-lite.${b.replace(/\//g, "-")}`,
      branch: detached ? null : b,
      head: detached ? H.mainLine[Math.floor(H.mainLine.length * 0.6)] : H.branchTips.get(b)!,
      isMain: false,
      isCurrent: false,
      detached,
      locked: b === "chore/deps-update",
      prunable: b === "fix/tree-symlinks",
    };
  }),
];

function worktreeOf(root: string): Worktree | null {
  const r = norm(root);
  let best: Worktree | null = null;
  for (const w of worktrees) if ((r === w.path || r.startsWith(w.path + "/")) && (!best || w.path.length > best.path.length)) best = w;
  return best;
}

// ---------------------------------------------------------------- fake filesystem (folder browser, findRepos)

interface FNode {
  repo?: { branch: string | null; linked?: boolean; main?: string };
  files?: string[];
  denied?: boolean;
}

const PROGETTI = "C:/Users/dev/progetti";
const folders = new Map<string, FNode>();

function canon(p: string): string {
  const s = p.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/*$/.test(s)) return s.slice(0, 2).toUpperCase() + "/";
  return s.replace(/\/+$/, "") || "/";
}

function parentOf(p: string): string {
  if (/^[A-Z]:\/$/.test(p)) return "";
  const i = p.lastIndexOf("/");
  const head = p.slice(0, i);
  return /^[A-Z]:$/.test(head) ? head + "/" : head;
}

function addFolder(path: string, node: FNode = {}): void {
  folders.set(path, { ...folders.get(path), ...node });
  for (let p = parentOf(path); p; p = parentOf(p)) if (!folders.has(p)) folders.set(p, {});
}

addFolder("C:/Users/dev/Documenti", { files: ["lettera.md", "spese.csv"] });
addFolder("C:/Users/dev/Scaricati", { files: ["installer.txt"] });
addFolder("C:/Users/dev/.config/ide-lite");
addFolder("C:/Users/dev/workspace");
addFolder("C:/Users/Public");
addFolder("C:/Program Files/Git");
addFolder("C:/Windows/System32");
addFolder("C:/System Volume Information", { denied: true });
addFolder("D:/backup/vecchi-progetti/gestionale", { repo: { branch: "master" } });
addFolder("D:/foto/2025");
// a container with repositories at mixed depths (some linked worktrees, some too deep or skipped)
addFolder(PROGETTI, { files: ["leggimi.md"] });
addFolder(`${PROGETTI}/app-web`, { repo: { branch: "main" } });
addFolder(`${PROGETTI}/app-web.release`, { repo: { branch: "release/2.0", linked: true, main: `${PROGETTI}/app-web` } });
addFolder(`${PROGETTI}/api-server`, { repo: { branch: "develop" } });
addFolder(`${PROGETTI}/appunti`, { files: ["idee.md", "riunione.txt"] });
addFolder(`${PROGETTI}/clienti/rossi-sito`, { repo: { branch: "main" } });
addFolder(`${PROGETTI}/clienti/bianchi-shop`, { repo: { branch: "feat/carrello" } });
addFolder(`${PROGETTI}/clienti/archivio/vecchio-crm`, { repo: { branch: null } });
addFolder(`${PROGETTI}/clienti/archivio/profondo/ancora/repo-troppo-profondo`, { repo: { branch: "main" } });
addFolder(`${PROGETTI}/librerie/utils-ts`, { repo: { branch: "main" } });
addFolder(`${PROGETTI}/librerie/utils-ts.fix-date`, { repo: { branch: "fix/date", linked: true, main: `${PROGETTI}/librerie/utils-ts` } });
addFolder(`${PROGETTI}/node_modules/left-pad`, { repo: { branch: "main" } });
addFolder(`${PROGETTI}/.cache/clone`, { repo: { branch: "main" } });
addFolder(`${PROGETTI}/vuota`);

const extraRepoPaths = () => [...folders].filter(([, n]) => n.repo).map(([p]) => p);

/** Repository (not one of the ide-lite worktrees) that contains `p`. */
function extraRepoOf(p: string): string | null {
  const r = canon(p);
  let best: string | null = null;
  for (const rp of extraRepoPaths()) if ((r === rp || r.startsWith(rp + "/")) && (!best || rp.length > best.length)) best = rp;
  return best;
}

const extraFs = new Map<string, Map<string, MockFile>>();
function extraFsOf(repoPath: string): Map<string, MockFile> {
  let fs = extraFs.get(repoPath);
  if (!fs) {
    const name = repoPath.slice(repoPath.lastIndexOf("/") + 1);
    fs = new Map<string, MockFile>([
      ["README.md", { text: `# ${name}\n\nRepository di esempio del mock.\n` }],
      ["package.json", { text: `{\n  "name": "${name}",\n  "version": "1.0.0"\n}\n` }],
      ["src/index.ts", { text: `export function main(): void {\n  console.log("${name}");\n}\n` }],
      ["src/util.ts", { text: "export const somma = (a: number, b: number) => a + b;\n" }],
      ["docs/note.md", { text: "- da fare\n" }],
    ]);
    extraFs.set(repoPath, fs);
  }
  return fs;
}

/** Direct sub-folders of an absolute folder in the fake filesystem. */
function subfolders(abs: string): string[] {
  const wt = worktreeOf(abs);
  if (wt) {
    const rel = abs === wt.path ? "" : abs.slice(wt.path.length + 1);
    return listDir(repoFs, rel).filter((e) => e.kind === "dir").map((e) => `${wt.path}/${e.path}`);
  }
  const er = extraRepoOf(abs);
  if (er && er !== abs) {
    const rel = abs.slice(er.length + 1);
    return listDir(extraFsOf(er), rel).filter((e) => e.kind === "dir").map((e) => `${er}/${e.path}`);
  }
  const out = new Set<string>();
  for (const p of folders.keys()) if (parentOf(p) === abs) out.add(p);
  for (const w of worktrees) if (parentOf(w.path) === abs) out.add(w.path);
  if (er) for (const e of listDir(extraFsOf(er), "")) if (e.kind === "dir") out.add(`${er}/${e.path}`);
  return [...out];
}

function folderExists(abs: string): boolean {
  return folders.has(abs) || !!worktreeOf(abs) || !!extraRepoOf(abs);
}

function repoMark(abs: string): { isRepo: boolean; branch: string | null; linked: boolean } {
  const w = worktrees.find((x) => x.path === abs);
  if (w) return { isRepo: true, branch: w.branch, linked: !w.isMain };
  const n = folders.get(abs);
  if (n?.repo) return { isRepo: true, branch: n.repo.branch, linked: !!n.repo.linked };
  return { isRepo: false, branch: null, linked: false };
}

/** Files of a plain folder of the fake filesystem, as a workspace (stops at repositories). */
function plainTreeFs(rootAbs: string): Map<string, MockFile> {
  const fs = new Map<string, MockFile>();
  const walk = (abs: string, rel: string) => {
    for (const f of folders.get(abs)?.files ?? []) fs.set(rel + f, { text: `${f}\n\nFile di esempio in ${abs}.\n` });
    for (const sub of subfolders(abs)) {
      const name = sub.slice(sub.lastIndexOf("/") + 1);
      if (!repoMark(sub).isRepo && !folders.get(sub)?.denied) walk(sub, `${rel}${name}/`);
    }
  };
  walk(rootAbs, "");
  return fs;
}

function headOf(root: string): string | null {
  const wt = worktreeOf(root);
  if (wt) return wt.head;
  return extraRepoOf(root) ? H.mainTip : null;
}

function extraWorktrees(root: string): Worktree[] {
  const er = extraRepoOf(root);
  if (!er) return [];
  const main = folders.get(er)!.repo!.main ?? er;
  const group = [main, ...extraRepoPaths().filter((p) => folders.get(p)!.repo!.main === main)];
  return group.map((p) => {
    const b = folders.get(p)!.repo!.branch;
    return { path: p, branch: b, head: H.mainTip, isMain: p === main, isCurrent: p === er, detached: !b, locked: false, prunable: false };
  });
}

function fsFor(root: string): Map<string, MockFile> {
  if (worktreeOf(root)) return repoFs;
  const er = extraRepoOf(root);
  if (er) return extraFsOf(er);
  const r = canon(root);
  if (folders.has(r)) return plainTreeFs(r);
  return plainFs;
}

/** Plain folders of the fake filesystem list their sub-folders too, repositories included. */
function listPlainTree(rootAbs: string, dir: string): DirEntry[] | null {
  const abs = dir ? `${rootAbs === "/" ? "" : rootAbs.replace(/\/$/, "")}/${dir}` : rootAbs;
  if (worktreeOf(rootAbs) || extraRepoOf(rootAbs) || !folders.has(rootAbs)) return null;
  const inner = worktreeOf(abs) ?? null;
  const er = extraRepoOf(abs);
  if (inner || er) {
    const base = inner ? inner.path : er!;
    const rel = abs === base ? "" : abs.slice(base.length + 1);
    const prefix = dir.slice(0, dir.length - rel.length).replace(/\/$/, "");
    return listDir(inner ? repoFs : extraFsOf(er!), rel).map((e) => ({ ...e, path: prefix ? `${prefix}/${e.path}` : e.path, ignored: false }));
  }
  const cmp = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  const pre = dir ? dir + "/" : "";
  const dirs = subfolders(abs).map((p) => p.slice(p.lastIndexOf("/") + 1)).sort(cmp);
  const files = (folders.get(abs)?.files ?? []).slice().sort(cmp);
  return [
    ...dirs.map((n): DirEntry => ({ name: n, path: pre + n, kind: "dir", ignored: n === "node_modules" })),
    ...files.map((n): DirEntry => ({ name: n, path: pre + n, kind: "file", ignored: false })),
  ];
}

// ---------------------------------------------------------------- status

const INITIAL_STATUS: StatusEntry[] = [
  { path: "src/git/log.rs", origPath: null, index: null, worktree: "M" },
  { path: "src/git/worktree.rs", origPath: null, index: "A", worktree: null },
  { path: "ui/app.ts", origPath: null, index: "M", worktree: "M" },
  { path: "ui/components/List.tsx", origPath: "ui/components/ListView.tsx", index: "R", worktree: null },
  { path: "src/legacy.rs", origPath: null, index: null, worktree: "D" },
  { path: "assets/logo.png", origPath: null, index: null, worktree: "M" },
  { path: "notes/todo.md", origPath: null, index: null, worktree: "?" },
];

const TRACKED = [...repoFs.keys()].filter((p) => !isIgnored(p) && !p.startsWith("fixtures/") && p !== "notes/todo.md" && p !== "data/huge.log");

function statusFor(root: string): StatusEntry[] {
  const wt = worktreeOf(root);
  if (!wt) return [];
  let base: StatusEntry[];
  if (wt.path === INITIAL) base = INITIAL_STATUS.slice();
  else {
    const n = hashStr(wt.path) % 4;
    base = [];
    for (let i = 0; i < n; i++) base.push({ path: TRACKED[(hashStr(wt.path) + i * 7) % TRACKED.length], origPath: null, index: null, worktree: "M" });
  }
  const known = new Set(base.map((s) => s.path));
  for (const [path, orig] of original) {
    if (known.has(path)) continue;
    const now = repoFs.get(path);
    if (orig === null) base.push({ path, origPath: null, index: null, worktree: "?" });
    else if (now && fileText(now) !== orig) base.push({ path, origPath: null, index: null, worktree: "M" });
  }
  return base.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// ---------------------------------------------------------------- diffs

function lineDiff(a: string[], b: string[], path: string, status: FileStatus, origPath: string | null = null): FileDiff {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  type Op = { k: "ctx" | "add" | "del"; t: string };
  const mid: Op[] = [];
  if (A.length * B.length <= 2_000_000 && A.length && B.length) {
    const n = A.length;
    const m = B.length;
    const L = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        mid.push({ k: "ctx", t: A[i] });
        i++;
        j++;
      } else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) mid.push({ k: "del", t: A[i++] });
      else mid.push({ k: "add", t: B[j++] });
    }
    while (i < n) mid.push({ k: "del", t: A[i++] });
    while (j < m) mid.push({ k: "add", t: B[j++] });
  } else {
    for (const t of A) mid.push({ k: "del", t });
    for (const t of B) mid.push({ k: "add", t });
  }
  const ops: Op[] = [...a.slice(0, pre).map((t): Op => ({ k: "ctx", t })), ...mid, ...a.slice(a.length - suf).map((t): Op => ({ k: "ctx", t }))];
  const lines: DiffLine[] = [];
  let o = 1;
  let nn = 1;
  for (const op of ops) {
    lines.push({ kind: op.k, oldNo: op.k === "add" ? null : o, newNo: op.k === "del" ? null : nn, text: op.t });
    if (op.k !== "add") o++;
    if (op.k !== "del") nn++;
  }
  const CTX = 3;
  const ranges: [number, number][] = [];
  lines.forEach((l, i) => {
    if (l.kind === "ctx") return;
    const s = Math.max(0, i - CTX);
    const e = Math.min(lines.length, i + CTX + 1);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  });
  const hunks: DiffHunk[] = ranges.map(([s, e]) => {
    const ls = lines.slice(s, e);
    const olds = ls.filter((l) => l.oldNo !== null);
    const news = ls.filter((l) => l.newNo !== null);
    const os = olds[0]?.oldNo ?? 0;
    const ns = news[0]?.newNo ?? 0;
    return { header: `@@ -${os},${olds.length} +${ns},${news.length} @@`, lines: ls };
  });
  return { path, origPath, status, binary: false, truncated: false, hunks };
}

function mutate(lines: string[], seed: number): string[] {
  const r = rng(seed);
  const out = lines.slice();
  const edits = 1 + Math.floor(r() * 3);
  for (let e = 0; e < edits && out.length > 2; e++) {
    const at = Math.floor(r() * out.length);
    const kind = r();
    if (kind < 0.35) out.splice(at, 1 + Math.floor(r() * 3));
    else if (kind < 0.7) out[at] = out[at].replace(/\w+/, (w) => w + "_v1") || "// riga precedente";
    else out.splice(at, 0, "    // codice rimosso", "    todo!();");
  }
  return out;
}

interface CFile {
  path: string;
  origPath: string | null;
  status: FileStatus;
  binary?: boolean;
  truncated?: boolean;
}

function commitFileList(c: Raw): CFile[] {
  const idx = H.commits.indexOf(c);
  if (c.hash === H.g2) return [{ path: "src/git/diff.rs", origPath: null, status: "M" }, { path: "ui/components/List.tsx", origPath: null, status: "M" }];
  if (c.hash === H.g1)
    return [
      { path: "src/git/log.rs", origPath: null, status: "M" },
      { path: "ui/components/List.tsx", origPath: "ui/components/ListView.tsx", status: "R" },
      { path: "assets/logo.png", origPath: null, status: "M", binary: true },
    ];
  if (idx === 2) return [{ path: "src/generated/tables.rs", origPath: null, status: "A" }, { path: "src/main.rs", origPath: null, status: "M" }];
  if (idx === 5) return [{ path: "data/dump.sql", origPath: null, status: "A", truncated: true }];
  if (c.parents.length === 0) return TRACKED.filter((p) => !p.startsWith("src/generated")).slice(0, 14).map((path) => ({ path, origPath: null, status: "A" as FileStatus }));
  const r = rng(hashStr(c.hash));
  const n = 1 + Math.floor(r() * 4);
  const pool = TRACKED.filter((p) => p !== "src/generated/tables.rs" && p !== "assets/logo.png");
  const files = new Map<string, CFile>();
  for (let i = 0; i < n; i++) {
    const path = pool[Math.floor(r() * pool.length)];
    const s = r();
    files.set(path, { path, origPath: null, status: s < 0.85 ? "M" : s < 0.95 ? "A" : "D" });
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

const diffCache = new Map<string, FileDiff>();

function commitDiff(c: Raw, f: CFile): FileDiff {
  const key = c.hash + "\0" + f.path;
  const hit = diffCache.get(key);
  if (hit) return hit;
  let d: FileDiff;
  if (f.binary) d = { path: f.path, origPath: f.origPath, status: f.status, binary: true, truncated: false, hunks: [] };
  else if (f.truncated) {
    const lines = D.dumpSql(20000);
    d = {
      path: f.path, origPath: null, status: "A", binary: false, truncated: true,
      hunks: [{ header: "@@ -0,0 +1,20000 @@", lines: lines.map((text, i) => ({ kind: "add", oldNo: null, newNo: i + 1, text })) }],
    };
  } else {
    const file = repoFs.get(f.path);
    const now = file ? splitLines(fileText(file)) : ["// file", "fn esempio() {}", ""];
    if (f.status === "A") d = lineDiff([], now, f.path, "A");
    else if (f.status === "D") d = lineDiff(now, [], f.path, "D");
    else if (f.status === "R") d = lineDiff(splitLines(D.LIST_VIEW_TSX), now, f.path, "R", f.origPath);
    else d = lineDiff(mutate(now, hashStr(key)), now, f.path, f.status, f.origPath);
  }
  diffCache.set(key, d);
  return d;
}

// ---------------------------------------------------------------- api

function listDir(fs: Map<string, MockFile>, dir: string): DirEntry[] {
  const prefix = dir ? dir + "/" : "";
  const dirs = new Set<string>();
  const files = new Set<string>();
  for (const p of fs.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const cmp = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());
  const mk = (name: string, kind: "file" | "dir"): DirEntry => {
    const path = prefix + name;
    return { name, path, kind, ignored: fs === repoFs && isIgnored(path) };
  };
  return [...[...dirs].sort(cmp).map((n) => mk(n, "dir")), ...[...files].sort(cmp).map((n) => mk(n, "file"))];
}

// ---------------------------------------------------------------- updates
//
// Scenario: `?update=<name>` in the URL (remembered in localStorage under
// `ide-lite:mock-update`), else that localStorage key, else "uptodate".
//   uptodate        the check finds nothing newer
//   available       0.2.0 is offered; download with progress, then "installing"
//   check-error     the check fails
//   download-error  0.2.0 is offered, the download fails halfway
//   disabled        development build: updates unavailable

type UpdateScenario = "uptodate" | "available" | "check-error" | "download-error" | "disabled";
const SCENARIOS: UpdateScenario[] = ["uptodate", "available", "check-error", "download-error", "disabled"];

function updateScenario(): UpdateScenario {
  try {
    const fromUrl = new URLSearchParams(location.search).get("update");
    if (fromUrl && (SCENARIOS as string[]).includes(fromUrl)) {
      localStorage.setItem("ide-lite:mock-update", fromUrl);
      return fromUrl as UpdateScenario;
    }
    const s = localStorage.getItem("ide-lite:mock-update");
    if (s && (SCENARIOS as string[]).includes(s)) return s as UpdateScenario;
  } catch {
    /* storage unavailable */
  }
  return "uptodate";
}

const SCENARIO = updateScenario();
const NEW_VERSION = "0.2.0";
const NOTES = [
  "Novità di ide-lite 0.2.0",
  "",
  "- Selettore dei progetti (C-x p) e browser delle cartelle (C-x d)",
  "- Impostazioni e aggiornamenti automatici",
  "- Il diff mostra le righe lunghe per intero",
  "",
  "Le note sono testo semplice: <b>questo tag</b> non deve diventare grassetto.",
  ...Array.from({ length: 14 }, (_, i) => `- correzione minore n. ${i + 1}`),
].join("\n");

let upd: UpdateState = {
  phase: SCENARIO === "disabled" ? "disabled" : "idle",
  currentVersion: "0.1.0",
  newVersion: null,
  notes: null,
  downloaded: 0,
  total: null,
  error: null,
  checkedAt: null,
};
const updListeners = new Set<(s: UpdateState) => void>();
function setUpd(patch: Partial<UpdateState>): UpdateState {
  upd = { ...upd, ...patch };
  for (const l of updListeners) l({ ...upd });
  return { ...upd };
}

async function mockCheck(): Promise<UpdateState> {
  if (upd.phase === "disabled") return { ...upd };
  setUpd({ phase: "checking", error: null });
  await sleep(900);
  const now = Math.floor(Date.now() / 1000);
  if (SCENARIO === "check-error") return setUpd({ phase: "error", error: "Impossibile raggiungere il feed delle versioni (mock)", checkedAt: now });
  if (SCENARIO === "uptodate") return setUpd({ phase: "upToDate", newVersion: null, notes: null, checkedAt: now });
  return setUpd({ phase: "available", newVersion: NEW_VERSION, notes: NOTES, checkedAt: now });
}

export const mockApi: Api = {
  async initialRoot() {
    await latency(5, 15);
    return INITIAL;
  },

  async pickFolder() {
    const p = window.prompt(`Cartella da aprire (mock). Prova un worktree, ${PROGETTI} o una cartella qualsiasi:`, MAIN);
    return p ? norm(p) : null;
  },

  async repoInfo(root) {
    await latency();
    const wt = worktreeOf(root);
    if (!wt) {
      const er = extraRepoOf(root);
      if (er) return { root: er, isRepo: true, branch: folders.get(er)!.repo!.branch, head: H.mainTip, upstream: null, ahead: 0, behind: 0 };
      return { root: canon(root), isRepo: false, branch: null, head: null, upstream: null, ahead: 0, behind: 0 };
    }
    const upstreamName = wt.branch === "main" ? "origin/main" : wt.branch === "feat/git-graph" ? "origin/feat/git-graph" : null;
    const up = upstreamName ? resolve(upstreamName) : null;
    const ab = up ? aheadBehind(wt.head, up) : { ahead: 0, behind: 0 };
    const info: RepoInfo = { root: wt.path, isRepo: true, branch: wt.branch, head: wt.head, upstream: upstreamName, ...ab };
    return info;
  },

  async listDir(root, dir) {
    await latency(5, 40);
    return listPlainTree(canon(root), dir) ?? listDir(fsFor(root), dir);
  },

  async listFiles(root) {
    await latency(30, 90);
    const fs = fsFor(root);
    return [...fs.keys()].filter((p) => !isIgnored(p)).sort();
  },

  async readFile(root, path) {
    await latency(5, 30);
    const f = fsFor(root).get(path);
    if (!f) throw `File non trovato: ${path}`;
    if (f.binary) return { text: "", binary: true, tooLarge: false, eol: "lf" };
    if (f.tooLarge) return { text: "", binary: false, tooLarge: true, eol: "lf" };
    const text = fileText(f);
    const crlf = (text.match(/\r\n/g)?.length ?? 0) > (text.match(/(?<!\r)\n/g)?.length ?? 0);
    const c: FileContent = { text, binary: false, tooLarge: false, eol: crlf ? "crlf" : "lf" };
    return c;
  },

  async writeFile(root, path, text) {
    await latency(10, 40);
    const fs = fsFor(root);
    const prev = fs.get(path);
    if (fs === repoFs && !original.has(path)) original.set(path, prev ? fileText(prev) : null);
    fs.set(path, { text });
  },

  async gitStatus(root) {
    await latency(20, 60);
    return statusFor(root);
  },

  async gitLog(root, skip, limit, all) {
    await latency(40, 120);
    const head = headOf(root);
    if (!head) return [];
    let list = H.commits;
    if (!all) {
      const anc = ancestors(head);
      list = list.filter((c) => anc.has(c.hash));
    }
    return list.slice(skip, skip + limit).map(
      (c): Commit => ({ hash: c.hash, parents: c.parents, subject: c.subject, author: c.author, date: c.date, isHead: c.hash === head, refs: H.refs.get(c.hash) ?? [] }),
    );
  },

  async commitFiles(root, hash) {
    await latency(20, 80);
    const c = byHash.get(hash);
    if (!headOf(root) || !c) throw `Commit sconosciuto: ${hash}`;
    return commitFileList(c).map((f): CommitFile => {
      const d = commitDiff(c, f);
      let additions = 0;
      let deletions = 0;
      for (const h of d.hunks) for (const l of h.lines) l.kind === "add" ? additions++ : l.kind === "del" ? deletions++ : 0;
      return { path: f.path, origPath: f.origPath, status: f.status, additions, deletions, binary: !!f.binary };
    });
  },

  async commitFileDiff(root, hash, path) {
    await latency(30, 120);
    const c = byHash.get(hash);
    if (!headOf(root) || !c) throw `Commit sconosciuto: ${hash}`;
    const f = commitFileList(c).find((x) => x.path === path);
    if (!f) throw `File non presente nel commit: ${path}`;
    return commitDiff(c, f);
  },

  async workingFileDiff(root, path, staged) {
    await latency(20, 80);
    const entry = statusFor(root).find((s) => s.path === path);
    if (!entry) return { path, origPath: null, status: "M", binary: false, truncated: false, hunks: [] };
    const status = (staged ? entry.index : entry.worktree) ?? "M";
    const now = () => splitLines(fileText(repoFs.get(path) ?? {}));
    const empty: FileDiff = { path, origPath: entry.origPath, status, binary: false, truncated: false, hunks: [] };
    if ((staged && !entry.index) || (!staged && !entry.worktree)) return empty;
    if (path === "assets/logo.png") return { ...empty, binary: true };
    if (status === "?" || status === "A") return lineDiff([], now(), path, status);
    if (status === "D") return lineDiff(splitLines(D.LEGACY_RS), [], path, "D");
    if (status === "R") return lineDiff(splitLines(D.LIST_VIEW_TSX), now(), path, "R", entry.origPath);
    if (path === "ui/app.ts")
      return staged ? lineDiff(splitLines(D.APP_TS_HEAD), splitLines(D.APP_TS_INDEX), path, "M") : lineDiff(splitLines(D.APP_TS_INDEX), now(), path, "M");
    if (path === "src/git/log.rs" && !original.has(path)) return lineDiff(splitLines(D.LOG_RS_HEAD), now(), path, "M");
    const orig = original.get(path);
    if (orig != null) return lineDiff(splitLines(orig), now(), path, "M");
    return lineDiff(mutate(now(), hashStr(root + path)), now(), path, "M");
  },

  async listWorktrees(root) {
    await latency(30, 90);
    const cur = worktreeOf(root);
    if (!cur) return extraWorktrees(root);
    return worktrees.map((w) => ({ ...w, isCurrent: w.path === cur.path }));
  },

  async worktreeStatus(worktreePath, base) {
    await latency(40, 220);
    const wt = worktreeOf(worktreePath);
    if (!wt && extraRepoOf(worktreePath)) return { ahead: 0, behind: 0, dirty: 0 };
    if (!wt) throw `Worktree sconosciuto: ${worktreePath}`;
    const b = resolve(base);
    const ab = b ? aheadBehind(wt.head, b) : { ahead: 0, behind: 0 };
    const s: WorktreeStatus = { ...ab, dirty: statusFor(wt.path).length };
    return s;
  },

  async updateState() {
    return { ...upd };
  },

  async updateCheck() {
    if (upd.phase === "checking") {
      while (upd.phase === "checking") await sleep(50);
      return { ...upd };
    }
    return mockCheck();
  },

  async updateInstall() {
    if (upd.phase === "disabled") return { ...upd };
    if (upd.phase !== "available") {
      const s = await mockCheck();
      if (s.phase !== "available") return s;
    }
    const total = 18 * 1024 * 1024;
    setUpd({ phase: "downloading", downloaded: 0, total, error: null });
    for (let got = 0; got < total; ) {
      await sleep(120);
      got = Math.min(total, got + 640 * 1024);
      if (SCENARIO === "download-error" && got > total / 2) {
        return setUpd({ phase: "error", downloaded: 0, total: null, error: "Download interrotto: connessione chiusa dal server (mock)" });
      }
      setUpd({ downloaded: got });
    }
    setUpd({ phase: "installing", downloaded: 0, total: null });
    // the real app exits here; the mock stays in "installing" until a reload
    return new Promise<UpdateState>(() => {});
  },

  async onUpdateState(listener) {
    updListeners.add(listener);
    return () => updListeners.delete(listener);
  },

  async findRepos(root, maxDepth) {
    await latency(80, 220);
    const base = canon(root);
    if (!folderExists(base)) throw `Cartella inesistente: ${root}`;
    const SKIP = new Set(["node_modules", "target", "dist", "build", "vendor"]);
    const out: RepoEntry[] = [];
    const walk = (abs: string, depth: number) => {
      for (const sub of subfolders(abs)) {
        if (out.length >= 500) return;
        const name = sub.slice(sub.lastIndexOf("/") + 1);
        if (SKIP.has(name) || name.startsWith(".") || folders.get(sub)?.denied) continue;
        const m = repoMark(sub);
        if (m.isRepo) out.push({ path: sub, relPath: sub.slice(base.length).replace(/^\//, ""), branch: m.branch, linked: m.linked });
        else if (depth < maxDepth) walk(sub, depth + 1);
      }
    };
    if (!worktreeOf(base) && !extraRepoOf(base)) walk(base, 1);
    return out.sort((a, b) => a.relPath.toLowerCase().localeCompare(b.relPath.toLowerCase()));
  },

  async browseDir(path) {
    await latency(10, 60);
    if (!path) {
      const roots: FolderListing = { path: "", parent: null, dirs: ["C:/", "D:/"].map((p): FolderEntry => ({ name: p.slice(0, 2), path: p, isRepo: false, branch: null })) };
      return roots;
    }
    const abs = canon(path);
    if (!folderExists(abs)) throw `La cartella non esiste: ${abs}`;
    if (folders.get(abs)?.denied) throw `Accesso negato: ${abs}`;
    const dirs = subfolders(abs)
      .map((p): FolderEntry => {
        const m = repoMark(p);
        return { name: p.slice(p.lastIndexOf("/") + 1), path: p, isRepo: m.isRepo, branch: m.branch };
      })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const listing: FolderListing = { path: abs, parent: parentOf(abs), dirs };
    return listing;
  },

  async addWorktree(root, branch) {
    await latency(150, 300);
    const cur = worktreeOf(root);
    if (!cur) throw extraRepoOf(root) ? "Il mock crea worktree solo per ide-lite" : "Non è un repository git";
    const name = branch.trim();
    if (!name || /\s/.test(name)) throw `Nome di branch non valido: "${branch}"`;
    const path = `${PARENT}/ide-lite.${name.replace(/\//g, "-")}`;
    if (worktrees.some((w) => w.path === path)) throw `Esiste già un worktree in ${path}`;
    if (worktrees.some((w) => w.branch === name)) throw `Il branch ${name} è già usato da un altro worktree`;
    const head = H.branchTips.get(name) ?? cur.head;
    if (!H.branchTips.has(name)) {
      H.branchTips.set(name, head);
      H.refs.set(head, [...(H.refs.get(head) ?? []), { name, kind: "branch" }]);
    }
    const wt: Worktree = { path, branch: name, head, isMain: false, isCurrent: false, detached: false, locked: false, prunable: false };
    worktrees.push(wt);
    return { ...wt };
  },
};
