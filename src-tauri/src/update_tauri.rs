//! Tauri side of self-update: drives `update::Machine` with
//! `tauri-plugin-updater` and emits `update-state` on every transition.

use crate::update::{CheckOutcome, Machine, Throttle, UpdatePhase, UpdateState, describe_error, unix_now};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

pub const EVENT: &str = "update-state";

/// Managed state: the machine plus the update found by the last check.
pub struct Updates {
    machine: Mutex<Machine>,
    pending: Mutex<Option<Update>>,
}

impl Updates {
    pub fn new(current_version: String) -> Self {
        // Release builds only: a development build never touches the network.
        let enabled = !cfg!(debug_assertions);
        Self { machine: Mutex::new(Machine::new(current_version, enabled)), pending: Mutex::new(None) }
    }
}

fn updates<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, Updates> {
    app.state::<Updates>()
}

pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> UpdateState {
    lock(&updates(app).machine).state().clone()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Applies `f`; when it changed the state, emits it. Returns (applied, state).
fn transition<R: Runtime, T>(
    app: &AppHandle<R>,
    f: impl FnOnce(&mut Machine) -> Result<T, crate::update::Refused>,
) -> (bool, UpdateState) {
    let (ok, state, changed) = {
        let st = updates(app);
        let mut m = lock(&st.machine);
        let before = m.state().clone();
        let ok = f(&mut m).is_ok();
        let after = m.state().clone();
        let changed = after != before;
        (ok, after, changed)
    };
    if changed {
        let _ = app.emit(EVENT, &state);
    }
    (ok, state)
}

pub async fn check<R: Runtime>(app: &AppHandle<R>) -> UpdateState {
    let (started, state) = transition(app, Machine::begin_check);
    if !started {
        return state;
    }
    let result = match app.updater_builder().timeout(Duration::from_secs(30)).build() {
        Ok(updater) => updater.check().await,
        Err(e) => Err(e),
    };
    let outcome = match result {
        Ok(Some(update)) => {
            let outcome = CheckOutcome::Available { version: update.version.clone(), notes: update.body.clone() };
            *lock(&updates(app).pending) = Some(update);
            outcome
        }
        Ok(None) => {
            *lock(&updates(app).pending) = None;
            CheckOutcome::UpToDate
        }
        Err(e) => {
            *lock(&updates(app).pending) = None;
            CheckOutcome::Failed(describe_error(&e))
        }
    };
    transition(app, |m| m.finish_check(outcome, unix_now())).1
}

pub async fn install<R: Runtime>(app: &AppHandle<R>) -> UpdateState {
    let phase = lock(&updates(app).machine).phase();
    match phase {
        // Nothing to do, or already running: report without starting anything.
        UpdatePhase::Disabled | UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing => {
            return snapshot(app);
        }
        UpdatePhase::Available => {}
        UpdatePhase::Idle | UpdatePhase::UpToDate | UpdatePhase::Error => {
            let state = check(app).await;
            if state.phase != UpdatePhase::Available {
                return state;
            }
        }
    }
    // Only one caller wins this transition; the update is taken under the same rule.
    let (started, state) = transition(app, Machine::begin_download);
    if !started {
        return state;
    }
    let Some(update) = lock(&updates(app).pending).clone() else {
        return transition(app, |m| {
            m.fail("no update package is known; check again");
            Ok::<_, crate::update::Refused>(())
        })
        .1;
    };

    let start = Instant::now();
    let mut throttle = Throttle::default();
    let progress_app = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                let (downloaded, total) = {
                    let st = updates(&progress_app);
                    let mut m = lock(&st.machine);
                    m.progress(chunk as u64, total);
                    (m.state().downloaded, m.state().total)
                };
                if throttle.should_emit(start.elapsed().as_millis(), downloaded, total) {
                    let _ = progress_app.emit(EVENT, snapshot(&progress_app));
                }
            },
            || {},
        )
        .await;
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            let msg = describe_error(&e);
            return transition(app, |m| {
                m.fail(msg);
                Ok::<_, crate::update::Refused>(())
            })
            .1;
        }
    };
    let _ = app.emit(EVENT, snapshot(app));

    transition(app, Machine::begin_install);
    // Give the webview a moment to render "installing": on Windows the plugin
    // launches the installer and calls `std::process::exit(0)` right away.
    tokio_sleep(Duration::from_millis(400)).await;

    let result = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    match result {
        // Not reached on Windows (the process has exited). Elsewhere, restart.
        Ok(Ok(())) => app.restart(),
        Ok(Err(e)) => {
            let msg = describe_error(&e);
            transition(app, |m| {
                m.fail(msg);
                Ok::<_, crate::update::Refused>(())
            })
            .1
        }
        Err(e) => {
            let msg = format!("installer task failed: {e}");
            transition(app, |m| {
                m.fail(msg);
                Ok::<_, crate::update::Refused>(())
            })
            .1
        }
    }
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}
