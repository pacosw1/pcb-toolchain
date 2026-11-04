//! Proposal search for PCB routing and native board text. Everything here proposes; native checks decide.

pub mod budget;
pub mod cli;
pub mod contract;
pub mod error;
pub mod native;
pub mod patterns;
pub mod pyjson;
/// The router core's decimal and raw reader, included by path: linking iotroute would merge the two crates' serde_json features.
#[path = "../../../router/core/src/decimal.rs"]
pub mod decimal;
#[path = "../../../router/core/src/kicad/raw.rs"]
pub mod raw;
