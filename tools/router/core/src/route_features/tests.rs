use super::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

fn classes(rows: &[(&str, &str)]) -> BTreeMap<String, String> {
    rows.iter().map(|(net, class)| (net.to_string(), class.to_string())).collect()
}

fn pads(rows: &[(&str, &[&str])]) -> BTreeMap<String, BTreeSet<String>> {
    rows.iter().map(|(net, layers)| (net.to_string(), layers.iter().map(|layer| layer.to_string()).collect())).collect()
}

struct Project {
    root: PathBuf,
}

impl Drop for Project {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

impl Project {
    fn new() -> Project {
        let root = std::env::temp_dir().join(format!("route-features-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(root.join("tools")).unwrap();
        fs::create_dir_all(root.join("hardware-design/boards/B/cad/B")).unwrap();
        let flags: serde_json::Map<String, serde_json::Value> = FLAGS.iter().map(|flag| (flag.to_string(), json!({"on": false}))).collect();
        fs::write(root.join("tools/route-features.json"), json!({"features": flags}).to_string()).unwrap();
        Project { root }
    }

    fn env(&self) -> Env {
        Env { root: self.root.clone(), ..Env::default() }
    }

    fn board(&self) -> PathBuf {
        self.root.join("hardware-design/boards/B")
    }

    fn pcb(&self) -> PathBuf {
        self.board().join("cad/B/B.kicad_pcb")
    }
}

#[test]
fn gate_merges_per_feature_and_the_environment_goes_last() {
    let project = Project::new();
    fs::write(project.board().join("gate.json"), r#"{"route_features": {"via_halo": {"on": true, "size_mm": 2.0}, "new_one": {"x": 1}}}"#).unwrap();
    let features = load_with(&project.env(), None, Some("B")).unwrap();
    assert!(on(&features, "via_halo"));
    assert_eq!(features.setting("via_halo", "size_mm"), Some(&json!(2.0)));
    assert_eq!(features.setting("new_one", "x"), Some(&json!(1)));
    assert_eq!(features.board_dir.as_deref(), Some(project.board().as_path()));
    let env = Env { overrides: "all=0,fail_fast=1, via_halo = off,nothing=1".to_string(), ..project.env() };
    let features = load_with(&env, None, Some("B")).unwrap();
    assert!(!on(&features, "via_halo") && on(&features, "fail_fast"));
    assert_eq!(summary(&features), "triage_opens=off rule_compiler=off via_off_small_pads=off pin_escape_check=off via_halo=off routing_rules=off fail_fast=on");
}

#[test]
fn the_board_comes_from_the_name_the_environment_or_the_pcb_path() {
    let project = Project::new();
    fs::write(project.board().join("gate.json"), "{}").unwrap();
    let env = project.env();
    assert_eq!(board_dir(&env, None, Some("B")), Some(project.board()));
    assert_eq!(board_dir(&env, None, Some("absent")), None);
    assert_eq!(board_dir(&Env { board: "B".to_string(), ..env.clone() }, None, None), Some(project.board()));
    assert_eq!(board_dir(&env, Some(&project.pcb()), None), Some(project.board()));
    let copy = project.root.join("elsewhere/B.kicad_pcb");
    assert_eq!(board_dir(&env, Some(&copy), None), Some(project.board()));
    assert_eq!(board_dir(&env, Some(Path::new("/nowhere/x/y.kicad_pcb")), None), None);
}

#[test]
fn learned_halo_needs_the_exact_cad() {
    let project = Project::new();
    let pcb = project.pcb();
    fs::write(&pcb, "(kicad_pcb)").unwrap();
    fs::create_dir_all(project.board().join(".gate")).unwrap();
    let file = project.board().join(".gate/halo-nets.json");
    assert_eq!(learned_halo(&pcb, Some(&project.board())).unwrap(), (Vec::new(), None));
    let fingerprint = source_fingerprint(&pcb).unwrap();
    assert_eq!(fingerprint.keys().collect::<Vec<_>>(), [".kicad_pcb"]);
    fs::write(&file, json!({"nets": ["/A"], "source_fingerprint": fingerprint}).to_string()).unwrap();
    let (nets, evidence) = learned_halo(&pcb, Some(&project.board())).unwrap();
    assert_eq!(nets, ["/A"]);
    assert!(evidence.unwrap().accepted);
    fs::write(&pcb, "(kicad_pcb changed)").unwrap();
    let (nets, evidence) = learned_halo(&pcb, Some(&project.board())).unwrap();
    assert!(nets.is_empty() && !evidence.unwrap().accepted);
}

#[test]
fn halo_nets_take_globs_classes_files_and_default_to_every_net() {
    let project = Project::new();
    fs::write(project.board().join("rp001-fast-nets.json"), r#"{"fast": ["/F*"]}"#).unwrap();
    let nets = strings(&["/A", "/F1", "/P"]);
    let net_class = classes(&[("/P", "PWR")]);
    let mut features = Features::default();
    let halo = |value: serde_json::Value| value.as_object().unwrap().clone();
    features.features.insert("via_halo".to_string(), halo(json!({})));
    assert_eq!(halo_nets(&features, &nets, &net_class, None, None).unwrap(), nets);
    features.features.insert("via_halo".to_string(), halo(json!({"nets": ["/A"], "classes": ["PWR"], "fast_nets_file": "rp001-fast-nets.json"})));
    assert_eq!(halo_nets(&features, &nets, &net_class, Some(&project.board()), None).unwrap(), nets);
    features.features.insert("via_halo".to_string(), halo(json!({"nets": ["/A"]})));
    assert_eq!(halo_nets(&features, &nets, &net_class, None, None).unwrap(), ["/A"]);
}

#[test]
fn compile_turns_rules_into_masks_pairs_and_notes() {
    let dru = "(version 1)
(rule \"no inner\" (layer \"In1.Cu\") (condition \"A.NetClass == 'FAST'\") (constraint disallow track))
(rule \"no via\" (condition \"A.NetName == '/V'\") (constraint disallow via))
(rule \"iso\" (condition \"A.NetClass == 'HV' && B.NetClass != 'HV'\") (constraint clearance (min 2mm)))
(rule \"width\" (constraint track_width (min 0.2mm)))
(rule \"pads\" (constraint disallow pad))
(rule \"area\" (condition \"A.intersectsArea('X')\") (constraint disallow track))
(rule \"one side\" (condition \"A.NetClass == 'HV'\") (constraint clearance (min 1mm)))";
    let nets = strings(&["/F", "/H", "/V"]);
    let net_class = classes(&[("/F", "FAST"), ("/H", "HV"), ("/V", "kicad_default")]);
    let layers = strings(&["F.Cu", "In1.Cu", "B.Cu"]);
    let compiled = compile_dru(dru, &nets, &net_class, &pads(&[("/V", &["F.Cu", "*"])]), &layers, &[]).unwrap();
    assert_eq!(compiled.masks, BTreeMap::from([("/F".to_string(), strings(&["F.Cu", "B.Cu"])), ("/V".to_string(), strings(&["F.Cu"]))]));
    assert_eq!(compiled.pairs, BTreeMap::from([(("FAST".to_string(), "HV".to_string()), 2.0), (("HV".to_string(), "kicad_default".to_string()), 2.0)]));
    assert_eq!(compiled.notes, [
        "rule 'no inner': disallow track -> 1 net(s)",
        "rule 'no via': disallow via -> 1 net(s)",
        "rule 'iso': clearance 2 mm -> 2 class pair(s)",
        "rule 'width': track_width not compiled; mandatory native/final post-check",
        "rule 'pads': disallow pad not compiled; mandatory native post-check",
        "rule 'area': term intersectsArea not supported, not compiled",
        "rule 'one side': clearance not compiled; mandatory native post-check",
    ]);
}

#[test]
fn a_rule_that_stops_keeps_what_the_nets_before_it_got() {
    let dru = "(rule \"mixed\" (layer \"B.Cu\") (condition \"A.NetName == '/A' || A.intersectsArea('X')\") (constraint disallow track))";
    let nets = strings(&["/A", "/B"]);
    let compiled = compile_dru(dru, &nets, &classes(&[("/A", "C"), ("/B", "C")]), &BTreeMap::new(), &strings(&["F.Cu", "B.Cu"]), &[]).unwrap();
    assert_eq!(compiled.masks["/A"], ["F.Cu"]);
    assert_eq!(compiled.notes, ["rule 'mixed': term intersectsArea not supported, not compiled"]);
}

#[test]
fn rules_that_cannot_be_met_are_errors() {
    let layers = strings(&["F.Cu", "B.Cu"]);
    let nets = strings(&["/A"]);
    let net_class = classes(&[("/A", "C")]);
    let every = "(rule \"all\" (condition \"A.NetName == '/A'\") (constraint disallow track))";
    assert_eq!(compile_dru(every, &nets, &net_class, &BTreeMap::new(), &layers, &[]).unwrap_err(), "rule 'all': track prohibited on every layer for /A");
    let ban = "(rule \"v\" (condition \"A.NetName == '/A'\") (constraint disallow via))";
    let split = pads(&[("/A", &["F.Cu", "B.Cu"])]);
    assert_eq!(compile_dru(ban, &nets, &net_class, &split, &layers, &[]).unwrap_err(), "via ban on /A: cannot construct a legal single-layer route");
    let extra = ExtraRule { nets: strings(&["/*"]), deny_layers: layers.clone(), about: Some(json!("deny all")), ..ExtraRule::default() };
    assert_eq!(compile_dru("", &nets, &net_class, &BTreeMap::new(), &layers, &[extra]).unwrap_err(), "/A: every job layer denied");
}

#[test]
fn extra_rules_match_nets_and_kicad_class_names() {
    let layers = strings(&["F.Cu", "In1.Cu", "B.Cu"]);
    let nets = strings(&["/A", "/B", "/C"]);
    let net_class = classes(&[("/A", "kicad_default"), ("/B", "X"), ("/C", "X")]);
    let rule = ExtraRule { nets: strings(&["/B"]), classes: strings(&["Default"]), deny_layers: strings(&["In1.Cu"]), no_via: false, about: Some(json!("fast off inner")) };
    let compiled = compile_dru("", &nets, &net_class, &BTreeMap::new(), &layers, &[rule]).unwrap();
    assert_eq!(compiled.masks.keys().collect::<Vec<_>>(), ["/A", "/B"]);
    assert_eq!(compiled.notes, ["extra rule fast off inner: 2 net(s)"]);
    let no_via = ExtraRule { nets: strings(&["/C"]), no_via: true, about: Some(json!("x")), ..ExtraRule::default() };
    let compiled = compile_dru("", &nets, &net_class, &BTreeMap::new(), &layers, &[no_via]).unwrap();
    assert_eq!(compiled.masks["/C"], ["F.Cu"]);
}

#[test]
fn mm_reads_the_number_at_the_start() {
    assert_eq!(mm("0.2mm"), Ok(0.2));
    assert_eq!(mm("10mil").unwrap(), 10.0 * 0.0254);
    assert_eq!(mm("1 in").unwrap(), 25.4);
    assert_eq!(mm("3cm"), Ok(3.0));
    assert!(mm("-1mm").is_err() && mm("1.2.3").is_err());
}

const NETWORK: &str = "(pcb x
  (parser
    (string_quote \")
  )
  (structure
    (layer F.Cu (type signal))
    (rule (clearance 200))
    (via \"Via[0-1]_600:300_um\")
    (rule (clearance 300))
  )
  (network
    (class kicad_default \"\" /A \"/B C\" /D
      (circuit
        (use_via \"Via[0-1]_600:300_um\")
      )
      (rule
        (width 200)
      )
    )
    (class HV /E
      (circuit
        (use_via \"Via[0-1]_600:300_um\")
      )
      (rule
        (clearance 500)
      )
    )
  )
)
";

#[test]
fn dsn_classes_read_the_blocks_with_quoted_names() {
    let found = dsn_classes(NETWORK);
    assert_eq!(found[""], "kicad_default");
    assert_eq!(found["/B C"], "kicad_default");
    assert_eq!(found["/E"], "HV");
    assert_eq!(found.len(), 5);
}

#[test]
fn masks_move_nets_to_a_copy_of_their_class_and_read_back() {
    let masks = BTreeMap::from([("/A".to_string(), strings(&["F.Cu"])), ("/B C".to_string(), strings(&["F.Cu"])), ("/E".to_string(), strings(&["B.Cu"]))]);
    let text = apply_layer_masks(NETWORK, &masks);
    assert!(text.contains("(class kicad_default \"\" /D\n      (circuit\n        (use_via"), "{text}");
    assert!(text.contains("    (class kicad_default__L1 /A \"/B C\"\n      (circuit\n        (use_layer F.Cu)\n        (use_via"), "{text}");
    assert!(text.contains("    (class HV__L0 /E\n      (circuit\n        (use_layer B.Cu)\n        (use_via"), "{text}");
    verify_layer_masks(&text, &masks).unwrap();
    let mut wider = masks.clone();
    wider.insert("/A".to_string(), strings(&["F.Cu", "B.Cu"]));
    assert_eq!(verify_layer_masks(&text, &wider).unwrap_err(), "DSN layer mask not represented exactly: /A");
    wider.insert("/Z".to_string(), strings(&["F.Cu"]));
    wider.remove("/A");
    assert_eq!(verify_layer_masks(&text, &wider).unwrap_err(), "DSN missing layer-masked nets: ['/Z']");
    assert_eq!(apply_layer_masks(NETWORK, &BTreeMap::new()), NETWORK);
}

#[test]
fn class_pairs_follow_split_classes_and_keep_kicad_default_nets_apart() {
    let masks = BTreeMap::from([("/E".to_string(), strings(&["F.Cu"]))]);
    let split = apply_layer_masks(NETWORK, &masks);
    let pairs = BTreeMap::from([(("HV".to_string(), "kicad_default".to_string()), 1.5)]);
    let text = add_class_class(&split, &pairs);
    assert!(text.contains("(class kicad_default__nets \"\" /A"), "{text}");
    assert!(text.contains("    (class_class (classes HV kicad_default__nets)\n      (rule (clearance 1500))\n    )"), "{text}");
    assert!(text.contains("(class_class (classes HV__L0 kicad_default__nets)"), "{text}");
    assert_eq!(add_class_class(NETWORK, &BTreeMap::new()), NETWORK);
}

#[test]
fn class_clearance_rounds_to_even_um() {
    let pairs = BTreeMap::from([(("HV".to_string(), "HV".to_string()), 0.0005)]);
    assert!(add_class_class(NETWORK, &pairs).contains("(clearance 0)"));
}

#[test]
fn keepouts_stand_before_the_via_list_and_close_their_ring() {
    let polys = vec![("F.Cu".to_string(), vec![[1.0, 2.0], [3.5, 2.0], [3.5, 0.0]])];
    let text = add_via_keepouts(NETWORK, &polys);
    assert!(text.contains("\n    (via_keepout \"\" (polygon F.Cu 0  1000 -2000  3500 -2000  3500 -0  1000 -2000))\n    (via \"Via"), "{text}");
    assert_eq!(add_via_keepouts(NETWORK, &[]), NETWORK);
}
