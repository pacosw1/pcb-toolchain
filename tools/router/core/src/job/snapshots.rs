//! Checkpoint snapshots of a routing job: OUTDIR/snapshots/NNNN.ses and NNNN.json.
//!
//! Fastroute writes its best board to its -do SES whenever a pass lowers the open count. A thread looks at that file every
//! interval and copies it when it changed, with a sidecar {t, elapsed_s, pass, open, stage, dsn}. The job image has no node, so the
//! frames are rendered off the job from these files (tools/board_frame.ts): no NNNN.png or latest.png comes from here.
use super::files::{atomic_write, iso_now, read_lossy, rounded, unix_time};
use super::progress::parse_pass;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::thread::{JoinHandle, spawn};
use std::time::{Duration, SystemTime};

/// (pass, open) of the last pass line of the router log.
pub fn last_pass(log: &Path) -> (Option<u64>, Option<u64>) {
    let text = read_lossy(log).unwrap_or_default();
    text.lines().rev().find_map(parse_pass).map_or((None, None), |pass| (Some(pass.number), Some(pass.open)))
}

/// What to copy and the sidecar's fields.
#[derive(Clone)]
pub struct Source {
    pub ses: PathBuf,
    pub outdir: PathBuf,
    pub log: PathBuf,
    pub stage: String,
    pub t0: f64,
    pub dsn: PathBuf,
}

struct Taker {
    source: Source,
    seen: Option<(u64, SystemTime)>,
    count: u64,
}

impl Taker {
    fn folder(&self) -> PathBuf {
        self.source.outdir.join("snapshots")
    }

    fn next_index(&self) -> u32 {
        let Ok(read) = fs::read_dir(self.folder()) else { return 0 };
        let names = read.filter_map(|entry| entry.ok()?.file_name().into_string().ok());
        names.filter(|name| name.ends_with(".ses")).filter_map(|name| name.get(..4)?.parse::<u32>().ok()).max().map_or(0, |last| last + 1)
    }

    /// One snapshot when the SES changed since the last look.
    fn take(&mut self) -> Result<(), String> {
        let Ok(meta) = fs::metadata(&self.source.ses) else { return Ok(()) };
        let signature = (meta.len(), meta.modified().map_err(|e| e.to_string())?);
        if self.seen == Some(signature) {
            return Ok(());
        }
        self.seen = Some(signature);
        let folder = self.folder();
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let index = self.next_index();
        let bytes = fs::read(&self.source.ses).map_err(|e| e.to_string())?;
        atomic_write(&folder.join(format!("{index:04}.ses")), &bytes)?;
        let (pass, open) = last_pass(&self.source.log);
        let elapsed = rounded(unix_time() - self.source.t0, 1);
        let side = json!({"t": iso_now(), "elapsed_s": elapsed, "pass": pass, "open": open, "stage": self.source.stage, "dsn": self.source.dsn.display().to_string()});
        fs::write(folder.join(format!("{index:04}.json")), side.to_string()).map_err(|e| e.to_string())?;
        self.count += 1;
        Ok(())
    }
}

/// The thread; `stop` ends it after one last look at the SES.
pub struct Watcher {
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<Result<(), String>>>,
}

fn run(mut taker: Taker, interval: Duration, stopped: &Receiver<()>) -> Result<(), String> {
    let mut first_error = None;
    loop {
        let last = match stopped.recv_timeout(interval) {
            Err(RecvTimeoutError::Timeout) => false,
            _ => true,
        };
        if let Err(error) = taker.take() {
            first_error.get_or_insert(error);
        }
        if last {
            return first_error.map_or(Ok(()), Err);
        }
    }
}

impl Watcher {
    /// `interval_s` 0 is off.
    pub fn start(source: Source, interval_s: f64) -> Watcher {
        if interval_s <= 0.0 {
            return Watcher { stop: None, thread: None };
        }
        let (stop, stopped) = channel();
        let taker = Taker { source, seen: None, count: 0 };
        let interval = Duration::from_secs_f64(interval_s);
        Watcher { stop: Some(stop), thread: Some(spawn(move || run(taker, interval, &stopped))) }
    }

    /// Takes the final snapshot and ends the thread. A snapshot error stays here: the job never stops for one.
    pub fn stop(&mut self) -> Result<(), String> {
        drop(self.stop.take());
        match self.thread.take().map(JoinHandle::join) {
            Some(Ok(result)) => result,
            Some(Err(_)) => Err("snapshot thread panicked".to_string()),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn source(name: &str) -> Source {
        let outdir = std::env::temp_dir().join(format!("job-snap-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outdir);
        fs::create_dir_all(&outdir).unwrap();
        Source { ses: outdir.join("board.ses"), log: outdir.join("run.log"), outdir: outdir.clone(), stage: "route".to_string(), t0: unix_time(), dsn: outdir.join("board.dsn") }
    }

    #[test]
    fn a_changed_ses_is_copied_once_with_its_pass() {
        let source = source("copy");
        let mut taker = Taker { source: source.clone(), seen: None, count: 0 };
        taker.take().unwrap();
        assert_eq!(taker.count, 0);
        fs::write(&source.ses, "(ses)").unwrap();
        fs::write(&source.log, "Auto-routing pass #1 was completed in 1.0 seconds with score 1 (9 unrouted and 0 violations)\nAuto-routing pass #2 was completed in 1.0 seconds with score 1 (5 unrouted and 0 violations)\n").unwrap();
        taker.take().unwrap();
        taker.take().unwrap();
        assert_eq!(taker.count, 1);
        let side: Value = serde_json::from_slice(&fs::read(source.outdir.join("snapshots/0000.json")).unwrap()).unwrap();
        assert_eq!((side["pass"].as_u64(), side["open"].as_u64(), side["stage"].as_str()), (Some(2), Some(5), Some("route")));
        assert_eq!(fs::read_to_string(source.outdir.join("snapshots/0000.ses")).unwrap(), "(ses)");
        fs::write(&source.ses, "(ses longer)").unwrap();
        taker.take().unwrap();
        assert!(source.outdir.join("snapshots/0001.ses").is_file());
    }

    #[test]
    fn interval_zero_starts_nothing_and_stop_takes_the_last_one() {
        let source = source("stop");
        fs::write(&source.ses, "(ses)").unwrap();
        Watcher::start(source.clone(), 0.0).stop().unwrap();
        assert!(!source.outdir.join("snapshots").exists());
        let mut watcher = Watcher::start(source.clone(), 30.0);
        watcher.stop().unwrap();
        assert!(source.outdir.join("snapshots/0000.ses").is_file());
    }
}
