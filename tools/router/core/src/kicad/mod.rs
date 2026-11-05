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
pub mod session;
pub mod sexpr;
pub mod shape;

pub use board::Board;
pub use board_json::cli;

const MAC_KICAD_CLI: &str = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

/// KiCad 10's kicad-cli: env KICAD_CLI, else the Mac install when it is there, else from PATH.
pub fn kicad_cli() -> String {
    std::env::var("KICAD_CLI").unwrap_or_else(|_| if std::path::Path::new(MAC_KICAD_CLI).exists() { MAC_KICAD_CLI.to_string() } else { "kicad-cli".to_string() })
}
