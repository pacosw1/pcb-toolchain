//! Proposal search for PCB placement and routing. Everything here proposes; native checks decide.

pub mod budget;
pub mod cli;
pub mod contract;
pub mod decimal;
pub mod error;
pub mod native;
pub mod patterns;
pub mod pyjson;
/// The router core's raw reader, included by path: linking iotroute would merge the two crates' serde_json features.
#[path = "../../../router/core/src/kicad/raw.rs"]
pub mod raw;
pub mod srj;
