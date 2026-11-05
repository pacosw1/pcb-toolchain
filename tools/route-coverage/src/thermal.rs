//! Native thermal receipt validation. No native tool is run or board saved here.
use crate::{
    Result,
    board::{self, BoardReader},
    evidence,
};
use iotroute::kicad::sexpr;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
pub const CAPABILITY_SCHEMA: &str = "iot-lab.native-thermal-capability.v1";
pub const DISCHARGE_SCHEMA: &str = "iot-lab.native-thermal-discharge.v1";
/// Compiled validator replaces the former separate Python helper/parser roles. Old capabilities must be regenerated.
pub const IMPLEMENTATION_SCHEMA: &str = "iot-lab.native-thermal-implementation.v2";
const VERSION: &str = "10.0.6";
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().ok_or(format!("missing evidence {key}"))
}
fn p(v: &Value) -> Result<PathBuf> {
    evidence::path(v.as_str().ok_or("missing evidence path")?)
}
fn file_binding(inputs: &mut Value, d: &Value) {
    inputs[d["path"].as_str().unwrap()] = d["sha256"].clone();
}
fn absent_or_hash(path: &Path) -> Result<Value> {
    let s = path.to_str().ok_or("invalid evidence path")?;
    evidence::path(s)?;
    if path.exists() {
        Ok(evidence::hash(path)?.into())
    } else {
        Ok(Value::Null)
    }
}
pub struct Validator<R> {
    reader: R,
    executable: PathBuf,
}
impl<R: BoardReader> Validator<R> {
    pub fn new(reader: R, executable: PathBuf) -> Self {
        Self { reader, executable }
    }
    fn implementation(&self, recorded: Option<&Value>) -> Result<Value> {
        let current = evidence::descriptor(&self.executable)?;
        let Some(recorded) = recorded else {
            return Ok(json!({"schema":IMPLEMENTATION_SCHEMA,"roles":{"validator":current}}));
        };
        if recorded["schema"] != IMPLEMENTATION_SCHEMA
            || recorded.as_object().is_none_or(|o| o.len() != 2)
            || recorded["roles"]
                .as_object()
                .is_none_or(|o| o.len() != 1 || !o.contains_key("validator"))
        {
            return Err("unsupported native thermal implementation roles/version; regenerate historical capability".into());
        }
        let checked = evidence::check_descriptor(&recorded["roles"]["validator"])?;
        if checked != recorded["roles"]["validator"] {
            return Err("native thermal implementation path must be canonical".into());
        }
        if checked["sha256"] != current["sha256"] {
            return Err(
                "consumer native thermal validator implementation differs from producer".into(),
            );
        }
        Ok(recorded.clone())
    }
    fn policy(
        &self,
        source: &Path,
        base: &Path,
        implementation: &Value,
    ) -> Result<(PathBuf, PathBuf, u64, Value)> {
        let source = evidence::path(source.to_str().ok_or("invalid source")?)?;
        let base = evidence::path(base.to_str().ok_or("invalid base")?)?;
        let mut inputs = json!({});
        for path in [&source, &base] {
            file_binding(&mut inputs, &evidence::descriptor(path)?);
        }
        for d in implementation["roles"].as_object().unwrap().values() {
            file_binding(&mut inputs, d);
        }
        let sch = source.with_extension("kicad_sch");
        inputs[sch.to_string_lossy().as_ref()] = absent_or_hash(&sch)?;
        let mut projects = Vec::new();
        let mut rules = Vec::new();
        for board in [&source, &base] {
            let (data, d) = evidence::read(&board.with_extension("kicad_pro"))?;
            file_binding(&mut inputs, &d);
            let settings = &data["board"]["design_settings"];
            let count = settings["rules"]["min_resolved_spokes"]
                .as_u64()
                .filter(|n| *n > 0)
                .ok_or("min_resolved_spokes must be an authored positive integer")?;
            if settings["rule_severities"]["starved_thermal"] != "error" {
                return Err("starved_thermal must explicitly have error severity".into());
            }
            if settings["drc_exclusions"] != json!([]) {
                return Err(
                    "native thermal verification requires explicit empty DRC exclusions".into(),
                );
            }
            projects.push((d["sha256"].clone(), count));
            let dru = board.with_extension("kicad_dru");
            let digest = absent_or_hash(&dru)?;
            inputs[dru.to_string_lossy().as_ref()] = digest.clone();
            rules.push(digest.clone());
            if !digest.is_null() {
                let forms = sexpr::parse(&fs::read_to_string(&dru).map_err(|e| e.to_string())?)?;
                if forms.first().is_none_or(|f| {
                    !f.is("version") || f.items().len() != 2 || f.text(1) != Some("1")
                }) {
                    return Err("native DRU version is unresolved".into());
                }
                for form in forms.iter().skip(1) {
                    if !form.is("rule") || form.items().len() < 3 || form.text(1).is_none() {
                        return Err("unsupported native DRU form".into());
                    }
                    for field in form.items().iter().skip(2) {
                        if !matches!(
                            field.head(),
                            Some("condition" | "constraint" | "layer" | "severity")
                        ) {
                            return Err("unknown native DRU rule field".into());
                        }
                        if field.is("severity") {
                            return Err(
                                "custom rule severity is not proven by this capability".into()
                            );
                        }
                        if field.is("constraint") {
                            let kind = field.text(1).ok_or("malformed custom constraint")?;
                            if kind.to_lowercase().contains("thermal")
                                || matches!(kind, "zone_connection" | "min_resolved_spokes")
                            {
                                return Err("custom thermal/zone constraint is not proven by this capability".into());
                            }
                        }
                    }
                }
            }
        }
        if projects[0] != projects[1] || rules[0] != rules[1] {
            return Err("source/base project or DRU changed".into());
        }
        Ok((source, base, projects[0].1, inputs))
    }
    fn native_evidence(
        &self,
        candidate: &Path,
        fill_path: &Path,
        drc_path: &Path,
        nets: &[String],
        final_check: bool,
    ) -> Result<Value> {
        let (fill, fill_file) = evidence::read(fill_path)?;
        let (drc, drc_file) = evidence::read(drc_path)?;
        let descriptor = evidence::descriptor(candidate)?;
        if fill["schema"] != "iot-lab.native-thermal-fill.v1"
            || drc["schema"] != "iot-lab.native-thermal-drc.v1"
        {
            return Err("unknown native thermal receipt schema".into());
        }
        if evidence::check_descriptor(&fill["candidate"])? != descriptor
            || evidence::check_descriptor(&drc["candidate"])? != descriptor
        {
            return Err("native receipts refer to another candidate".into());
        }
        if fill["fill_result"] != true
            || fill["invocation"] != json!({"operation":"ZONE_FILLER.Fill","saved":true})
            || fill["pcbnew_version"] != VERSION
            || truthy(&fill["cause"])
        {
            return Err(format!(
                "native zone fill must explicitly succeed and save under KiCad {VERSION}"
            ));
        }
        let fill_tool = evidence::check_descriptor(&fill["tool"])?;
        if drc["returncode"].as_i64() != Some(0) || truthy(&drc["cause"]) {
            return Err("independent native DRC did not succeed".into());
        }
        let report_file = evidence::check_descriptor(&drc["report"])?;
        let (tool, parity) = command(&drc, candidate, &report_file)?;
        let (report, read_report) = evidence::read(&p(&report_file["path"])?)?;
        if read_report != report_file
            || report["kicad_version"] != VERSION
            || report["coordinate_units"] != "mm"
        {
            return Err("native DRC runtime/report identity is unsupported".into());
        }
        if report["source"].as_str() != candidate.file_name().and_then(|s| s.to_str())
            && report["source"].as_str() != candidate.to_str()
        {
            return Err("native DRC report names another candidate".into());
        }
        let included = report["included_severities"]
            .as_array()
            .ok_or("native DRC did not include all finding severities/exclusions")?;
        if included.len() != 3
            || included
                .iter()
                .filter_map(Value::as_str)
                .collect::<BTreeSet<_>>()
                != BTreeSet::from(["error", "warning", "exclusion"])
        {
            return Err("native DRC did not include all finding severities/exclusions".into());
        }
        for key in [
            "violations",
            "unconnected_items",
            "schematic_parity",
            "ignored_checks",
        ] {
            if !report[key].is_array() {
                return Err(format!("native DRC report is incomplete: {key}"));
            }
        }
        for ignored in report["ignored_checks"].as_array().unwrap() {
            if string(ignored, "key")?.to_lowercase().contains("thermal") {
                return Err("thermal check was ignored".into());
            }
        }
        if !report["schematic_parity"].as_array().unwrap().is_empty() {
            return Err("native DRC reported schematic parity findings".into());
        }
        for key in ["violations", "unconnected_items", "schematic_parity"] {
            for finding in report[key].as_array().unwrap() {
                let kind = string(finding, "type")?;
                if !matches!(
                    finding["severity"].as_str(),
                    Some("error" | "warning" | "exclusion")
                ) {
                    return Err("malformed native finding".into());
                }
                if kind.to_lowercase().contains("thermal")
                    || finding["severity"] == "exclusion"
                    || truthy(&finding["excluded"])
                {
                    return Err("thermal/excluded native finding is fatal".into());
                }
            }
        }
        let violations = report["violations"].as_array().unwrap();
        if violations.iter().any(|f| f["severity"] == "error") {
            return Err("native DRC reported errors".into());
        }
        let opens = report["unconnected_items"].as_array().unwrap();
        if final_check && !opens.is_empty() {
            return Err("final native thermal discharge requires zero opens".into());
        }
        let native = self.reader.read(candidate)?;
        let mapping = board::uuid_nets(&native)?;
        if !nets.iter().all(|n| mapping.values().any(|v| v == n)) {
            return Err("selected net is absent from the exact native candidate".into());
        }
        let mut bindings = Vec::new();
        for row in opens {
            let items = row["items"]
                .as_array()
                .filter(|a| a.len() == 2)
                .ok_or("unresolved initial native open")?;
            if row["type"] != "unconnected_items" {
                return Err("unresolved initial native open".into());
            }
            let a = string(&items[0], "uuid")?;
            let b = string(&items[1], "uuid")?;
            if a.is_empty() || b.is_empty() {
                return Err("initial open has no native item identity".into());
            }
            let net = mapping
                .get(a)
                .filter(|s| !s.is_empty())
                .ok_or("initial opens are not exclusively on the selected native nets")?;
            if a == b || mapping.get(b) != Some(net) || !nets.contains(net) {
                return Err("initial opens are not exclusively on the selected native nets".into());
            }
            bindings.push(json!({"net":net,"item_uuids":[a,b]}));
        }
        let mut files = json!({});
        for d in [
            &descriptor,
            &fill_file,
            &drc_file,
            &report_file,
            &tool,
            &fill_tool,
        ] {
            file_binding(&mut files, d);
        }
        let inputs = evidence::merge(&[
            &evidence::check_inputs(&fill["inputs"])?,
            &evidence::check_inputs(&drc["inputs"])?,
            &files,
        ])?;
        Ok(
            json!({"candidate":descriptor,"fill_receipt":fill_file,"drc_receipt":drc_file,"native_report":report_file,"fill_tool":fill_tool,"drc_tool":tool,"inputs":inputs,
            "metrics":{"errors":0,"thermal_findings":0,"opens":opens.len(),"warnings":violations.iter().filter(|f|f["severity"]=="warning").count(),"parity_findings":0,"parity_checked":parity},"initial_open_bindings":bindings}),
        )
    }
    pub fn admit(
        &self,
        source: &Path,
        base: &Path,
        enabled: bool,
        nets: &[String],
        fill: &Path,
        drc: &Path,
    ) -> Result<Value> {
        self.admit_impl(source, base, enabled, nets, fill, drc, None)
    }
    fn admit_impl(
        &self,
        source: &Path,
        base: &Path,
        enabled: bool,
        nets: &[String],
        fill: &Path,
        drc: &Path,
        recorded: Option<&Value>,
    ) -> Result<Value> {
        if !enabled {
            return Err("native thermal checkback requires explicit opt-in".into());
        }
        if nets.is_empty()
            || nets.iter().any(String::is_empty)
            || nets.iter().collect::<BTreeSet<_>>().len() != nets.len()
        {
            return Err("exact selected native nets are required".into());
        }
        let mut nets = nets.to_vec();
        nets.sort();
        let implementation = self.implementation(recorded)?;
        let (source, base, count, policy) = self.policy(source, base, &implementation)?;
        let evidence = self.native_evidence(&base, fill, drc, &nets, false)?;
        let inputs = evidence::merge(&[&policy, &evidence["inputs"]])?;
        evidence::check_inputs(&inputs)?;
        let result = evidence::seal(
            json!({"schema":CAPABILITY_SCHEMA,"status":"pending_native","enabled":true,"enforcement":"native-checkback","required_count":count,"selected_nets":nets,
            "source":{"path":source,"sha256":inputs[source.to_string_lossy().as_ref()]},"base":evidence["candidate"],"initial":evidence,"implementation":implementation,"inputs":inputs,"qualified":false,"dsn_covered":false,
            "scope":"project minimum resolved spokes only; final native discharge and full configured gate required"}),
        );
        self.implementation(Some(&implementation))?;
        Ok(result)
    }
    pub fn validate_capability(
        &self,
        capability: &Value,
        source: &Path,
        base: &Path,
        nets: &[String],
        required_count: Option<&Value>,
    ) -> Result<Value> {
        if capability["schema"] != CAPABILITY_SCHEMA {
            return Err("native thermal capability is missing or unsupported".into());
        }
        evidence::unseal(capability)?;
        let implementation = self.implementation(Some(&capability["implementation"]))?;
        let inputs = evidence::check_inputs(&capability["inputs"])?;
        for d in implementation["roles"].as_object().unwrap().values() {
            if inputs[d["path"].as_str().unwrap()] != d["sha256"] {
                return Err(
                    "native thermal implementation role is absent from original inputs".into(),
                );
            }
        }
        let captured = evidence::check_descriptor(&capability["source"])?;
        let captured_path = p(&captured["path"])?;
        if evidence::hash(source)? != captured["sha256"].as_str().unwrap() {
            return Err("caller source differs from immutable thermal source capture".into());
        }
        for ext in ["kicad_pro", "kicad_dru", "kicad_sch"] {
            if absent_or_hash(&captured_path.with_extension(ext))?
                != absent_or_hash(&source.with_extension(ext))?
            {
                return Err("caller native source sidecars differ from immutable capture".into());
            }
        }
        let initial = &capability["initial"];
        let actual = self.admit_impl(
            &captured_path,
            base,
            capability["enabled"] == true,
            nets,
            &p(&initial["fill_receipt"]["path"])?,
            &p(&initial["drc_receipt"]["path"])?,
            Some(&implementation),
        )?;
        if &actual != capability {
            return Err("native thermal capability source, scope or evidence changed".into());
        }
        if required_count.is_some_and(|n| n.as_u64() != actual["required_count"].as_u64()) {
            return Err("native thermal capability does not cover the authored count".into());
        }
        Ok(actual)
    }
    pub fn discharge(
        &self,
        capability: &Value,
        candidate: &Path,
        fill: &Path,
        drc: &Path,
    ) -> Result<Value> {
        let initial = self.validate_capability(
            capability,
            &p(&capability["source"]["path"])?,
            &p(&capability["base"]["path"])?,
            &nets(&capability["selected_nets"])?,
            None,
        )?;
        let candidate = evidence::path(candidate.to_str().ok_or("invalid candidate path")?)?;
        let implementation = self.implementation(Some(&initial["implementation"]))?;
        let (_, _, count, policy) =
            self.policy(&p(&initial["source"]["path"])?, &candidate, &implementation)?;
        if initial["required_count"] != count {
            return Err("final native thermal minimum changed".into());
        }
        let evidence = self.native_evidence(
            &candidate,
            fill,
            drc,
            &nets(&initial["selected_nets"])?,
            true,
        )?;
        for key in ["fill_tool", "drc_tool"] {
            if evidence[key] != initial["initial"][key] {
                return Err("initial/final native thermal runtime tools changed".into());
            }
        }
        let inputs = evidence::merge(&[&initial["inputs"], &policy, &evidence["inputs"]])?;
        evidence::check_inputs(&inputs)?;
        let result = evidence::seal(
            json!({"schema":DISCHARGE_SCHEMA,"status":"passed","enforcement":"native-checkback","required_count":count,"initial_capability_sha256":initial["content_sha256"],"candidate":evidence["candidate"],
            "final":evidence,"inputs":inputs,"qualified":false,"dsn_covered":false,"configured_gate_required":true,"scope":"native project thermal minimum discharged only; protected inputs and full configured gate still required"}),
        );
        self.implementation(Some(&implementation))?;
        Ok(result)
    }
}
pub fn nets(v: &Value) -> Result<Vec<String>> {
    v.as_array()
        .ok_or("exact selected native nets are required")?
        .iter()
        .map(|n| {
            n.as_str()
                .map(str::to_string)
                .ok_or("exact selected native nets are required".into())
        })
        .collect()
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
        Value::Number(n) => n.to_string() != "0",
    }
}
fn command(receipt: &Value, candidate: &Path, report: &Value) -> Result<(Value, bool)> {
    let argv = receipt["command"]
        .as_array()
        .filter(|a| a.len() >= 4)
        .ok_or("native DRC command is missing")?;
    let argv = argv
        .iter()
        .map(|s| {
            s.as_str()
                .filter(|s| !s.is_empty())
                .ok_or("native DRC command is missing")
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let tool = evidence::check_descriptor(&receipt["tool"])?;
    if evidence::path(argv[0])? != p(&tool["path"])? || argv[1..3] != ["pcb", "drc"] {
        return Err("native DRC tool or operation differs".into());
    }
    let mut flags = BTreeMap::new();
    let mut positions = Vec::new();
    let mut i = 3;
    while i < argv.len() {
        let token = argv[i];
        let (key, value) = match token {
            "--severity-all" | "--schematic-parity" => (token, "true"),
            "--format" | "--units" | "-o" | "--output" => {
                i += 1;
                let value = *argv.get(i).ok_or("incomplete native DRC command")?;
                (
                    if matches!(token, "-o" | "--output") {
                        "output"
                    } else {
                        token
                    },
                    value,
                )
            }
            _ if token.starts_with('-') => {
                return Err(format!(
                    "unsupported native DRC option (hidden refill forbidden): {token}"
                ));
            }
            _ => {
                positions.push(token);
                i += 1;
                continue;
            }
        };
        if flags.insert(key, value).is_some() {
            return Err(format!("duplicate native DRC option: {key}"));
        }
        i += 1;
    }
    if flags.get("--severity-all") != Some(&"true")
        || flags.get("--format") != Some(&"json")
        || flags.get("--units") != Some(&"mm")
        || evidence::path(flags.get("output").ok_or("native DRC output missing")?)?
            != p(&report["path"])?
        || positions.len() != 1
        || evidence::path(positions[0])? != candidate
    {
        return Err("native DRC command does not check the exact saved candidate/report".into());
    }
    Ok((tool, flags.contains_key("--schematic-parity")))
}
