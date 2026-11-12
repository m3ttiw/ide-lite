import { createSignal } from "solid-js";
import { api, isTauri, type RepoEntry, type RepoInfo } from "../api";
import { pushRecent } from "../lib/projects";
import { openOverlay } from "./focus";
import { errorText, flash, savePrefs, setUi, ui } from "./ui";

/** Repositories found inside the container folder (C-x p, sidebar block). */
const [repoScan, setRepoScan] = createSignal<{ container: string; list: RepoEntry[] | null; error?: string } | null>(null);
export { repoScan };

let inflight: { container: string; p: Promise<RepoEntry[]> } | null = null;

export const REPO_DEPTH = 3;

/** findRepos(container, 3), cached per container. `force` asks again. */
export function loadRepos(container: string, force = false): Promise<RepoEntry[]> {
  const cur = repoScan();
  if (!force && cur?.container === container && cur.list) return Promise.resolve(cur.list);
  if (inflight?.container === container) return inflight.p;
  if (cur?.container !== container || force) setRepoScan({ container, list: cur?.container === container ? cur.list : null });
  const p = api
    .findRepos(container, REPO_DEPTH)
    .then((list) => {
      if (repoScan()?.container === container) setRepoScan({ container, list });
      return list;
    })
    .catch((e) => {
      if (repoScan()?.container === container) setRepoScan({ container, list: [], error: errorText(e) });
      return [] as RepoEntry[];
    })
    .finally(() => {
      if (inflight?.p === p) inflight = null;
    });
  inflight = { container, p };
  return p;
}

/** Repositories of the current container, or null while they are being looked for. */
export function containerRepos(): RepoEntry[] | null {
  const s = repoScan();
  return ui.container && s?.container === ui.container ? s.list : null;
}

export function openProjectPicker(): void {
  if (ui.container) void loadRepos(ui.container);
  openOverlay({ kind: "picker", picker: "project" });
}

/** Native window title (Tauri) follows the workspace. */
function setWindowTitle(title: string): void {
  document.title = title;
  if (!isTauri) return;
  import("@tauri-apps/api/window")
    .then((m) => m.getCurrentWindow().setTitle(title))
    .catch(() => {
      /* title is cosmetic */
    });
}

/**
 * After a workspace is opened (startup, folder browser, project picker, native
 * dialog). A non-repository folder becomes the container, and its repositories
 * are listed in the repository column of the bottom panel.
 */
export async function afterOpen(root: string, info: RepoInfo, isCurrent: () => boolean): Promise<void> {
  setWindowTitle(`${root.slice(root.lastIndexOf("/", root.length - 2) + 1).replace(/\/$/, "") || root} — ide-lite`);
  setUi("recents", pushRecent(ui.recents, root));
  if (info.isRepo) return savePrefs();
  setUi("container", root);
  savePrefs();
  const list = await loadRepos(root, true);
  if (!isCurrent()) return;
  if (!list.length) return flash(repoScan()?.error ? `Ricerca dei repository non riuscita: ${repoScan()!.error}` : "Nessun repository git in questa cartella");
  // the repository column of the bottom panel lists them: no picker
  if (!ui.bottomVisible) setUi("bottomVisible", true);
  flash(`${list.length === 1 ? "1 repository trovato" : `${list.length} repository trovati`} in ${root}`);
}
