//! The parts of the core that other tools use. The router itself is the binary, main.rs.
pub mod decimal;
pub mod gnd_pad_vias;
pub mod grid;
pub mod gerber_geometry;
pub mod gerber_geos;
pub mod job;
pub mod kicad;
pub mod model;
pub mod owned;
pub mod pair;
pub mod pin_escape;
pub mod plan;
pub mod pytext;
pub mod route_features;
pub mod routing_rules;
pub mod run;
pub mod sha256;
pub mod si;
pub mod stuck;
pub mod tool_args;

pub mod live_spool;
