//! The same-host deadline of owned work: CLOCK_MONOTONIC seconds, passed on in IOT_LEAN_DEADLINE.
use std::collections::BTreeMap;

const PROTOCOL: &str = "clock-monotonic-v1:";
pub const DEADLINE_ENV: &str = "IOT_LEAN_DEADLINE";

pub type Env = BTreeMap<String, String>;

pub fn now() -> f64 {
    let mut clock = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut clock) };
    clock.tv_sec as f64 + clock.tv_nsec as f64 / 1e9
}

pub fn decode(value: &str) -> Result<f64, String> {
    let number = value.strip_prefix(PROTOCOL).ok_or("unsupported inherited deadline protocol")?;
    let deadline: f64 = number.parse().map_err(|_| "unsupported inherited deadline protocol".to_string())?;
    if deadline.is_finite() { Ok(deadline) } else { Err("deadline must be finite".to_string()) }
}

/// The shortest text that reads back as the same number, as Python's repr.
pub fn encode(deadline: f64) -> String {
    format!("{PROTOCOL}{deadline:?}")
}

pub fn inherited(env: &Env) -> Result<Option<f64>, String> {
    env.get(DEADLINE_ENV).map(|value| decode(value)).transpose()
}

/// `seconds` from now, never past an inherited deadline.
pub fn after(seconds: f64, env: &Env) -> Result<f64, String> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err("budget must be finite and nonnegative".to_string());
    }
    let value = now() + seconds;
    Ok(inherited(env)?.map_or(value, |deadline| value.min(deadline)))
}

/// Seconds left, 0 at the deadline and after; None with no deadline.
pub fn remaining(deadline: Option<f64>) -> Option<f64> {
    deadline.map(|deadline| (deadline - now()).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_deadline_reads_back_exactly() {
        let deadline = 12345.678901234;
        assert_eq!(decode(&encode(deadline)).unwrap(), deadline);
        assert_eq!(encode(1.5), "clock-monotonic-v1:1.5");
        assert!(decode("1.5").is_err());
        assert!(decode("clock-monotonic-v1:inf").is_err());
    }

    #[test]
    fn an_inherited_deadline_bounds_a_new_one() {
        let env = Env::from([(DEADLINE_ENV.to_string(), encode(now() + 1.0))]);
        assert!(after(100.0, &env).unwrap() < now() + 2.0);
        assert!(after(-1.0, &env).is_err());
    }
}
