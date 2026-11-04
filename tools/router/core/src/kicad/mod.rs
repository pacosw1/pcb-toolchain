//! KiCad without pcbnew: boards through the IPC API, the text and arithmetic the rule files need.
pub mod api;
pub mod board;
pub mod board_json;
pub mod edit;
pub mod geom;
pub mod item_text;
pub mod pad;
pub mod raw;
pub mod rules;
pub mod save;
pub mod sexpr;
pub mod shape;

pub use board::Board;
pub use board_json::cli;
