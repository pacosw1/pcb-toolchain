use super::*;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) fn executable(name: &str, env: &Environment) -> Result<PathBuf> {
    let candidates = if name.contains('/') {
        vec![PathBuf::from(name)]
    } else {
        std::env::split_paths(env.get("PATH").map_or("", String::as_str))
            .map(|path| path.join(name))
            .collect()
    };
    for path in candidates {
        if fs::metadata(&path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) {
            return absolute(&path);
        }
    }
    Err(format!(
        "controlled routing executable is unavailable: {name}"
    ))
}

pub(crate) fn probe(
    command: &[String],
    env: &Environment,
    probes: &mut Vec<Value>,
) -> Result<String> {
    let mut child = Command::new(&command[0])
        .args(&command[1..])
        .env_clear()
        .envs(env)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("controlled routing runtime probe failed: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let err = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes).map(|_| bytes)
    });
    let started = Instant::now();
    // The original routing-runtime-probe budget is five seconds. Kill the whole probe group before joining its pipes.
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            Ok(None) => {
                break Err("controlled routing runtime probe failed: deadline exceeded".to_string());
            }
            Err(error) => break Err(error.to_string()),
        }
    };
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.wait();
    let stdout = out
        .join()
        .map_err(|_| "probe stdout reader failed")?
        .map_err(|e| e.to_string())?;
    let stderr = err
        .join()
        .map_err(|_| "probe stderr reader failed")?
        .map_err(|e| e.to_string())?;
    let status = status?;
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    )
    .trim()
    .to_string();
    probes.push(
        json!({ "command": command, "returncode": status.code().unwrap_or(-1), "output": output }),
    );
    ensure(
        status.success() && !output.is_empty(),
        format!("controlled routing version probe failed: {command:?}"),
    )?;
    Ok(output)
}
