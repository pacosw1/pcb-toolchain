//! Routing-flow feature switches (`tools/route-features.json`) and the DSN side of them, for the route job.
//!
//! Resolution order, later wins: the defaults file, `<board>/gate.json` "route_features" (merged per feature), the environment
//! `ROUTE_FEATURES="name=1,name=0"` (`all=1` / `all=0` set every flag first). The board is `ROUTE_BOARD` or found from the PCB
//! path. No board reads here: the caller gives the board data.
mod compile;
mod config;
mod dsn_edit;
mod exact;
mod strengthen;
#[cfg(test)]
mod tests;

pub use compile::{Compiled, ExtraRule, compile_dru, mm, spelled_out};
pub use config::{Env, FLAGS, Feature, Features, HaloEvidence, board_dir, defaults_path, halo_nets, learned_halo, load, load_with, on, root, source_fingerprint, summary};
pub use dsn_edit::{add_class_class, add_via_keepouts, apply_layer_masks, dsn_classes, verify_layer_masks};
pub use strengthen::{ClearanceEdit, ProjectBinding, STRENGTHENING_SCHEMA, StrengthenReceipt, strengthen_project_clearance};
