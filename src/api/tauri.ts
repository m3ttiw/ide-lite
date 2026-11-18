import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Api, UpdateState } from "./types";

// One Tauri command per Api method. Command names are snake_case; argument
// keys are camelCase here and arrive as snake_case parameters in Rust.
export const tauriApi: Api = {
  initialRoot: () => invoke("initial_root"),
  launchFolder: () => invoke("launch_folder"),
  pickFolder: () => invoke("pick_folder"),
  repoInfo: (root) => invoke("repo_info", { root }),
  listDir: (root, dir) => invoke("list_dir", { root, dir }),
  listFiles: (root) => invoke("list_files", { root }),
  readFile: (root, path) => invoke("read_file", { root, path }),
  writeFile: (root, path, text) => invoke("write_file", { root, path, text }),
  gitStatus: (root) => invoke("git_status", { root }),
  gitLog: (root, skip, limit, all) => invoke("git_log", { root, skip, limit, all }),
  commitFiles: (root, hash) => invoke("commit_files", { root, hash }),
  commitFileDiff: (root, hash, path) => invoke("commit_file_diff", { root, hash, path }),
  workingFileDiff: (root, path, staged) => invoke("working_file_diff", { root, path, staged }),
  listWorktrees: (root) => invoke("list_worktrees", { root }),
  worktreeStatus: (worktreePath, base) => invoke("worktree_status", { worktreePath, base }),
  addWorktree: (root, branch) => invoke("add_worktree", { root, branch }),
  removeWorktree: (root, path, force) => invoke("remove_worktree", { root, path, force }),
  reviewFiles: (root, base) => invoke("review_files", { root, base }),
  reviewFileDiff: (root, baseCommit, path, origPath, since) => invoke("review_file_diff", { root, baseCommit, path, origPath, since }),
  markReviewed: (root, paths) => invoke("mark_reviewed", { root, paths }),
  pullRequest: (root) => invoke("pull_request", { root }),
  openUrl: (url) => invoke("open_url", { url }),
  findRepos: (root, maxDepth) => invoke("find_repos", { root, maxDepth }),
  browseDir: (path) => invoke("browse_dir", { path }),
  updateState: () => invoke("update_state"),
  updateCheck: () => invoke("update_check"),
  updateInstall: () => invoke("update_install"),
  onUpdateState: (listener) => listen<UpdateState>("update-state", (e) => listener(e.payload)),
};
