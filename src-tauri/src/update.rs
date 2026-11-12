//! Self-update state machine (no Tauri types here, so it is unit-testable).
//!
//! ```text
//! disabled                                   (development build, final)
//! idle | upToDate | available | error  --check-->  checking
//! checking   --> available | upToDate | error
//! available  --install--> downloading --> installing --> (process exits)
//! downloading / installing --failure--> error
//! ```
//!
//! The Tauri glue (`lib.rs`) owns one `Machine` behind a mutex, applies a
//! transition, and emits the resulting `UpdateState` on every change.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    Disabled,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Installing,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub new_version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    pub checked_at: Option<i64>,
}

/// Outcome of a release-feed check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    Available { version: String, notes: Option<String> },
    UpToDate,
    Failed(String),
}

/// Why a transition was refused. The caller then just reports the current state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Development build.
    Disabled,
    /// A check, download or install is already running.
    Busy,
    /// The transition does not apply to the current phase.
    WrongPhase,
}

#[derive(Debug, Clone)]
pub struct Machine {
    state: UpdateState,
}

impl Machine {
    pub fn new(current_version: impl Into<String>, enabled: bool) -> Self {
        Self {
            state: UpdateState {
                phase: if enabled { UpdatePhase::Idle } else { UpdatePhase::Disabled },
                current_version: current_version.into(),
                new_version: None,
                notes: None,
                downloaded: 0,
                total: None,
                error: None,
                checked_at: None,
            },
        }
    }

    pub fn state(&self) -> &UpdateState {
        &self.state
    }

    pub fn phase(&self) -> UpdatePhase {
        self.state.phase
    }

    fn guard(&self) -> Result<(), Refused> {
        match self.state.phase {
            UpdatePhase::Disabled => Err(Refused::Disabled),
            UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing => Err(Refused::Busy),
            _ => Ok(()),
        }
    }

    /// Enters `checking`. Refused in a development build or while busy.
    pub fn begin_check(&mut self) -> Result<(), Refused> {
        self.guard()?;
        let s = &mut self.state;
        s.phase = UpdatePhase::Checking;
        s.error = None;
        s.downloaded = 0;
        s.total = None;
        Ok(())
    }

    /// Leaves `checking` with the result. `now` is unix seconds.
    pub fn finish_check(&mut self, outcome: CheckOutcome, now: i64) -> Result<(), Refused> {
        if self.state.phase != UpdatePhase::Checking {
            return Err(Refused::WrongPhase);
        }
        let s = &mut self.state;
        s.checked_at = Some(now);
        match outcome {
            CheckOutcome::Available { version, notes } => {
                s.phase = UpdatePhase::Available;
                s.new_version = Some(version);
                s.notes = notes.filter(|n| !n.trim().is_empty());
            }
            CheckOutcome::UpToDate => {
                s.phase = UpdatePhase::UpToDate;
                s.new_version = None;
                s.notes = None;
            }
            CheckOutcome::Failed(msg) => self.set_error(msg),
        }
        Ok(())
    }

    /// Enters `downloading`. Only from `available`, so a second install
    /// request while one is running never starts a second download.
    pub fn begin_download(&mut self) -> Result<(), Refused> {
        self.guard()?;
        if self.state.phase != UpdatePhase::Available {
            return Err(Refused::WrongPhase);
        }
        self.state.phase = UpdatePhase::Downloading;
        self.state.downloaded = 0;
        self.state.total = None;
        Ok(())
    }

    /// Adds a downloaded chunk. Ignored outside `downloading`.
    pub fn progress(&mut self, chunk: u64, total: Option<u64>) {
        if self.state.phase == UpdatePhase::Downloading {
            self.state.downloaded = self.state.downloaded.saturating_add(chunk);
            if total.is_some() {
                self.state.total = total;
            }
        }
    }

    /// Enters `installing` once the package is downloaded and verified.
    pub fn begin_install(&mut self) -> Result<(), Refused> {
        if self.state.phase != UpdatePhase::Downloading {
            return Err(Refused::WrongPhase);
        }
        self.state.phase = UpdatePhase::Installing;
        Ok(())
    }

    /// A download or install failure.
    pub fn fail(&mut self, msg: impl Into<String>) {
        if self.state.phase != UpdatePhase::Disabled {
            self.set_error(msg.into());
        }
    }

    fn set_error(&mut self, msg: String) {
        let s = &mut self.state;
        s.phase = UpdatePhase::Error;
        s.error = Some(if msg.trim().is_empty() { "update failed".to_string() } else { msg });
        s.new_version = None;
        s.notes = None;
        s.downloaded = 0;
        s.total = None;
    }
}

/// Readable message for an updater error.
pub fn describe_error(e: &dyn std::fmt::Display) -> String {
    let msg = e.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("signature") {
        format!("the update signature is not valid: {msg}")
    } else if lower.contains("error sending request") || lower.contains("dns") || lower.contains("connect") {
        format!("cannot reach the release server: {msg}")
    } else {
        msg
    }
}

/// Throttles progress events: emit when 100 ms passed or at least 1 % more
/// arrived, and always for the final chunk.
#[derive(Debug, Default)]
pub struct Throttle {
    last_ms: Option<u128>,
    last_bytes: u64,
}

impl Throttle {
    pub fn should_emit(&mut self, now_ms: u128, downloaded: u64, total: Option<u64>) -> bool {
        let done = total.is_some_and(|t| downloaded >= t);
        let step = total.map(|t| (t / 100).max(1)).unwrap_or(u64::MAX);
        let due = match self.last_ms {
            None => true,
            Some(last) => now_ms.saturating_sub(last) >= 100 || downloaded.saturating_sub(self.last_bytes) >= step,
        };
        if done || due {
            self.last_ms = Some(now_ms);
            self.last_bytes = downloaded;
            true
        } else {
            false
        }
    }
}

pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
