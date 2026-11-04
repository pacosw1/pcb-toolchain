//! Native polygon and connectivity engine for tools/gerber_netcheck.ts. One JSON request on stdin, one report on stdout.
#[path = "../gerber_netcheck/mod.rs"]
mod gerber_netcheck;

use std::io::{self, Read};

fn main() -> std::process::ExitCode {
    let mut text = String::new();
    let result = io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str(&text).map_err(|e| e.to_string()))
        .and_then(|input| gerber_netcheck::check(&input));
    match result {
        Ok(report) => {
            let code = if report.passed() { 0 } else { 1 };
            println!(
                "{}",
                serde_json::to_string(&report).expect("report serializes")
            );
            std::process::ExitCode::from(code)
        }
        Err(error) => {
            eprintln!("FAIL gerber_netcheck: {error}");
            std::process::ExitCode::from(2)
        }
    }
}

#[cfg(test)]
#[path = "../gerber_netcheck/tests.rs"]
mod tests;
