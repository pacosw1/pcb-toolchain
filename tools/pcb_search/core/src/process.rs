//! Run a child process under a deadline, feeding its stdin and collecting its output.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::Result;

const POLL: Duration = Duration::from_millis(5);

pub struct Finished {
    /// None when the deadline killed the process.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Run `command` with `input` on stdin. Past `limit_s` it is killed; what it wrote until then is kept.
pub fn run_bounded(command: &mut Command, input: String, limit_s: f64) -> Result<Finished> {
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let stdin = child.stdin.take();
    let feeder = thread::spawn(move || {
        // A child that exits early closes the pipe; its exit code tells the story.
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(input.as_bytes());
        }
    });
    let stdout = read_all(child.stdout.take());
    let stderr = read_all(child.stderr.take());
    let code = wait_until(&mut child, Instant::now() + Duration::from_secs_f64(limit_s))?;
    let _ = feeder.join();
    Ok(Finished { code, stdout: collected(stdout), stderr: collected(stderr) })
}

fn read_all(stream: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut stream) = stream {
            let _ = stream.read_to_end(&mut bytes);
        }
        bytes
    })
}

fn collected(handle: thread::JoinHandle<Vec<u8>>) -> String {
    String::from_utf8_lossy(&handle.join().unwrap_or_default()).into_owned()
}

fn wait_until(child: &mut Child, deadline: Instant) -> Result<Option<i32>> {
    loop {
        if let Some(status) = child.try_wait()? {
            // A signal has no code; report it as a failure, not as a deadline.
            return Ok(Some(status.code().unwrap_or(-1)));
        }
        if Instant::now() >= deadline {
            child.kill()?;
            child.wait()?;
            return Ok(None);
        }
        thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[test]
    fn output_and_exit_code_come_back() {
        let done = run_bounded(&mut shell("cat; echo oops >&2; exit 4"), "hello".into(), 5.0).unwrap();
        assert_eq!((done.code, done.stdout.as_str(), done.stderr.trim()), (Some(4), "hello", "oops"));
    }

    #[test]
    fn the_deadline_kills_and_keeps_what_was_written() {
        let done = run_bounded(&mut shell("echo early >&2; exec sleep 30"), String::new(), 0.2).unwrap();
        assert_eq!(done.code, None);
        assert_eq!(done.stderr.trim(), "early");
    }

    #[test]
    fn large_input_and_output_do_not_deadlock() {
        let input = "x".repeat(1 << 20);
        let done = run_bounded(&mut shell("cat"), input.clone(), 10.0).unwrap();
        assert_eq!(done.stdout, input);
    }
}
