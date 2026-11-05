//! The legality grid of a board (2026-10-09, route features triage_opens and pin_escape_check) and what is built on it. Idea from
//! TraceMaker (doc 05 s13 exact reachability, s16 pin access); the code is our own.
pub mod astar;
pub mod board;
pub mod cli;
pub mod escape;
pub mod finish;
pub mod flood;
pub mod item;
pub mod mask;
pub mod opens;
pub mod ripup;
pub mod sources;
#[cfg(test)]
mod tests;
pub mod triage;
pub mod via_near;

pub use board::{GridBoard, NetGrids, NetPad};
pub use escape::{EscapeConfig, EscapeReport, EscapeScope, Runtime, escape};
pub use item::{Item, ItemKind, Shape};
pub use mask::{Mask, Window};
pub use triage::{TriageConfig, TriageReport, TriageScope, triage};
