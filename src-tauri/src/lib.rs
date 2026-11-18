//! ide-lite backend: thin Tauri command wrappers over plain modules.
//!
//! Every command that touches the disk or spawns git runs on Tauri's blocking
//! thread pool (`spawn_blocking`), never on the main/UI thread.

mod diff;
mod fsops;
mod git;
mod gitcmd;
mod paths;
mod repos;
mod review;
mod types;
mod update;
mod update_tauri;
mod worktree;

#[cfg(test)]
mod tests;

use tauri_plugin_dialog::DialogExt;
use types::*;

/// Runs blocking work off the async runtime's worker threads.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| format!("task failed: {e}"))?
}

/// First CLI argument when it is an existing directory: the folder the app was asked to open.
fn launch_folder_impl(arg: Option<std::ffi::OsString>) -> Option<String> {
    let p = std::path::PathBuf::from(arg?);
    p.is_dir().then(|| paths::canonical_slash(&p))
}

/// The user's home folder: `USERPROFILE` on Windows, `HOME` elsewhere.
fn home_folder() -> Option<std::path::PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(std::path::PathBuf::from)
}

/// The launch folder, else the home folder, else (no usable home) the current directory.
fn initial_root_impl(arg: Option<std::ffi::OsString>, home: Option<std::path::PathBuf>) -> Result<String, String> {
    if let Some(p) = launch_folder_impl(arg) {
        return Ok(p);
    }
    if let Some(h) = home.filter(|h| h.is_dir()) {
        return Ok(paths::canonical_slash(&h));
    }
    let cwd = std::env::current_dir().map_err(|e| format!("current directory: {e}"))?;
    Ok(paths::canonical_slash(&cwd))
}

#[tauri::command]
async fn initial_root() -> Result<String, String> {
    blocking(|| initial_root_impl(std::env::args_os().nth(1), home_folder())).await
}

#[tauri::command]
async fn launch_folder() -> Result<Option<String>, String> {
    blocking(|| Ok(launch_folder_impl(std::env::args_os().nth(1)))).await
}

#[tauri::command]
async fn pick_folder(window: tauri::Window) -> Result<Option<String>, String> {
    blocking(move || {
        let picked = window.dialog().file().set_parent(&window).blocking_pick_folder();
        match picked {
            None => Ok(None),
            Some(fp) => {
                let p = fp.into_path().map_err(|e| e.to_string())?;
                Ok(Some(paths::canonical_slash(&p)))
            }
        }
    })
    .await
}

#[tauri::command]
async fn repo_info(root: String) -> Result<RepoInfo, String> {
    blocking(move || git::repo_info(&root)).await
}

#[tauri::command]
async fn list_dir(root: String, dir: String) -> Result<Vec<DirEntry>, String> {
    blocking(move || fsops::list_dir(&root, &dir)).await
}

#[tauri::command]
async fn list_files(root: String) -> Result<Vec<String>, String> {
    blocking(move || fsops::list_files(&root)).await
}

#[tauri::command]
async fn read_file(root: String, path: String) -> Result<FileContent, String> {
    blocking(move || fsops::read_file(&root, &path)).await
}

#[tauri::command]
async fn write_file(root: String, path: String, text: String) -> Result<(), String> {
    blocking(move || fsops::write_file(&root, &path, &text)).await
}

#[tauri::command]
async fn git_status(root: String) -> Result<Vec<StatusEntry>, String> {
    blocking(move || git::git_status(&root)).await
}

#[tauri::command]
async fn git_log(root: String, skip: u32, limit: u32, all: bool) -> Result<Vec<Commit>, String> {
    blocking(move || git::git_log(&root, skip, limit, all)).await
}

#[tauri::command]
async fn commit_files(root: String, hash: String) -> Result<Vec<CommitFile>, String> {
    blocking(move || diff::commit_files(&root, &hash)).await
}

#[tauri::command]
async fn commit_file_diff(root: String, hash: String, path: String) -> Result<FileDiff, String> {
    blocking(move || diff::commit_file_diff(&root, &hash, &path)).await
}

#[tauri::command]
async fn working_file_diff(root: String, path: String, staged: bool) -> Result<FileDiff, String> {
    blocking(move || diff::working_file_diff(&root, &path, staged)).await
}

#[tauri::command]
async fn list_worktrees(root: String) -> Result<Vec<Worktree>, String> {
    blocking(move || worktree::list_worktrees(&root)).await
}

#[tauri::command]
async fn worktree_status(worktree_path: String, base: Option<String>) -> Result<WorktreeStatus, String> {
    blocking(move || worktree::worktree_status(&worktree_path, base.as_deref())).await
}

#[tauri::command]
async fn add_worktree(root: String, branch: String) -> Result<Worktree, String> {
    blocking(move || worktree::add_worktree(&root, &branch)).await
}

#[tauri::command]
async fn remove_worktree(root: String, path: String, force: bool) -> Result<(), String> {
    blocking(move || worktree::remove_worktree(&root, &path, force)).await
}

#[tauri::command]
async fn review_files(root: String, base: Option<String>) -> Result<ReviewInfo, String> {
    blocking(move || review::review_files(&root, base.as_deref())).await
}

#[tauri::command]
async fn review_file_diff(root: String, base_commit: String, path: String, orig_path: Option<String>, since: Option<String>) -> Result<FileDiff, String> {
    blocking(move || review::review_file_diff(&root, &base_commit, &path, orig_path.as_deref(), since.as_deref())).await
}

#[tauri::command]
async fn mark_reviewed(root: String, paths: Vec<String>) -> Result<Vec<Option<String>>, String> {
    blocking(move || review::mark_reviewed(&root, &paths)).await
}

#[tauri::command]
async fn find_repos(root: String, max_depth: u32) -> Result<Vec<RepoEntry>, String> {
    blocking(move || repos::find_repos(&root, max_depth)).await
}

#[tauri::command]
async fn browse_dir(path: String) -> Result<FolderListing, String> {
    blocking(move || repos::browse_dir(&path)).await
}

#[tauri::command]
async fn update_state(app: tauri::AppHandle) -> Result<update::UpdateState, String> {
    Ok(update_tauri::snapshot(&app))
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<update::UpdateState, String> {
    Ok(update_tauri::check(&app).await)
}

#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<update::UpdateState, String> {
    Ok(update_tauri::install(&app).await)
}

// Automatic checks are scheduled by the UI (15 s after start, then every
// 6 hours), because the "check automatically" preference lives there. The
// backend only checks when asked.

/// The UI implements its own shortcuts (Ctrl+R, Ctrl+P, Ctrl+F, F5, ...), so
/// WebView2's browser accelerator keys (reload, print, find, devtools, ...)
/// are turned off. Tauri has no builder option for this; the setting is
/// applied through the WebView2 settings object.
#[cfg(windows)]
fn disable_browser_accelerator_keys(app: &tauri::App) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.with_webview(|wv| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows_core::Interface;
        // SAFETY: plain COM calls on live interfaces handed out by Tauri, on
        // the thread that owns the webview.
        unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let Ok(settings) = core.Settings() else { return };
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;
            app.manage(update_tauri::Updates::new(app.package_info().version.to_string()));
            #[cfg(windows)]
            disable_browser_accelerator_keys(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            initial_root,
            launch_folder,
            pick_folder,
            repo_info,
            list_dir,
            list_files,
            read_file,
            write_file,
            git_status,
            git_log,
            commit_files,
            commit_file_diff,
            working_file_diff,
            list_worktrees,
            worktree_status,
            add_worktree,
            remove_worktree,
            review_files,
            review_file_diff,
            mark_reviewed,
            find_repos,
            browse_dir,
            update_state,
            update_check,
            update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
