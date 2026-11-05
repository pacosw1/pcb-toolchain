//! Admission end to end: `check_files` from the core with the project rules of this crate behind the real `route-coverage`
//! binary, as the job runs them. tools/test_route_rule_coverage.py ProjectCoverageTests.
//!
//! `board-json` needs the pinned KiCad API, so each fixture states its drilled items as the API rows that text stands for. The
//! `analytic` and `proof` hooks stand in for `route_hole_coverage.inspect` and `inspect_drilled` where the Python mocked them.
use iotroute::route_features::strengthen_project_clearance;
use iotroute::rule_coverage::{
    CheckRequest, Collaborators, Coverage, Disposition, DrilledRequest, HoleRequest, Obstacle,
    ProjectRequest, RouteCoverageTool, RouteScope, Row, Status, check_files,
};
use iotroute::sha256::sha256;
use route_coverage::board::{self, NativeBoard};
use route_coverage::{decimal as dec, hole, project};
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

const LED: &str = "/LED_LINK_K";
const POE: &str = "/POE_V2N";
const NATIVE: &str = r#"(kicad_pcb (version 20260101)
      (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
      (footprint "Fixture:Resistor" (layer "F.Cu") (at 10 10 180) (uuid "R10")
        (property "Reference" "R10") (property "Value" "1k")
        (pad "1" smd rect (at -1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/LED_LINK_K") (uuid "R10-1"))
        (pad "2" smd rect (at 1 0 180) (size 1 1) (layers "F.Cu" "F.Mask") (net "/POE_V2N") (uuid "R10-2"))))"#;
const PTH: &str = r#"(footprint "PTH" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3) (layers "*.Cu") (net "/POE_V2N") (uuid "pth")))"#;
const THROUGH_HOLE: &str = "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'";
const ZONE: &str = r#"(zone (net "/POE_V2N") (net_name "/POE_V2N") (layer "F.Cu") (connect_pads (clearance 0.2)))"#;

fn with_items(items: &str) -> String {
    format!("{}{items})", &NATIVE[..NATIVE.len() - 1])
}

fn rule(kind: &str, value: &str, condition: &str) -> String {
    format!("(version 1)\n(rule \"PoE isolation\" (condition \"{condition}\") (constraint {kind} (min {value})))")
}

fn dsn(clearance: &str, mask: Option<&str>, extra: &str) -> String {
    let circuit = mask.map_or(String::new(), |layers| format!("(circuit (use_layer {layers}))"));
    format!(
        r#"(pcb "coverage-fixture"
      (parser (string_quote ")) (resolution um 10) (unit um)
      (structure (layer "F.Cu" (type signal)) (layer "B.Cu" (type signal))
        (rule (width 200) (clearance {clearance})) {extra})
      (network (net "{LED}" (pins R10-1)) (net "{POE}" (pins J1-10))
        (class "DEFAULT" "{LED}" {circuit} (rule (clearance {clearance})))
        (class "POE" "{POE}" (rule (clearance {clearance})))))"#
    )
}

/// Actual `restrict_dsn` output: non-routing copper is power type, beside the active net's explicit one-layer mask.
fn single_layer_model(clearance: &str) -> String {
    let text = dsn(clearance, Some("F.Cu"), "").replace("(layer \"B.Cu\" (type signal))", "(layer \"B.Cu\" (type power))");
    format!("{} (library) (placement))", &text[..text.len() - 1])
}

fn project(realistic: bool) -> Value {
    let mut rules: BTreeMap<String, Value> = project::REQUIRED.iter().map(|name| (name.to_string(), json!(0))).collect();
    if realistic {
        let values = json!({"min_track_width": 0.15, "min_copper_edge_clearance": 0.5, "min_hole_clearance": 0.25,
            "min_hole_to_hole": 0.25, "min_microvia_diameter": 0.2, "min_microvia_drill": 0.1, "min_through_hole_diameter": 0.2,
            "min_via_annular_width": 0.1, "min_via_diameter": 0.45, "min_resolved_spokes": 2, "min_text_height": 0.8,
            "min_text_thickness": 0.08, "max_error": 0.005, "use_height_for_length_calcs": true});
        rules.extend(values.as_object().unwrap().iter().map(|(key, value)| (key.clone(), value.clone())));
    }
    json!({"board": {"design_settings": {"rules": rules}}, "net_settings": {"classes": [
        {"name": "Default", "clearance": 0.2}, {"name": "POE", "clearance": 0.2}]}})
}

fn with_rule(name: &str, value: Value) -> Value {
    let mut authored = project(true);
    authored["board"]["design_settings"]["rules"][name] = value;
    authored
}

// The API rows of the drilled items. Millimetres in nanometres, as `board-json` writes them.

fn pad(id: &str, kind: &str, net: &str, x: i64, size: i64, drill: i64) -> Value {
    json!({"id": id, "number": if net.is_empty() { "" } else { "1" }, "kind": kind, "shape": "Circle", "net": net, "position": {"x": x, "y": 20_000_000},
        "orientation": 0, "size": {"x": size, "y": size}, "drill": {"x": drill, "y": drill}, "layers": ["F.Cu", "B.Cu"],
        "copper": [{"Circle": {"center": {"x": x, "y": 20_000_000}, "radius": size / 2}}]})
}

fn pth() -> Value {
    pad("pth", "ThroughHole", POE, 20_000_000, 1_000_000, 300_000)
}

fn npth() -> Value {
    pad("npth", "NpThroughHole", "", 22_000_000, 1_000_000, 1_000_000)
}

fn via(id: &str, net: &str, x: i64, size: i64, drill: i64) -> Value {
    json!({"Via": {"id": id, "at": {"x": x, "y": 25_000_000}, "size": size, "drill": drill, "net": net, "via_type": "Through", "layers": ["F.Cu", "B.Cu"]}})
}

fn api(pads: Vec<Value>, vias: Vec<Value>) -> NativeBoard {
    let footprints: Vec<Value> = if pads.is_empty() {
        Vec::new()
    } else {
        vec![json!({"reference": "J2", "layer": "F.Cu", "position": {"x": 20_000_000, "y": 20_000_000}, "orientation": 0, "pads": pads})]
    };
    serde_json::from_value(json!({"copper_layers": ["F.Cu", "B.Cu"], "footprints": footprints, "copper": vias})).unwrap()
}

/// What the collaborators do differently from the real ones. Empty: every call is real.
#[derive(Default)]
struct Hooks<'a> {
    analytic: Option<&'static str>,
    proof: Option<&'a dyn Fn(&hole::DrilledRequest) -> Value>,
    after_project: Option<&'a dyn Fn()>,
    capability: Option<Result<Value, String>>,
    validated: RefCell<Vec<(Value, PathBuf, PathBuf, Vec<String>)>>,
}

struct Native<'a> {
    fixture: &'a Fixture,
    hooks: &'a Hooks<'a>,
    tool: RouteCoverageTool,
}

fn project_request(request: &ProjectRequest) -> project::Request {
    project::Request {
        text: request.text.map(str::to_string),
        source: request.source.display().to_string(),
        dsn_text: request.dsn_text.to_string(),
        active_nets: request.scope.active_nets.to_vec(),
        net_classes: request.scope.net_classes.clone(),
        obstacles: request.scope.obstacles.iter().map(|item| serde_json::to_value(item).unwrap()).collect(),
        holes: request.holes.map(<[Value]>::to_vec),
        holes_preserved: request.holes_preserved,
        immutable_geometry_preserved: request.immutable_geometry_preserved,
        backend_command: request.backend_command.unwrap_or_default().to_vec(),
        thermal: request.thermal.clone(),
        backend_policy: request.backend_policy.cloned().unwrap_or_default(),
        native_thermal_capability: request.native_thermal_capability.cloned().unwrap_or_default(),
        added_vias: request.added_vias.map(<[Value]>::to_vec),
    }
}

fn hole_request(request: &DrilledRequest) -> hole::DrilledRequest {
    hole::DrilledRequest {
        dsn_text: request.dsn_text.to_string(),
        holes: request.holes.to_vec(),
        scope: hole::Scope {
            active_nets: request.active_nets.to_vec(),
            layers: request.layers.to_vec(),
            required_mm: request.required_mm.into(),
            clearance_floor_mm: request.clearance_floor_mm.into(),
        },
        applicability: request.applicability.to_string(),
        backend_command: request.backend_command.unwrap_or_default().to_vec(),
        backend_policy: request.backend_policy.cloned().unwrap_or_default(),
    }
}

impl Collaborators for Native<'_> {
    fn evaluate_project(&self, request: &ProjectRequest) -> Result<Vec<Row>, String> {
        let rows = match self.hooks.proof {
            Some(proof) => serde_json::from_value(json!(project::evaluate_with(&project_request(request), proof))).map_err(|error| error.to_string()),
            None => self.tool.evaluate_project(request),
        };
        if let Some(mutate) = self.hooks.after_project {
            mutate();
        }
        rows
    }

    fn native_pth_pads(&self, base: &Path) -> Result<Vec<Value>, String> {
        board::native_pth_pads(self.fixture.api_of(base))
    }

    fn native_drilled_geometry(&self, path: &Path) -> Result<Vec<Value>, String> {
        board::native_drilled_geometry(self.fixture.api_of(path))
    }

    fn inspect_holes(&self, request: &HoleRequest) -> Result<Value, String> {
        match self.hooks.analytic {
            Some(status) => Ok(json!({"status": status, "cause": "legacy analytic subset"})),
            None => self.tool.inspect_holes(request),
        }
    }

    fn inspect_drilled(&self, request: &DrilledRequest) -> Result<Value, String> {
        match self.hooks.proof {
            Some(proof) => Ok(proof(&hole_request(request))),
            None => self.tool.inspect_drilled(request),
        }
    }

    fn validate_thermal_capability(&self, supplied: &Value, board: &Path, base: &Path, selected_nets: &[String]) -> Result<Value, String> {
        self.hooks.validated.borrow_mut().push((supplied.clone(), board.into(), base.into(), selected_nets.to_vec()));
        self.hooks.capability.clone().expect("a capability test states what validation says")
    }
}

/// One admission: what differs from the single-layer job with its final command.
#[derive(Clone, Copy)]
struct Call<'a> {
    command: Option<&'a [String]>,
    layers: &'a [&'a str],
    gate: bool,
    policy: Option<&'a Value>,
    capability: Option<&'a Value>,
}

struct Fixture {
    root: PathBuf,
    authored: Value,
    command: Vec<String>,
    source_api: NativeBoard,
    base_api: NativeBoard,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

static NEXT: AtomicUsize = AtomicUsize::new(0);

fn write(path: &Path, text: impl AsRef<[u8]>) {
    fs::write(path, text).unwrap();
}

fn name(path: &Path) -> String {
    path.display().to_string()
}

fn hash(path: &Path) -> Option<String> {
    Some(sha256(&fs::read(path).unwrap()))
}

impl Fixture {
    fn new() -> Fixture {
        let root = std::env::temp_dir().join(format!("route-admission-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        let (model, router) = (name(&root.join("board.dsn")), root.join("router"));
        let (routed, report) = (name(&root.join("routed.ses")), name(&root.join("report.json")));
        let command = vec![
            name(&router), "-de".into(), model, "-do".into(), routed, "-mp".into(), "40".into(),
            "--router.min_trace_width_um=150".into(), "--router.copper_to_edge_clearance_um=500".into(), format!("--report={report}"),
            "--diagnose".into(), "--max-time=30".into(), "--router.optimizer.enabled=false".into(),
            "--router.autorouter.max_threads=1".into(), "--router.optimizer.max_threads=1".into(),
        ];
        let mut fixture = Fixture { root, authored: project(true), command, source_api: api(vec![], vec![]), base_api: api(vec![], vec![]) };
        fixture.write_native(NATIVE, api(vec![], vec![]));
        fixture.save_project();
        write(&fixture.model(), single_layer_model("200"));
        write(&router, "attributed backend fixture; never executed");
        write(&fixture.gate(), r#"{"checks": {"drc": true}}"#);
        fixture
    }

    fn api_of(&self, path: &Path) -> &NativeBoard {
        if path == self.board() { &self.source_api } else { &self.base_api }
    }

    fn board(&self) -> PathBuf {
        self.root.join("source.kicad_pcb")
    }

    fn base(&self) -> PathBuf {
        self.root.join("base.kicad_pcb")
    }

    fn project(&self) -> PathBuf {
        self.board().with_extension("kicad_pro")
    }

    fn base_project(&self) -> PathBuf {
        self.base().with_extension("kicad_pro")
    }

    fn rules(&self) -> PathBuf {
        self.board().with_extension("kicad_dru")
    }

    fn base_rules(&self) -> PathBuf {
        self.base().with_extension("kicad_dru")
    }

    fn model(&self) -> PathBuf {
        self.root.join("board.dsn")
    }

    fn gate(&self) -> PathBuf {
        self.root.join("gate.json")
    }

    fn router(&self) -> PathBuf {
        self.root.join("router")
    }

    fn write_project(&self, text: &str) {
        write(&self.project(), text);
        write(&self.base_project(), text);
    }

    fn save_project(&self) {
        self.write_project(&self.authored.to_string());
    }

    fn set_project(&mut self, authored: Value) {
        self.authored = authored;
        self.save_project();
    }

    fn rules_mut(&mut self) -> &mut Value {
        &mut self.authored["board"]["design_settings"]["rules"]
    }

    fn write_rules(&self, text: &str) {
        write(&self.rules(), text);
        write(&self.base_rules(), text);
    }

    fn write_native(&mut self, text: &str, drilled: NativeBoard) {
        write(&self.board(), text);
        write(&self.base(), text);
        self.source_api = drilled.clone();
        self.base_api = drilled;
    }

    fn write_base(&mut self, text: &str, drilled: NativeBoard) {
        write(&self.base(), text);
        self.base_api = drilled;
    }

    fn call(&self) -> Call<'_> {
        Call { command: Some(&self.command), layers: &["F.Cu"], gate: true, policy: None, capability: None }
    }

    fn admit(&self, call: Call, hooks: &Hooks) -> Coverage {
        let (active, classes, obstacles) = (vec![LED.to_string()], classes(), obstacles());
        let layers: Vec<String> = call.layers.iter().map(|layer| layer.to_string()).collect();
        let scope = RouteScope { active_nets: &active, net_classes: &classes, obstacles: &obstacles, layers: &layers };
        let (board, base, dsn, gate) = (self.board(), self.base(), self.model(), self.gate());
        let request = CheckRequest {
            board: &board,
            base: &base,
            dsn: &dsn,
            scope,
            gate: call.gate.then_some(gate.as_path()),
            backend_command: call.command,
            backend_policy: call.policy,
            native_thermal_capability: call.capability,
        };
        let tool = RouteCoverageTool { binary: env!("CARGO_BIN_EXE_route-coverage").into() };
        check_files(&request, &Native { fixture: self, hooks, tool }).unwrap()
    }

    fn check(&self) -> Coverage {
        self.admit(self.call(), &Hooks::default())
    }

    fn check_hooked(&self, hooks: &Hooks) -> Coverage {
        self.admit(self.call(), hooks)
    }

    /// KiCad 10 specctra export: "Via[top-bottom]_<DSN diameter>:<drill um>_um".
    fn via_check(&mut self, stack: &str, drill: f64) -> Coverage {
        let padstack = format!("Via[0-1]_{stack}_um");
        let size = stack.split(':').next().unwrap();
        let text = dsn("200", None, &format!("(via \"{padstack}\")"));
        let library = format!("(library (padstack \"{padstack}\" (shape (circle F.Cu {size})) (shape (circle B.Cu {size})) (attach off)))");
        write(&self.model(), format!("{} {library} (placement))", &text[..text.len() - 1]));
        for class in self.authored["net_settings"]["classes"].as_array_mut().unwrap() {
            class["via_diameter"] = json!(0.6);
            class["via_drill"] = json!(drill);
        }
        self.save_project();
        self.admit(Call { layers: &["F.Cu", "B.Cu"], ..self.call() }, &Hooks::default())
    }
}

fn classes() -> BTreeMap<String, String> {
    BTreeMap::from([(LED.to_string(), "Default".to_string()), (POE.to_string(), "POE".to_string())])
}

fn obstacles() -> Vec<Obstacle> {
    vec![
        Obstacle { net_name: POE.to_string(), kind: "Pad".to_string(), pad_type: Some("Through-hole".to_string()) },
        Obstacle { net_name: POE.to_string(), kind: "Track".to_string(), pad_type: Some(String::new()) },
    ]
}

fn row<'a>(result: &'a Coverage, constraint: &str) -> &'a Row {
    result.requirements.iter().find(|row| row.rule == "native project" && row.constraint == constraint).unwrap_or_else(|| panic!("no row {constraint}: {result:?}"))
}

fn custom(result: &Coverage) -> &Row {
    result.requirements.iter().find(|row| row.rule == "PoE isolation").unwrap()
}

fn same(text: Option<&String>, wanted: &str) -> bool {
    dec::decimal(text.unwrap()).unwrap() == dec::decimal(wanted).unwrap()
}

fn assert_blocked(result: &Coverage) {
    assert_eq!(result.status, Status::Blocked, "{result:?}");
    assert!(!result.solver_launch_allowed, "{result:?}");
}

fn assert_passed(result: &Coverage) {
    assert_eq!(result.status, Status::Passed, "{result:?}");
    assert!(result.solver_launch_allowed, "{result:?}");
}

fn assert_unsupported(result: &Coverage, constraint: &str) {
    assert_blocked(result);
    assert_eq!(row(result, constraint).disposition, Disposition::Unsupported, "{result:?}");
}

fn reason<'a>(result: &'a Coverage, constraint: &str) -> &'a str {
    row(result, constraint).reason.as_deref().unwrap_or("")
}

#[test]
fn actual_project_minima_without_dru_are_bound_to_model_and_final_argv() {
    let fixture = Fixture::new();
    let result = fixture.check();
    assert_passed(&result);
    let files = result.files.as_ref().unwrap();
    assert_eq!(files.inputs[&name(&fixture.rules())], None);
    assert_eq!(files.backend_command.as_ref(), Some(&fixture.command));
    assert_eq!(files.backend_command_sha256, Some(sha256(serde_json::to_string(&fixture.command).unwrap().as_bytes())));
    assert_eq!(files.inputs[&name(&fixture.router())], hash(&fixture.router()));
    for (key, expected) in [("min_track_width", "0.15"), ("min_copper_edge_clearance", "0.5")] {
        let item = row(&result, key);
        assert_eq!(item.disposition, Disposition::Covered);
        assert!(same(item.required_mm.as_ref(), expected) && same(item.model_floor_mm.as_ref(), expected), "{item:?}");
        let pointer = format!("/board/design_settings/rules/{key}");
        assert_eq!(item.source, Some(json!({"path": name(&fixture.project()), "pointer": pointer, "exists": true})));
    }
    assert_eq!(row(&result, "min_resolved_spokes").disposition, Disposition::NotApplicable);
}

#[test]
fn missing_malformed_unresolved_and_untyped_project_rules_fail_closed() {
    let mut fixture = Fixture::new();
    let bad = |value: Value| with_rule("min_track_width", value).to_string();
    let unquoted = |number: &str| bad(json!("HERE")).replace("\"HERE\"", number);
    let mut missing = project(true);
    missing["board"]["design_settings"]["rules"].as_object_mut().unwrap().remove("min_hole_clearance");
    let documents = [
        "{}".to_string(), "[]".to_string(), "{".to_string(), r#"{"board":{},"board":{}}"#.to_string(),
        bad(json!(true)), bad(json!("0.15")), bad(json!(-0.15)), unquoted("NaN"), unquoted("Infinity"), missing.to_string(),
    ];
    for text in &documents {
        fixture.write_project(text);
        assert_blocked(&fixture.check());
    }
    fixture.set_project(project(true));
    fs::remove_file(fixture.project()).unwrap();
    fs::remove_file(fixture.base_project()).unwrap();
    let result = fixture.check();
    assert_blocked(&result);
    assert_eq!(result.files.as_ref().unwrap().inputs[&name(&fixture.project())], None);
    assert!(reason(&result, "project_document").contains("missing"), "{result:?}");
}

#[test]
fn unknown_project_keys_and_positive_unproved_constraints_do_not_disappear() {
    let mut fixture = Fixture::new();
    for (key, value) in [("future_constraint", json!(0)), ("min_connection", json!(0.1)), ("solder_mask_to_copper_clearance", json!(0.1)), ("min_resolved_spokes", json!(2.5))] {
        fixture.set_project(with_rule(key, value));
        assert_unsupported(&fixture.check(), key);
    }
}

#[test]
fn project_clearance_and_only_relevant_netclasses_compare_actual_dsn() {
    let mut fixture = Fixture::new();
    fixture.authored["net_settings"]["classes"].as_array_mut().unwrap().push(json!({"name": "unused", "clearance": 100}));
    fixture.save_project();
    assert_eq!(fixture.check().status, Status::Passed);
    for scope in ["global", "active", "retained"] {
        fixture.authored = project(true);
        match scope {
            "global" => *fixture.rules_mut().get_mut("min_clearance").unwrap() = json!(0.25),
            "active" => fixture.authored["net_settings"]["classes"][0]["clearance"] = json!(0.25),
            _ => fixture.authored["net_settings"]["classes"][1]["clearance"] = json!(0.25),
        }
        fixture.save_project();
        let result = fixture.check();
        assert_blocked(&result);
        assert!(result.requirements.iter().any(|row| row.disposition == Disposition::WeakerThanNative && row.required_mm.as_ref().is_some_and(|mm| same(Some(mm), ".25"))), "{result:?}");
    }
    write(&fixture.model(), single_layer_model("250"));
    assert_eq!(fixture.check().status, Status::Passed);
    fixture.authored["net_settings"]["classes"].as_array_mut().unwrap().pop();
    fixture.save_project();
    assert_blocked(&fixture.check());
}

#[test]
fn width_edge_missing_weaker_duplicated_unknown_and_neck_overrides_block() {
    let fixture = Fixture::new();
    let command = &fixture.command;
    let plus = |extra: &[&str]| [command.as_slice(), &extra.iter().map(|item| item.to_string()).collect::<Vec<_>>()].concat();
    let swapped = |from: &str, to: &str| command.iter().map(|item| item.replace(from, to)).collect::<Vec<_>>();
    let mut unknown = command.clone();
    *unknown.last_mut().unwrap() = "--config=unknown.json".to_string();
    let changes = [
        Vec::new(),
        unknown,
        command.iter().filter(|item| !item.starts_with("--router.min_trace_width_um=")).cloned().collect(),
        swapped("width_um=150", "width_um=149"),
        swapped("clearance_um=500", "clearance_um=499"),
        plus(&["--router.min_trace_width_um=151"]),
        plus(&["--router.copper_to_edge_clearance_um=501"]),
        plus(&["--router.neck_width_um=149"]),
        plus(&["--router.neck_width_um=150", "--router.neck_width_um=150"]),
        swapped("width_um=150", "width_um=nan"),
        swapped(&name(&fixture.model()), &name(&fixture.root.join("other.dsn"))),
    ];
    let mut cases: Vec<Option<&[String]>> = vec![None];
    cases.extend(changes.iter().map(|change| Some(change.as_slice())));
    for case in cases {
        let result = fixture.admit(Call { command: case, ..fixture.call() }, &Hooks::default());
        assert_blocked(&result);
        serde_json::to_string(&result).unwrap();
    }
    let neck = plus(&["--router.neck_width_um=150"]);
    assert_passed(&fixture.admit(Call { command: Some(&neck), ..fixture.call() }, &Hooks::default()));
}

#[test]
fn absent_dru_does_not_skip_native_slotted_pth_hole_requirement() {
    let mut fixture = Fixture::new();
    let slot = r#"(footprint "USB" (layer "F.Cu") (at 20 20 180)
          (property "Reference" "J2")
          (pad "7" thru_hole oval (at -4.32 -1.78 180) (size 1.1 1.9)
            (drill oval 0.599998 1.299997) (layers "*.Cu" "*.Mask") (net "/POE_V2N") (uuid "usb-slot")))"#;
    let mut pad = pad("usb-slot", "ThroughHole", POE, 20_000_000, 1_100_000, 599_998);
    pad["shape"] = "Oval".into();
    pad["size"] = json!({"x": 1_100_000, "y": 1_900_000});
    pad["drill"] = json!({"x": 599_998, "y": 1_299_997});
    pad["copper"] = json!([{"Segment": {"a": {"x": 20_000_000, "y": 19_600_000}, "b": {"x": 20_000_000, "y": 20_400_000}, "width": 1_100_000}}]);
    fixture.write_native(&with_items(slot), api(vec![pad], vec![]));
    let result = fixture.check();
    assert_unsupported(&result, "min_hole_clearance");
    let item = row(&result, "min_hole_clearance");
    assert!(same(item.required_mm.as_ref(), ".25"));
    assert_eq!(item.hole_geometry.as_ref().unwrap()[0]["proof"]["status"], "blocked");
    assert!(item.reason.as_deref().unwrap().contains("DSN"), "{item:?}");
}

#[test]
fn all_drilled_pads_npth_and_retained_vias_reach_the_project_proof() {
    let mut fixture = Fixture::new();
    let items = r#"(footprint "Holes" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3) (layers "*.Cu") (net "/POE_V2N") (uuid "pth"))
          (pad "" np_thru_hole circle (at 2 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "npth")))
          (via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/POE_V2N") (uuid "via"))"#;
    fixture.write_native(&with_items(items), api(vec![pth(), npth()], vec![via("via", POE, 25_000_000, 600_000, 300_000)]));
    let calls = RefCell::new(Vec::new());
    let proof = |request: &hole::DrilledRequest| {
        calls.borrow_mut().push(request.clone());
        json!({"status": "covered"})
    };
    assert_passed(&fixture.check_hooked(&Hooks { proof: Some(&proof), ..Hooks::default() }));
    let calls = calls.borrow();
    let [call] = calls.as_slice() else { panic!("one proof wanted, got {}", calls.len()) };
    let kinds: BTreeSet<&str> = call.holes.iter().map(|hole| hole["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, BTreeSet::from(["npth", "pth", "via"]));
    assert_eq!(call.holes.len(), 3);
    assert_eq!(call.scope.active_nets, [LED]);
    assert_eq!(dec::value(&call.scope.required_mm).unwrap(), dec::decimal(".25").unwrap());
}

#[test]
fn same_net_holes_are_excluded_only_from_the_same_net_clearance_scope() {
    let mut fixture = Fixture::new();
    let text = r#"(via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/LED_LINK_K") (uuid "own-via"))"#;
    fixture.write_native(&with_items(text), api(vec![], vec![via("own-via", LED, 25_000_000, 600_000, 300_000)]));
    let calls = RefCell::new(Vec::new());
    let proof = |request: &hole::DrilledRequest| {
        calls.borrow_mut().push(request.clone());
        json!({"status": "covered", "native_not_applicable": [{"identity": "own-via"}]})
    };
    let result = fixture.check_hooked(&Hooks { proof: Some(&proof), ..Hooks::default() });
    assert_passed(&result);
    assert_eq!(row(&result, "min_hole_clearance").disposition, Disposition::Covered);
    let calls = calls.borrow();
    assert_eq!(calls[0].holes.len(), 1);
    assert_eq!(calls[0].holes[0]["identity"], "own-via");
    assert_eq!(calls[0].applicability, "kicad10_project_track");
}

#[test]
fn new_vias_or_changed_drills_do_not_get_immutable_dimension_credit() {
    let mut fixture = Fixture::new();
    write(&fixture.model(), dsn("200", None, ""));
    let result = fixture.admit(Call { layers: &["F.Cu", "B.Cu"], ..fixture.call() }, &Hooks::default());
    // No via padstack library in the actual DSN: the via dimensions are unknown.
    assert_unsupported(&result, "min_via_diameter");
    assert!(reason(&result, "min_via_diameter").contains("DSN library"), "{result:?}");
    assert_eq!(row(&result, "min_hole_to_hole").disposition, Disposition::NativePostcondition);
    write(&fixture.model(), single_layer_model("200"));
    let text = with_items(r#"(via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/LED_LINK_K") (uuid "via"))"#);
    fixture.write_native(&text, api(vec![], vec![via("via", LED, 25_000_000, 600_000, 300_000)]));
    fixture.write_base(&text.replace("(drill 0.3)", "(drill 0.31)"), api(vec![], vec![via("via", LED, 25_000_000, 600_000, 310_000)]));
    let result = fixture.check();
    assert_blocked(&result);
    assert!(!result.files.unwrap().drilled_geometry_preserved);
}

#[test]
fn new_via_padstacks_meeting_minima_are_covered_and_hole_rules_stay_native() {
    let result = Fixture::new().via_check("600:300", 0.3);
    assert_eq!(result.status, Status::PendingNative, "{result:?}");
    assert!(result.solver_launch_allowed);
    for key in ["min_via_diameter", "min_through_hole_diameter", "min_via_annular_width"] {
        assert_eq!(row(&result, key).disposition, Disposition::Covered, "{key}");
    }
    let witness = row(&result, "min_via_diameter").extra["via_padstacks"].as_array().unwrap();
    assert!(witness.contains(&json!({"source": "dsn padstack Via[0-1]_600:300_um", "diameter_mm": "0.6", "drill_mm": "0.3", "annular_mm": "0.15", "through": true})), "{witness:?}");
    for key in ["min_microvia_diameter", "min_microvia_drill"] {
        assert_eq!(row(&result, key).disposition, Disposition::NotApplicable, "{key}");
    }
    for key in ["min_text_height", "min_text_thickness"] {
        assert_eq!(row(&result, key).disposition, Disposition::ImmutableUnchanged, "{key}");
    }
    for (key, types) in [("min_hole_to_hole", json!(["hole_to_hole", "holes_co_located"])), ("min_hole_clearance", json!(["hole_clearance"]))] {
        let item = row(&result, key);
        assert_eq!(item.disposition, Disposition::NativePostcondition, "{key}");
        let obligation = json!({"constraint": key, "required_mm": item.required_mm, "enforcement": "native-drc", "drc_types": types});
        assert_eq!(item.native_obligation.as_ref(), Some(&obligation));
        assert!(result.native_postconditions.as_ref().unwrap().contains(&obligation));
    }
}

#[test]
fn new_via_padstack_below_a_project_minimum_blocks_with_its_cause() {
    let cases = [
        ("400:200", 0.3, "min_via_diameter", "Via[0-1]_400:200_um"),
        ("500:150", 0.3, "min_through_hole_diameter", "Via[0-1]_500:150_um"),
        ("500:320", 0.3, "min_via_annular_width", "Via[0-1]_500:320_um"),
        ("600:300", 0.1, "min_through_hole_diameter", "netclass Default"),
    ];
    for (stack, drill, key, cause) in cases {
        let result = Fixture::new().via_check(stack, drill);
        assert_blocked(&result);
        assert_eq!(row(&result, key).disposition, Disposition::WeakerThanNative, "{stack}");
        assert!(reason(&result, key).contains(cause), "{result:?}");
    }
}

#[test]
fn job_added_base_vias_are_measured_but_a_changed_source_hole_still_blocks() {
    // fastroute_job places plane vias on the base before routing; they are fixed router input.
    let text = |size: &str| with_items(&format!(r#"(via (at 25 25) (size {size}) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/POE_V2N") (uuid "plane-via"))"#));
    let plane = |size: i64| api(vec![], vec![via("plane-via", POE, 25_000_000, size, 300_000)]);
    let mut fixture = Fixture::new();
    fixture.write_base(&text("0.6"), plane(600_000));
    let result = fixture.via_check("600:300", 0.3);
    assert_eq!(result.status, Status::PendingNative, "{result:?}");
    assert!(!result.files.as_ref().unwrap().drilled_geometry_preserved);
    let sources = row(&result, "min_via_diameter").extra["via_padstacks"].as_array().unwrap();
    assert!(sources.iter().any(|via| via["source"] == "base via plane-via"), "{sources:?}");
    fixture.write_base(&text("0.48"), plane(480_000));
    let result = fixture.via_check("600:300", 0.3);
    assert_blocked(&result);
    assert!(reason(&result, "min_via_annular_width").contains("base via plane-via"), "{result:?}");
    fixture.write_native(&text("0.6"), plane(600_000));
    fixture.write_base(NATIVE, api(vec![], vec![]));
    assert_unsupported(&fixture.via_check("600:300", 0.3), "min_via_diameter");
}

#[test]
fn unknown_or_absent_rule_still_blocks_when_new_vias_are_possible() {
    let mut fixture = Fixture::new();
    fixture.rules_mut()["min_new_feature"] = json!(1);
    assert_unsupported(&fixture.via_check("600:300", 0.3), "min_new_feature");
    let rules = fixture.rules_mut().as_object_mut().unwrap();
    rules.remove("min_new_feature");
    rules.remove("min_via_diameter");
    assert_unsupported(&fixture.via_check("600:300", 0.3), "min_via_diameter");
}

#[test]
fn positive_spoke_requirement_is_not_covered_by_identical_authored_zone() {
    let mut fixture = Fixture::new();
    fixture.write_native(&with_items(ZONE), api(vec![], vec![]));
    let result = fixture.check();
    assert_unsupported(&result, "min_resolved_spokes");
    assert_eq!(row(&result, "min_resolved_spokes").extra["required_count"], "2");
    assert!(result.files.unwrap().fixed_geometry_preserved);
}

#[test]
fn verified_native_capability_leaves_only_a_pending_thermal_obligation() {
    let mut fixture = Fixture::new();
    fixture.write_native(&with_items(ZONE), api(vec![], vec![]));
    let digest = "c".repeat(64);
    let capability = json!({"schema": "iot-lab.native-thermal-capability.v1", "status": "pending_native", "required_count": 2,
        "content_sha256": digest, "inputs": {name(&fixture.rules()): null}});
    let hooks = Hooks { capability: Some(Ok(capability.clone())), ..Hooks::default() };
    let result = fixture.admit(Call { capability: Some(&capability), ..fixture.call() }, &hooks);
    assert_eq!(*hooks.validated.borrow(), [(capability, fixture.board(), fixture.base(), vec![LED.to_string()])]);
    assert_eq!(result.status, Status::PendingNative, "{result:?}");
    assert!(result.solver_launch_allowed);
    assert_eq!(row(&result, "min_resolved_spokes").disposition, Disposition::NativePostcondition);
    assert_eq!(result.native_postconditions, Some(vec![json!({"constraint": "min_resolved_spokes", "required_count": "2", "capability_sha256": digest})]));
    let files = result.files.unwrap();
    assert_eq!(files.model_status, "partial");
    assert_eq!(files.inputs[&name(&fixture.rules())], None);
}

#[test]
fn native_capability_cannot_cover_a_different_count_or_unrelated_requirement() {
    let mut fixture = Fixture::new();
    fixture.write_native(&with_items(ZONE), api(vec![], vec![]));
    for (count, connection) in [(1, json!(0)), (2, json!(0.1))] {
        fixture.rules_mut()["min_connection"] = connection;
        fixture.save_project();
        let capability = json!({"schema": "iot-lab.native-thermal-capability.v1", "status": "pending_native", "required_count": count, "content_sha256": "c".repeat(64), "inputs": {}});
        let hooks = Hooks { capability: Some(Ok(capability.clone())), ..Hooks::default() };
        assert_blocked(&fixture.admit(Call { capability: Some(&capability), ..fixture.call() }, &hooks));
    }
}

#[test]
fn invalid_native_capability_blocks_even_when_thermal_requirement_is_inactive() {
    let fixture = Fixture::new();
    let hooks = Hooks { capability: Some(Err("missing native input evidence".to_string())), ..Hooks::default() };
    let result = fixture.admit(Call { capability: Some(&json!({})), ..fixture.call() }, &hooks);
    assert_blocked(&result);
    assert!(result.cause.contains("missing native input evidence"), "{}", result.cause);
}

#[test]
fn all_solid_thermal_inapplicability_includes_overrides_and_missing_threshold() {
    let mut fixture = Fixture::new();
    let solid = with_items(r#"(zone (net "/POE_V2N") (net_name "/POE_V2N") (layer "F.Cu") (connect_pads yes (clearance 0.2)))"#);
    let overridden = |form: &str| solid.replace("(property \"Reference\" \"R10\")", &format!("(property \"Reference\" \"R10\") {form}"));
    for form in ["", "(zone_connect 2)", "(zone_connect -1)", "(zone_connect 0)"] {
        fixture.write_native(&overridden(form), api(vec![], vec![]));
        let result = fixture.check();
        assert_passed(&result);
        let item = row(&result, "min_resolved_spokes");
        assert_eq!(item.disposition, Disposition::NotApplicable);
        assert_eq!(item.extra["thermal_applicability"]["thermal_connections_possible"], false);
    }
    fixture.rules_mut().as_object_mut().unwrap().remove("min_resolved_spokes");
    fixture.save_project();
    let result = fixture.check();
    assert_passed(&result);
    let item = row(&result, "min_resolved_spokes");
    assert_eq!(item.source.as_ref().unwrap()["exists"], false);
    assert!(!item.extra.contains_key("required_count"));
    for form in ["(zone_connect 1)", "(zone_connect 3)", "(zone_connect 9)"] {
        fixture.write_native(&overridden(form), api(vec![], vec![]));
        assert_unsupported(&fixture.check(), "min_resolved_spokes");
    }
    fixture.write_native(&solid, api(vec![], vec![]));
    fixture.write_rules("(version 1) (rule \"thermal pads\" (condition \"A.Type == 'Pad'\") (constraint zone_connection thermal_reliefs))");
    assert_unsupported(&fixture.check(), "min_resolved_spokes");
}

#[test]
fn base_project_fixed_geometry_and_command_races_are_bound() {
    let mut fixture = Fixture::new();
    write(&fixture.base_project(), "{}");
    assert_unsupported(&fixture.check(), "project_source");
    fixture.save_project();
    write(&fixture.base_rules(), "(version 1) (rule \"unexpected base policy\" (constraint clearance (min 1mm)))");
    let result = fixture.check();
    assert_blocked(&result);
    assert!(result.requirements.iter().any(|row| row.constraint == "rule_source"), "{result:?}");
    fs::remove_file(fixture.base_rules()).unwrap();
    fixture.write_base(&with_items("(gr_text \"changed\" (at 0 0) (layer \"F.SilkS\"))"), api(vec![], vec![]));
    let result = fixture.check();
    assert_blocked(&result);
    assert!(!result.files.unwrap().fixed_geometry_preserved);
    fixture.write_native(NATIVE, api(vec![], vec![]));
    for path in [fixture.project(), fixture.base_project(), fixture.router()] {
        let before = fs::read(&path).unwrap();
        let mutate = || write(&path, [before.as_slice(), b"\n"].concat());
        let result = fixture.check_hooked(&Hooks { after_project: Some(&mutate), ..Hooks::default() });
        assert_blocked(&result);
        assert!(result.cause.contains("changed during admission"), "{}", result.cause);
        write(&path, &before);
    }
    let appear = || write(&fixture.rules(), "(version 1)");
    let result = fixture.check_hooked(&Hooks { after_project: Some(&appear), ..Hooks::default() });
    assert_blocked(&result);
    assert!(result.cause.contains("changed during admission"), "{}", result.cause);
}

#[test]
fn backend_profile_proof_is_passed_bound_and_rechecked_without_inventing_one() {
    let fixture = Fixture::new();
    let evidence = fixture.root.join("native-backend-evidence.json");
    write(&evidence, "{\"source\":\"fixture\"}");
    let (key, expected) = (name(&evidence), hash(&evidence));
    let policy = json!({"mode": "quality-first", "manifest": "fixture-only-not-a-real-profile"});
    let proof = |request: &hole::DrilledRequest| {
        assert_eq!(request.backend_policy, policy);
        assert_eq!(request.backend_command, fixture.command);
        json!({"status": "covered", "inputs": {key.clone(): expected}})
    };
    let call = Call { policy: Some(&policy), ..fixture.call() };
    let result = fixture.admit(call, &Hooks { proof: Some(&proof), ..Hooks::default() });
    assert_passed(&result);
    let files = result.files.as_ref().unwrap();
    assert_eq!(files.backend_policy.as_ref(), Some(&policy));
    assert_eq!(files.inputs[&key], expected);
    let changed = |request: &hole::DrilledRequest| {
        let result = proof(request);
        write(&evidence, "{\"source\":\"changed\"}");
        result
    };
    let result = fixture.admit(call, &Hooks { proof: Some(&changed), ..Hooks::default() });
    assert_blocked(&result);
    assert!(result.cause.contains("changed during admission"), "{}", result.cause);
}

#[test]
fn custom_hole_limit_cannot_bypass_actual_backend_proof_with_zero_project_minimum() {
    let mut fixture = Fixture::new();
    fixture.rules_mut()["min_hole_clearance"] = json!(0);
    fixture.save_project();
    fixture.write_native(&with_items(PTH), api(vec![pth()], vec![]));
    fixture.write_rules(&rule("hole_clearance", "0.4mm", THROUGH_HOLE));
    let evidence = fixture.root.join("actual-backend-proof.json");
    write(&evidence, "{}");
    let (key, digest) = (name(&evidence), hash(&evidence));
    let policy = json!({"mode": "fixture-only-boundary"});
    let call = Call { policy: Some(&policy), ..fixture.call() };
    let rejected = fixture.admit(call, &Hooks { analytic: Some("covered"), ..Hooks::default() });
    assert_blocked(&rejected);
    let item = custom(&rejected);
    assert_eq!(item.disposition, Disposition::Unsupported);
    assert!(same(item.required_mm.as_ref(), ".4"));
    assert_eq!(item.analytical_hole_geometry.as_ref().unwrap()["status"], "covered");
    let calls = RefCell::new(Vec::new());
    let proof = |request: &hole::DrilledRequest| {
        calls.borrow_mut().push(request.clone());
        json!({"status": "covered", "inputs": {key.clone(): digest}})
    };
    let admitted = fixture.admit(call, &Hooks { analytic: Some("covered"), proof: Some(&proof), ..Hooks::default() });
    assert_passed(&admitted);
    assert_eq!(admitted.files.as_ref().unwrap().inputs[&key], digest);
    let calls = calls.borrow();
    let [actual] = calls.as_slice() else { panic!("one proof wanted, got {}", calls.len()) };
    assert_eq!(actual.scope.required_mm, "0.4");
    assert_eq!(actual.backend_policy, policy);
    assert_eq!(actual.backend_command, fixture.command);
    assert_eq!(actual.holes.len(), 1);
    assert_eq!(actual.applicability, "custom_pth_track");
}

#[test]
fn joint_custom_and_project_hole_proofs_keep_the_full_inventory_and_separate_minima() {
    let mut fixture = Fixture::new();
    let mixed = r#"(footprint "PTH" (layer "F.Cu") (at 20 20)
          (property "Reference" "J2")
          (pad "1" thru_hole circle (at 0 0) (size 1 1) (drill 0.3) (layers "*.Cu") (net "/POE_V2N") (uuid "pth"))
          (pad "" np_thru_hole circle (at 2 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "npth")))
          (via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/LED_LINK_K") (uuid "kept-via"))"#;
    fixture.write_native(&with_items(mixed), api(vec![pth(), npth()], vec![via("kept-via", LED, 25_000_000, 600_000, 300_000)]));
    fixture.write_rules(&rule("hole_clearance", "0.28mm", THROUGH_HOLE));
    for project_fails in [false, true] {
        let calls = Cell::new(0);
        let proof = |request: &hole::DrilledRequest| {
            calls.set(calls.get() + 1);
            let identities: BTreeSet<&str> = request.holes.iter().map(|hole| hole["identity"].as_str().unwrap()).collect();
            let kinds: BTreeSet<&str> = request.holes.iter().map(|hole| hole["kind"].as_str().unwrap()).collect();
            assert_eq!(identities, BTreeSet::from(["kept-via", "npth", "pth"]));
            assert_eq!(kinds, BTreeSet::from(["npth", "pth", "via"]));
            let required = dec::value(&request.scope.required_mm).unwrap();
            if request.applicability == "custom_pth_track" {
                assert_eq!(required, dec::decimal(".28").unwrap());
                return json!({"status": "covered", "cause": "fixture PTH scope with every physical instance bound"});
            }
            assert_eq!(request.applicability, "kicad10_project_track");
            assert_eq!(required, dec::decimal(".25").unwrap());
            json!({"status": if project_fails { "blocked" } else { "covered" }, "cause": "fixture all-hole project proof"})
        };
        let result = fixture.check_hooked(&Hooks { analytic: Some("covered"), proof: Some(&proof), ..Hooks::default() });
        assert_eq!(calls.get(), 2);
        assert_eq!(result.status, if project_fails { Status::Blocked } else { Status::Passed }, "{result:?}");
        assert_eq!(result.solver_launch_allowed, !project_fails);
        assert_eq!(custom(&result).disposition, Disposition::Covered);
        assert_eq!(row(&result, "min_hole_clearance").disposition, if project_fails { Disposition::Unsupported } else { Disposition::Covered });
    }
}

#[test]
fn joint_hole_proofs_block_missing_or_changed_retained_vias_before_distance_proof() {
    let mut fixture = Fixture::new();
    let kept = r#"(via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "/LED_LINK_K") (uuid "kept-via"))"#;
    let text = with_items(&format!("{PTH}{kept}"));
    fixture.write_native(&text, api(vec![pth()], vec![via("kept-via", LED, 25_000_000, 600_000, 300_000)]));
    fixture.write_rules(&rule("hole_clearance", "0.28mm", THROUGH_HOLE));
    let cases = [
        (text.replace(kept, ""), api(vec![pth()], vec![])),
        (text.replace("(at 25 25)", "(at 25.1 25)"), api(vec![pth()], vec![via("kept-via", LED, 25_100_000, 600_000, 300_000)])),
    ];
    for (changed, drilled) in cases {
        fixture.write_base(&changed, drilled);
        let calls = Cell::new(0);
        let proof = |_: &hole::DrilledRequest| {
            calls.set(calls.get() + 1);
            json!({"status": "covered"})
        };
        let result = fixture.check_hooked(&Hooks { analytic: Some("covered"), proof: Some(&proof), ..Hooks::default() });
        assert_unsupported(&result, "min_hole_clearance");
        assert!(!result.files.as_ref().unwrap().drilled_geometry_preserved);
        assert_eq!(calls.get(), 0);
        assert_eq!(custom(&result).disposition, Disposition::Unsupported);
    }
}

#[test]
fn existing_strict_file_guard_rejects_before_and_accepts_after_model_change() {
    let mut fixture = Fixture::new();
    let mut authored = project(false);
    authored["net_settings"]["classes"][1]["clearance"] = json!(0.3);
    authored["net_settings"]["classes"].as_array_mut().unwrap().push(json!({"name": "UNUSED", "clearance": 99}));
    fixture.set_project(authored);
    fixture.write_rules("(version 1)");
    write(&fixture.model(), dsn("200", None, ""));
    let call = Call { command: None, layers: &["F.Cu", "B.Cu"], gate: false, ..fixture.call() };
    let before = fixture.admit(call, &Hooks::default());
    assert_blocked(&before);
    assert!(before.requirements.iter().any(|row| row.constraint == "netclass_clearance" && row.disposition == Disposition::WeakerThanNative), "{before:?}");
    let sources = [fixture.board(), fixture.base(), fixture.project(), fixture.base_project()];
    let original = sources.clone().map(|path| hash(&path));
    let (active, classes, obstacles, layers) = (vec![LED.to_string()], classes(), obstacles(), vec!["F.Cu".to_string(), "B.Cu".to_string()]);
    let scope = RouteScope { active_nets: &active, net_classes: &classes, obstacles: &obstacles, layers: &layers };
    let (changed, _) = strengthen_project_clearance(&dsn("200", None, ""), &fixture.authored.to_string(), "actual-project.kicad_pro", &scope).unwrap();
    write(&fixture.model(), changed);
    assert_passed(&fixture.admit(call, &Hooks::default()));
    assert_eq!(sources.map(|path| hash(&path)), original);
}
