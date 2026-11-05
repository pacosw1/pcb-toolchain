//! Native board text: hashing it, reading the few fields a proposal touches, and editing it in place.
//!
//! This is text work on KiCad 10 files. Board semantics such as pad shapes and connectivity come from
//! `iotroute board-json`, not from here.

pub mod board;
pub mod candidate;
pub mod conflicts;
pub mod copper;
pub mod digest;
pub mod eco;
