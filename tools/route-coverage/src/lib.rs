//! Route admission proofs. Native geometry comes only from `iotroute board-json`.
//! These checks never establish electrical acceptance or execute a native save.
pub mod board;
pub mod decimal;
pub mod dsn;
pub mod evidence;
pub mod hole;
pub mod project;
pub mod thermal;

pub type Result<T> = std::result::Result<T, String>;
