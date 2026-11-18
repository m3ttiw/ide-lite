import { createMemo, createRoot, createSignal } from "solid-js";
import { api, type PrComment, type PrLookup } from "../api";
import { errorText, flash } from "./ui";
import { gitRoot, repo } from "./workspace";

/** Pull request of the branch checked out in the git root, as last read. */
const [pr, setPr] = createSignal<{ root: string; branch: string | null; lookup: PrLookup | null; error: string | null; loading: boolean; at: number } | null>(null);
export { pr };

/** A lookup is reused for this long unless the user asks for a refresh. */
const FRESH_MS = 2 * 60 * 1000;
let seq = 0;

export async function loadPr(force = false): Promise<void> {
  const root = gitRoot();
  if (!root || !repo()?.isRepo) return;
  const branch = repo()?.branch ?? null;
  const cur = pr();
  const same = cur?.root === root && cur.branch === branch;
  if (!force && same && (cur.loading || Date.now() - cur.at < FRESH_MS)) return;
  const n = ++seq;
  setPr({ root, branch, lookup: same ? cur.lookup : null, error: null, loading: true, at: Date.now() });
  try {
    const lookup = await api.pullRequest(root);
    if (n === seq) setPr({ root, branch, lookup, error: null, loading: false, at: Date.now() });
  } catch (e) {
    if (n === seq) setPr({ root, branch, lookup: null, error: errorText(e), loading: false, at: Date.now() });
  }
}

export function resetPr(): void {
  seq++;
  setPr(null);
}

/** The lookup when it belongs to the current git root and branch. */
export const prLookup = (): PrLookup | null => {
  const p = pr();
  return p && p.root === gitRoot() && p.branch === (repo()?.branch ?? null) ? p.lookup : null;
};

/** Target branch of the pull request as a local ref: the base of the review. */
export const prBaseRef = () => prLookup()?.pr?.baseRef ?? null;

/** Comments of the pull request by file (the general discussion under ""). */
export const prComments = createRoot(() =>
  createMemo(() => {
    const m = new Map<string, PrComment[]>();
    for (const c of prLookup()?.pr?.comments ?? []) {
      const k = c.path ?? "";
      const l = m.get(k);
      if (l) l.push(c);
      else m.set(k, [c]);
    }
    return m;
  }),
);

/** Open threads on a file (a thread is open when its comments are not resolved). */
export function openThreads(path: string): number {
  const threads = new Set<string>();
  for (const c of prComments().get(path) ?? []) if (!c.resolved) threads.add(c.thread);
  return threads.size;
}

/** Page where a pull request for the branch can be created. */
export function newPrUrl(l: PrLookup): string | null {
  if (!l.repoUrl || !l.branch) return null;
  const b = encodeURIComponent(l.branch);
  return l.provider === "azure" ? `${l.repoUrl}/pullrequestcreate?sourceRef=${b}` : `${l.repoUrl}/compare/${b}?expand=1`;
}

export async function openLink(url: string | null | undefined): Promise<void> {
  if (!url) return flash("Nessun link da aprire");
  try {
    await api.openUrl(url);
  } catch (e) {
    flash(`Non riesco ad aprire il browser: ${errorText(e)}`, true);
  }
}
