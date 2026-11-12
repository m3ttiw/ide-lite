import type { Api } from "./types";

// Inside Tauri the real backend is used; in a plain browser (`npm run dev`)
// an in-memory mock. Both are loaded with a dynamic import, so the mock is a
// separate chunk that the Tauri app never downloads.
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let impl: Promise<Api> | null = null;

function load(): Promise<Api> {
  impl ??= isTauri ? import("./tauri").then((m) => m.tauriApi) : import("./mock").then((m) => m.mockApi);
  return impl;
}

const METHODS = [
  "initialRoot", "pickFolder", "repoInfo", "listDir", "listFiles", "readFile", "writeFile",
  "gitStatus", "gitLog", "commitFiles", "commitFileDiff", "workingFileDiff", "listWorktrees",
  "worktreeStatus", "addWorktree", "findRepos", "browseDir",
] as const satisfies readonly (keyof Api)[];

type AnyFn = (...args: unknown[]) => Promise<unknown>;

export const api = Object.fromEntries(
  METHODS.map((name) => [name, (...args: unknown[]) => load().then((a) => (a[name] as AnyFn)(...args))]),
) as unknown as Api;

export type * from "./types";
