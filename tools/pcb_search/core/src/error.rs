//! The one error of this crate: an input it refuses, with the reason the user reads.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

pub type Result<T> = std::result::Result<T, Invalid>;

/// Shorthand for the common `Err(Invalid(...))`.
pub fn invalid<T>(reason: impl Into<String>) -> Result<T> {
    Err(Invalid(reason.into()))
}

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Invalid {}

impl From<std::io::Error> for Invalid {
    fn from(error: std::io::Error) -> Self {
        Invalid(error.to_string())
    }
}

impl From<serde_json::Error> for Invalid {
    fn from(error: serde_json::Error) -> Self {
        Invalid(error.to_string())
    }
}
