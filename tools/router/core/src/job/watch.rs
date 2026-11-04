//! The thread that reads the router log while it runs: one progress row per pass, and the stall stop of fail_fast.
use super::files::{read_lossy, rounded, unix_time};
use super::progress::{Progress, parse_pass};
use super::stage::Running;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, mpsc};
use std::thread::{JoinHandle, spawn};
use std::time::Duration;

const POLL: Duration = Duration::from_secs(1);
const STAGE_START: &str = "Auto-routing stage started";

/// The stall evidence: what stall.json holds beside the job's fields.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Stall {
    pub interrupt_attempted: bool,
    pub interrupt_acknowledged: Option<bool>,
    pub pass_no: u64,
    pub unrouted: u64,
    pub best: u64,
    pub how: String,
    pub seconds: f64,
}

/// The stall rule over the lines of a log. A new stage restarts the count: stale passes of the stage before must not stop it after
/// its first pass. A burst of starts is a parallel multi-start, whose pass lines interleave: the window is stall_passes x starts.
#[derive(Debug)]
pub struct StallRule {
    stall_passes: u64,
    best: Option<u64>,
    stale: u64,
    starts: u64,
    last_was_start: bool,
}

impl StallRule {
    pub fn new(stall_passes: u64) -> StallRule {
        StallRule { stall_passes, best: None, stale: 0, starts: 1, last_was_start: false }
    }

    pub fn stage_started(&mut self) {
        self.starts = if self.last_was_start { self.starts + 1 } else { 1 };
        self.best = None;
        self.stale = 0;
        self.last_was_start = true;
    }

    /// True when this pass ends the window.
    pub fn pass(&mut self, open: u64) -> bool {
        self.last_was_start = false;
        if self.best.is_none_or(|best| open < best) {
            self.best = Some(open);
            self.stale = 0;
        } else {
            self.stale += 1;
        }
        self.stall_passes > 0 && self.stale >= self.stall_passes * self.starts
    }

    pub fn best(&self) -> u64 {
        self.best.unwrap_or(0)
    }
}

/// The running router, once it has started.
pub type Owner = Arc<Mutex<Option<Running>>>;

fn stall(rule: &StallRule, owner: &Owner, pass_no: u64, unrouted: u64) -> Stall {
    let running = *owner.lock().unwrap_or_else(|poison| poison.into_inner());
    // One stop only: a second one makes Fastroute exit 130 without its best board.
    let (attempted, acknowledged, how) = match running {
        Some(stage) => (true, Some(stage.interrupt()), "owned-stage interrupt requested"),
        None => (false, None, "no owned router handle"),
    };
    Stall { interrupt_attempted: attempted, interrupt_acknowledged: acknowledged, pass_no, unrouted, best: rule.best(), how: how.to_string(), seconds: rounded(unix_time(), 1) }
}

struct Reader {
    log: PathBuf,
    stage: String,
    seen: usize,
    rule: StallRule,
}

impl Reader {
    /// Reads the lines that are new. A stall ends the reading.
    fn read(&mut self, owner: &Owner, progress: &Mutex<Progress>) -> Option<Stall> {
        let text = read_lossy(&self.log)?;
        let lines: Vec<&str> = text.lines().collect();
        for line in lines.iter().skip(self.seen) {
            if line.contains(STAGE_START) {
                self.rule.stage_started();
                continue;
            }
            let Some(pass) = parse_pass(line) else { continue };
            progress.lock().unwrap_or_else(|poison| poison.into_inner()).router_pass(pass.number, pass.open, &self.stage);
            if self.rule.pass(pass.open) {
                return Some(stall(&self.rule, owner, pass.number, pass.open));
            }
        }
        self.seen = lines.len();
        None
    }
}

pub struct Watcher {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<Option<Stall>>>,
}

impl Watcher {
    pub fn start(log: PathBuf, stall_passes: u64, owner: Owner, progress: Arc<Mutex<Progress>>, stage: String) -> Watcher {
        let (stop, stopped) = mpsc::channel::<()>();
        let mut reader = Reader { log, stage, seen: 0, rule: StallRule::new(stall_passes) };
        let thread = spawn(move || {
            while let Err(mpsc::RecvTimeoutError::Timeout) = stopped.recv_timeout(POLL) {
                if let Some(result) = reader.read(&owner, &progress) {
                    return Some(result);
                }
            }
            None
        });
        Watcher { stop: Some(stop), thread: Some(thread) }
    }

    /// Ends the thread and gives the stall it saw.
    pub fn stop(&mut self) -> Result<Option<Stall>, String> {
        drop(self.stop.take());
        match self.thread.take().map(JoinHandle::join) {
            Some(Ok(stall)) => Ok(stall),
            Some(Err(_)) => Err("router watcher panicked".to_string()),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stall_comes_after_the_window_with_no_new_best() {
        let mut rule = StallRule::new(2);
        assert!(!rule.pass(10));
        assert!(!rule.pass(9));
        assert!(!rule.pass(9));
        assert!(rule.pass(11));
        assert_eq!(rule.best(), 9);
    }

    #[test]
    fn a_new_stage_starts_its_own_count() {
        let mut rule = StallRule::new(2);
        rule.pass(5);
        rule.pass(6);
        rule.stage_started();
        assert!(!rule.pass(8));
        assert!(!rule.pass(8));
        assert!(rule.pass(8));
    }

    #[test]
    fn a_burst_of_starts_widens_the_window() {
        let mut rule = StallRule::new(1);
        rule.stage_started();
        rule.stage_started();
        rule.stage_started();
        assert!(!rule.pass(5));
        assert!(!rule.pass(5));
        assert!(!rule.pass(5));
        assert!(rule.pass(5));
    }

    #[test]
    fn zero_never_stops() {
        let mut rule = StallRule::new(0);
        assert!((0..50).all(|_| !rule.pass(5)));
    }
}
