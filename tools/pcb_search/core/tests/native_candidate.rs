//! A native backend may add requested copper, never change protected content.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use pcbsearch::native::board::Board;
use pcbsearch::native::candidate::scope_native;
use pcbsearch::native::copper::Copper;
use pcbsearch::native::digest::{geometry_digest, source_set};
use serde_json::{Value, json};

const WANTED: &str = "/V_GAS";

fn segment(id: &str, net: &str) -> String {
    format!("(segment (start 0 0) (end 1 1) (width 0.25) (layer \"F.Cu\") (net {net}) (uuid \"{id}\"))")
}

struct Case {
    source: PathBuf,
    backend: PathBuf,
    out: PathBuf,
    original: String,
}

impl Case {
    fn new(name: &str) -> Case {
        let dir = std::env::temp_dir().join(format!("pcbsearch-candidate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("input.kicad_pcb");
        let original = segment("original", "\"GND\"");
        fs::write(&source, format!("(kicad_pcb (version 20260101) {original})")).unwrap();
        for extension in ["kicad_pro", "kicad_dru", "kicad_sch"] {
            fs::write(source.with_extension(extension), format!("unchanged {extension}")).unwrap();
        }
        Case { backend: dir.join("backend.kicad_pcb"), out: dir.join("scoped"), source, original }
    }

    fn with_additions(&self, additions: &[String]) {
        let text = fs::read_to_string(&self.source).unwrap();
        fs::write(&self.backend, format!("{}{})", &text[..text.len() - 1], additions.join(" "))).unwrap();
    }

    fn scope(&self, nets: &[&str]) -> Result<Value, String> {
        let nets: Vec<String> = nets.iter().map(|net| net.to_string()).collect();
        scope_native(&self.source, &self.backend, &self.out, &nets).map_err(|error| error.0)
    }
}

fn digest(path: &Path, omit: &[&str]) -> String {
    let omit: BTreeSet<String> = omit.iter().map(|id| id.to_string()).collect();
    geometry_digest(&Board::read(path).unwrap(), &omit).unwrap()
}

#[test]
fn other_nets_are_filtered_and_the_sidecars_stay() {
    let case = Case::new("filter");
    case.with_additions(&[segment("wanted", "\"/V_GAS\""), segment("extra", "\"GND\"")]);
    let before = source_set(&case.source).unwrap();
    let record = case.scope(&[WANTED]).unwrap();
    assert_eq!(record["added_items"], json!(["wanted"]));
    assert_eq!(record["discarded_items"], json!(["extra"]));
    assert_eq!(record["qualified"], false);
    let target = case.out.join("candidate.kicad_pcb");
    let board = Board::read(&target).unwrap();
    assert_eq!(Copper::read(&board).unwrap().ids(), BTreeSet::from(["original".to_string(), "wanted".to_string()]));
    assert_eq!(digest(&case.source, &[]), digest(&target, &["wanted"]));
    assert_eq!(source_set(&case.source).unwrap(), before);
    for extension in ["kicad_pro", "kicad_dru", "kicad_sch"] {
        assert_eq!(fs::read(target.with_extension(extension)).unwrap(), fs::read(case.source.with_extension(extension)).unwrap());
    }
    let written: Value = serde_json::from_str(&fs::read_to_string(case.out.join("record.json")).unwrap()).unwrap();
    assert_eq!(written, record);
}

#[test]
fn changed_or_missing_protected_copper_is_refused_before_any_output() {
    let case = Case::new("protected");
    case.with_additions(&[segment("wanted", "\"/V_GAS\"")]);
    let original = fs::read_to_string(&case.backend).unwrap();
    for changed in [original.replacen("(width 0.25)", "(width 0.15)", 1), original.replace(&case.original, "")] {
        fs::write(&case.backend, changed).unwrap();
        assert!(case.scope(&[WANTED]).unwrap_err().contains("protected"));
        assert!(!case.out.exists());
    }
}

#[test]
fn a_board_rule_or_placement_change_is_refused() {
    let case = Case::new("forms");
    for form in ["(setup (pad_to_mask_clearance 0.1))", "(footprint \"X\" (at 1 2) (uuid \"fp\"))"] {
        case.with_additions(&[segment("wanted", "\"/V_GAS\""), form.to_string()]);
        assert!(case.scope(&[WANTED]).unwrap_err().contains("protected"));
    }
}

#[test]
fn a_legacy_numeric_net_is_resolved() {
    let case = Case::new("legacy");
    fs::write(&case.source, format!("(kicad_pcb (net 1 \"GND\") (net 2 \"/V_GAS\") {})", segment("original", "1"))).unwrap();
    case.with_additions(&[segment("wanted", "2"), segment("extra", "1")]);
    let record = case.scope(&[WANTED]).unwrap();
    assert_eq!(record["added_items"], json!(["wanted"]));
    assert_eq!(record["discarded_items"], json!(["extra"]));
}

#[test]
fn an_unknown_net_code_and_a_repeated_identity_are_refused() {
    let case = Case::new("identity");
    for added in [segment("wanted", "27"), segment("original", "\"/V_GAS\"")] {
        case.with_additions(&[added]);
        assert!(case.scope(&[WANTED]).is_err());
    }
}

#[test]
fn an_empty_selection_and_an_existing_output_are_refused() {
    let case = Case::new("selection");
    case.with_additions(&[segment("wanted", "\"/V_GAS\"")]);
    for nets in [&[][..], &[WANTED, WANTED][..], &["/NOT_PRESENT"][..]] {
        assert!(case.scope(nets).is_err(), "{nets:?}");
    }
    fs::create_dir(&case.out).unwrap();
    assert!(case.scope(&[WANTED]).is_err());
}
