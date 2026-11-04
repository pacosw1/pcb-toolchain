//! iotplace: the placer core. See tools/placer/README.md.

pub mod bench;
pub mod crossing;
pub mod domain;
pub mod dru;
pub mod escape;
pub mod evaluator;
pub mod geom;
pub mod gplace;
pub mod layout;
pub mod mains;
pub mod mask;
pub mod model;
pub mod numeric;
pub mod params;
pub mod problem;
pub mod rows;
pub mod rudy;
pub mod search;
pub mod spacing;
pub mod via;
pub mod wirelen;

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
