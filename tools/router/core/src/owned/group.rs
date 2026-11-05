//! Who is still in an owned process group. Inspection only: this never picks a PID to signal.
//!
//! Linux reads /proc, so images need no ps. Darwin reads /bin/ps. Malformed observations fail closed.

use super::failure::Failure;
use std::path::Path;
use std::time::Instant;

#[derive(Debug, PartialEq)]
pub struct ProcRow {
    pub pid: i32,
    pub parent: i32,
    pub group: i32,
    pub state: char,
}

const MALFORMED: &str = "malformed native process-group state";

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// One /proc/PID/stat line. comm is parenthesized and may hold spaces or ')', so fields start after the last ')'.
/// A task being released has left its group: Linux prints parent 0, group -1, session -1, with state X or a stale Z.
/// No owned group can equal -1. Any other non-numeric parent or group stays malformed.
pub fn parse_proc_stat(line: &str) -> Result<ProcRow, Failure> {
    let malformed = || Failure::value(MALFORMED);
    let (before, after) = line.rsplit_once(')').ok_or_else(malformed)?;
    let pid = before.split('(').next().unwrap_or("").trim();
    let fields: Vec<&str> = after.split_whitespace().collect();
    let [state, parent, group, ..] = fields[..] else { return Err(malformed()) };
    let mut letters = state.chars();
    let (Some(letter), None) = (letters.next(), letters.next()) else { return Err(malformed()) };
    let released = fields.get(1..4) == Some(&["0", "-1", "-1"]);
    if !digits(pid) || !"RSDZTtXxKWPI".contains(letter) || !(digits(parent) && digits(group) || released) {
        return Err(malformed());
    }
    let number = |text: &str| text.parse::<i32>().map_err(|_| malformed());
    Ok(ProcRow { pid: number(pid)?, parent: number(parent)?, group: number(group)?, state: letter })
}

fn is_gone(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOENT) | Some(libc::ESRCH))
}

/// Every process below `root`. /proc lists every process, not only owned ones, and any can exit during the scan:
/// open fails with ENOENT or ESRCH, or a read after a good open fails with ESRCH. All mean a reaped PID.
fn scan_proc(root: &Path, deadline: Instant, budget: &str) -> Result<Vec<ProcRow>, Failure> {
    let mut rows = Vec::new();
    for entry in std::fs::read_dir(root)? {
        if Instant::now() >= deadline {
            return Err(Failure::timeout(budget));
        }
        let entry = entry?;
        let name = entry.file_name();
        let Some(pid) = name.to_str().filter(|name| digits(name)) else { continue };
        let bytes = match std::fs::read(entry.path().join("stat")) {
            Ok(bytes) => bytes,
            Err(error) if is_gone(&error) => continue,
            Err(error) => return Err(error.into()),
        };
        let row = parse_proc_stat(&String::from_utf8_lossy(&bytes))?;
        if row.pid.to_string() != pid {
            return Err(Failure::value("native process state PID mismatched"));
        }
        rows.push(row);
    }
    Ok(rows)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn members_of(rows: &[ProcRow], group: i32, leader: i32, include_zombies: bool) -> Vec<i32> {
    let counted = |row: &&ProcRow| include_zombies || !matches!(row.state, 'Z' | 'X' | 'x');
    rows.iter().filter(|row| row.group == group && row.pid != leader).filter(counted).map(|row| row.pid).collect()
}

/// One `ps -axo pid=,pgid=,stat=` row: (pid, group, stat). An unknown `?` run state stays live, including the
/// observed transient `?E` of an exiting process.
#[cfg_attr(target_os = "linux", allow(dead_code))]
fn parse_ps_row(line: &str) -> Result<(i32, i32, String), Failure> {
    let malformed = || Failure::value(format!("{MALFORMED}: {line:?}"));
    let fields: Vec<&str> = line.split_whitespace().collect();
    let [pid, group, stat] = fields[..] else { return Err(malformed()) };
    let known = stat.chars().next().is_some_and(|letter| "RSDZTtXxKWPIU?".contains(letter));
    if !digits(pid) || !digits(group) || !known {
        return Err(malformed());
    }
    Ok((pid.parse().map_err(|_| malformed())?, group.parse().map_err(|_| malformed())?, stat.to_string()))
}

#[cfg_attr(target_os = "linux", allow(dead_code))]
fn ps_members(text: &str, group: i32, leader: i32, include_zombies: bool) -> Result<Vec<i32>, Failure> {
    let mut members = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let (pid, row_group, stat) = parse_ps_row(line)?;
        if row_group == group && pid != leader && (include_zombies || !stat.starts_with('Z')) {
            members.push(pid);
        }
    }
    Ok(members)
}

#[cfg(not(target_os = "linux"))]
fn run_ps(deadline: Instant) -> Result<String, Failure> {
    use super::capture::Capture;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    let mut child = Command::new("/bin/ps").args(["-axo", "pid=,pgid=,stat="])
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let mut capture = Capture::default();
    let stdout = child.stdout.take().ok_or_else(|| Failure::runtime("ps has no stdout pipe"))?;
    let index = capture.add(stdout.into())?;
    while capture.is_open() {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::timeout("native group-state budget exhausted"));
        }
        capture.pump(left.min(Duration::from_millis(20)))?;
    }
    if !child.wait()?.success() {
        return Err(Failure::new("OSError", "owned-group membership unavailable"));
    }
    Ok(String::from_utf8_lossy(&capture.take(index)).into_owned())
}

/// Members of `group` other than `leader`; pass -1 as leader to count it too. The leader is still our unreaped
/// child, and a new-session group cannot gain foreign-session members.
pub fn live_members(group: i32, leader: i32, deadline: Instant, include_zombies: bool) -> Result<Vec<i32>, Failure> {
    const BUDGET: &str = "native group-state budget exhausted";
    if Instant::now() >= deadline {
        return Err(Failure::timeout(BUDGET));
    }
    #[cfg(target_os = "linux")]
    return Ok(members_of(&scan_proc(Path::new("/proc"), deadline, BUDGET)?, group, leader, include_zombies));
    #[cfg(not(target_os = "linux"))]
    return ps_members(&run_ps(deadline)?, group, leader, include_zombies);
}

/// Zombie nonleaders of `leader`'s group that the kernel adopted to this process. Never another registered leader
/// or an arbitrary child, and the leader's unreaped state keeps the group identity reserved meanwhile.
pub fn adopted_zombies(leader: i32, deadline: Instant) -> Result<Vec<i32>, Failure> {
    if !cfg!(target_os = "linux") {
        return Ok(Vec::new());
    }
    let me = std::process::id() as i32;
    let rows = scan_proc(Path::new("/proc"), deadline, "owned adoption budget exhausted")?;
    Ok(rows.iter().filter(|row| row.pid != leader && row.group == leader && row.parent == me && row.state == 'Z')
        .map(|row| row.pid).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(5)
    }

    fn fake_proc(name: &str, pid: &str, stat: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("owned-group-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(pid)).unwrap();
        fs::write(root.join(pid).join("stat"), stat).unwrap();
        root
    }

    #[test]
    fn comm_may_hold_spaces_and_brackets() {
        let row = parse_proc_stat("123 (name with ) bracket) S 1 123 1").unwrap();
        assert_eq!(row, ProcRow { pid: 123, parent: 1, group: 123, state: 'S' });
    }

    #[test]
    fn unknown_state_is_rejected() {
        assert!(parse_proc_stat("123 (name) Q 1 123").is_err());
    }

    #[test]
    fn a_stat_of_another_pid_is_rejected() {
        let root = fake_proc("mismatch", "123", "456 (name) S 1 123");
        let error = scan_proc(&root, soon(), "budget").unwrap_err();
        assert!(error.message.contains("PID mismatched"), "{error}");
    }

    #[test]
    fn a_task_being_released_is_no_group_member() {
        // Rows seen in real exits on Linux 6.12: state X or a stale Z, parent 0, group and session -1.
        for state in ['X', 'Z'] {
            let line = format!("239587 (true) {state} 0 -1 -1 0 -1 4227084 48 0 0 0 0 0 0 0 20 0 0 0 687932574 0 0 0\n");
            let row = parse_proc_stat(&line).unwrap();
            assert_eq!((row.pid, row.group, row.state), (239587, -1, state));
            let rows = scan_proc(&fake_proc(&format!("released-{state}"), "239587", &line), soon(), "budget").unwrap();
            assert!(members_of(&rows, 123, 123, true).is_empty());
        }
    }

    #[test]
    fn other_negative_groups_stay_malformed() {
        for bad in ["1 (x) S 1 -1 -1 0", "1 (x) S 0 -1 5 0", "1 (x) S 0 -2 -2 0", "1 (x) S 0 -1"] {
            assert!(parse_proc_stat(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_process_gone_during_the_scan_is_skipped() {
        let root = fake_proc("gone", "123", "123 (name) S 1 123");
        fs::create_dir_all(root.join("124")).unwrap();
        let rows = scan_proc(&root, soon(), "budget").unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn zombies_count_only_on_request() {
        let rows = [ProcRow { pid: 2, parent: 1, group: 9, state: 'Z' }, ProcRow { pid: 3, parent: 1, group: 9, state: 'S' }];
        assert_eq!(members_of(&rows, 9, 9, false), [3]);
        assert_eq!(members_of(&rows, 9, 9, true), [2, 3]);
    }

    #[test]
    fn an_expired_budget_stops_the_scan() {
        let root = fake_proc("budget", "123", "123 (name) S 1 123");
        assert_eq!(scan_proc(&root, Instant::now(), "budget").unwrap_err().kind, "TimeoutError");
    }

    #[test]
    fn malformed_ps_rows_fail_closed() {
        assert!(ps_members("bad row\n", 123, 123, false).is_err());
    }

    #[test]
    fn an_unknown_exiting_ps_state_stays_live() {
        assert_eq!(ps_members("123 123 ?E\n", 123, 999, false).unwrap(), [123]);
    }

    #[test]
    fn ps_zombies_and_the_leader_are_not_live() {
        let text = "  10 10 Ss\n  11 10 Z\n  12 10 S+\n  13 77 S\n";
        assert_eq!(ps_members(text, 10, 10, false).unwrap(), [12]);
        assert_eq!(ps_members(text, 10, -1, true).unwrap(), [10, 11, 12]);
    }
}
