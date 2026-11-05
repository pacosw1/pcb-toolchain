//! Conservative pre-solver coverage of native rules by the actual DSN model.
//!
//! An admission check, not native acceptance. Unrepresented routing semantics (creepage and spatial selectors included) block,
//! even with the rule compiler on. No flag bypasses the check, and the final native gates still apply. The selector and rule
//! reading is `model::selector`; this module adds the DSN model, the decision per rule and the binding to exact input files.
mod backend_argv;
mod collaborators;
mod discharge;
mod dsn_model;
mod files;
mod forms;
mod identity;
mod inspect;
mod project_file;
mod requirement;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_files;
mod thermal;
mod types;

pub use backend_argv::validate_backend_command;
pub use collaborators::{Collaborators, DrilledRequest, HoleRequest, ProjectRequest, RouteCoverageTool};
pub use discharge::{Discharge, discharge_native};
pub use dsn_model::{ClassModel, Model, number, unit_mm};
pub use files::{CheckRequest, check_files};
pub use forms::{dsn_forms, rule_forms};
pub use inspect::{inspect, native_drc};
pub use project_file::{ClassClearance, ProjectClearances, project_clearances};
pub use requirement::{ClearanceRequirement, RequirementRow, SourcePointer, project_clearance_requirement};
pub use thermal::thermal_scope;
pub use types::{Coverage, Disposition, DsnBinding, FileBinding, Obstacle, RouteScope, Row, Status, Witness};

pub const SCHEMA: &str = "iot-lab.route-rule-coverage.v1";
