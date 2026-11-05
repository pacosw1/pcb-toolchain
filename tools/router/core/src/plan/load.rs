//! Validation of a route.json object. Every error is collected, so one run names all of them.
use super::{Backend, Budget, DEFAULT_BUDGET, Keepout, KeepoutMode, NO_FASTROUTE, Plan, Pour, PourConnection, PourShape, Rect, SCHEMA, Stage, WidthRule};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

const TOP_KEYS: &[&str] = &["schema", "about", "backend", "layers", "budget", "stages", "pours", "widths", "features"];
const BUDGET_KEYS: &[&str] = &["passes", "time_s", "threads"];
const STAGE_KEYS: &[&str] = &[
    "name", "only_nets", "skip_nets", "layers", "plane_nets", "route_planes", "neck_um", "unlock_nets", "via_skip", "remove_zones",
    "keepouts", "require", "passes", "time_s", "threads",
];
const KEEPOUT_KEYS: &[&str] = &["name", "inside", "outside", "layers"];
const REQUIRE_KEYS: &[&str] = &["open", "vias"];
const POUR_KEYS: &[&str] = &[
    "name", "net", "layer", "shape", "grow_mm", "priority", "connection", "minus", "clearance_mm", "thermal_gap_mm", "spoke_mm",
];
const WIDTH_KEYS: &[&str] = &["name", "box", "layers", "width_mm"];

/// Validate a route.json object against the copper layers of the board and, when given, the known route feature names
/// (which a stage would otherwise ignore). The error text names every problem found, joined by "; ".
pub fn load(cfg: &Value, copper: &[String], known_features: Option<&BTreeSet<String>>) -> Result<Plan, String> {
    let mut check = Check { copper, errors: Vec::new() };
    if !check.keys(cfg, TOP_KEYS, "route.json") {
        return Err(check.finish());
    }
    if cfg["schema"] != SCHEMA {
        check.fail(format!("schema must be {SCHEMA}"));
    }
    let backend = check.backend(&cfg["backend"]);
    let layers = check.layers(&cfg["layers"], "layers");
    let budget = check.top_budget(cfg.get("budget"));
    let stages = check.stages(&cfg["stages"], &layers, budget);
    let pours = check.list(cfg, "pours", "pours must be a list").iter().enumerate();
    let pours: Vec<Pour> = pours.filter_map(|(i, raw)| check.pour(raw, &format!("pours[{i}]"))).collect();
    let widths = check.list(cfg, "widths", "widths must be a list").iter().enumerate();
    let widths: Vec<WidthRule> = widths.filter_map(|(i, raw)| check.width(raw, &format!("widths[{i}]"), &layers)).collect();
    let features = check.features(cfg.get("features"), known_features);
    if !check.errors.is_empty() {
        return Err(check.finish());
    }
    let about = cfg["about"].as_str().unwrap_or_default().to_string();
    Ok(Plan { backend, about, layers, stages, pours, widths, features })
}

/// The values of a failed field are placeholders: any error makes `load` return Err.
struct Check<'a> {
    copper: &'a [String],
    errors: Vec<String>,
}

impl Check<'_> {
    fn fail(&mut self, message: String) {
        self.errors.push(message);
    }

    fn finish(self) -> String {
        self.errors.join("; ")
    }

    /// False when `value` is no object; an unknown key is an error but the object is still read.
    fn keys(&mut self, value: &Value, allowed: &[&str], place: &str) -> bool {
        let Some(object) = value.as_object() else {
            self.fail(format!("{place} must be an object"));
            return false;
        };
        for key in object.keys().filter(|key| !allowed.contains(&key.as_str())) {
            self.errors.push(format!("{place}: unknown key {key}"));
        }
        true
    }

    fn count(&mut self, value: &Value, place: &str) -> u64 {
        value.as_u64().unwrap_or_else(|| {
            self.fail(format!("{place} must be an integer >= 0"));
            0
        })
    }

    fn count_or(&mut self, raw: &Value, key: &str, default: u64, place: &str) -> u64 {
        raw.get(key).map_or(default, |value| self.count(value, place))
    }

    fn names(&mut self, value: &Value, place: &str) -> Vec<String> {
        let names = value.as_array().and_then(|list| {
            list.iter().map(|name| name.as_str().filter(|name| !name.is_empty()).map(str::to_string)).collect()
        });
        names.unwrap_or_else(|| {
            self.fail(format!("{place} must be a list of non-empty strings"));
            Vec::new()
        })
    }

    fn names_or_none(&mut self, raw: &Value, key: &str, place: &str) -> Vec<String> {
        raw.get(key).map_or_else(Vec::new, |value| self.names(value, &format!("{place}.{key}")))
    }

    fn layers(&mut self, value: &Value, place: &str) -> Vec<String> {
        let names = self.names(value, place);
        for name in names.iter().filter(|name| !self.copper.contains(name)) {
            self.errors.push(format!("{place}: {name} is not a copper layer of the board"));
        }
        if !value.is_null() && names.is_empty() {
            self.fail(format!("{place} must name at least one layer"));
        }
        names
    }

    fn rect(&mut self, value: &Value, place: &str) -> Rect {
        let numbers: Option<Vec<f64>> = value.as_array().and_then(|list| list.iter().map(Value::as_f64).collect());
        let Some(&[x0, y0, x1, y1]) = numbers.as_deref() else {
            self.fail(format!("{place} must be [x0, y0, x1, y1] in mm"));
            return Rect::default();
        };
        if !(x0 < x1 && y0 < y1) {
            self.fail(format!("{place} needs x0 < x1 and y0 < y1"));
        }
        [x0, y0, x1, y1]
    }

    fn mm(&mut self, value: &Value, place: &str) -> f64 {
        value.as_f64().filter(|mm| *mm > 0.0).unwrap_or_else(|| {
            self.fail(format!("{place} must be a number > 0 (mm)"));
            0.0
        })
    }

    fn required(&mut self, value: &Value, place: &str) -> String {
        match value.as_str() {
            Some(text) if !text.is_empty() => text.to_string(),
            _ => {
                self.fail(format!("{place} is required"));
                String::new()
            }
        }
    }

    /// The list under `key`; missing means empty, and anything but a list is the error `message`.
    fn list<'v>(&mut self, raw: &'v Value, key: &str, message: &str) -> &'v [Value] {
        let Some(value) = raw.get(key) else { return &[] };
        value.as_array().map_or_else(
            || {
                self.fail(message.to_string());
                &[][..]
            },
            Vec::as_slice,
        )
    }

    fn backend(&mut self, value: &Value) -> Backend {
        match value.as_str() {
            Some("tracemaker") => Backend::Tracemaker,
            Some("iotroute") => Backend::Iotroute,
            Some("fastroute") => {
                self.fail(NO_FASTROUTE.to_string());
                Backend::Tracemaker
            }
            _ => {
                self.fail("backend must be tracemaker or iotroute".to_string());
                Backend::Tracemaker
            }
        }
    }

    fn top_budget(&mut self, value: Option<&Value>) -> Budget {
        match value {
            Some(raw) if self.keys(raw, BUDGET_KEYS, "budget") => self.budget(raw, DEFAULT_BUDGET, "budget"),
            _ => DEFAULT_BUDGET,
        }
    }

    fn budget(&mut self, raw: &Value, base: Budget, place: &str) -> Budget {
        Budget {
            passes: self.count_or(raw, "passes", base.passes, &format!("{place}.passes")),
            time_s: self.count_or(raw, "time_s", base.time_s, &format!("{place}.time_s")),
            threads: self.count_or(raw, "threads", base.threads, &format!("{place}.threads")),
        }
    }

    fn stages(&mut self, value: &Value, layers: &[String], budget: Budget) -> Vec<Stage> {
        let stages = value.as_array().filter(|list| !list.is_empty());
        let Some(stages) = stages else {
            self.fail("stages must be a non-empty list".to_string());
            return Vec::new();
        };
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (i, raw) in stages.iter().enumerate() {
            let place = format!("stages[{i}]");
            if !self.keys(raw, STAGE_KEYS, &place) {
                continue;
            }
            let name = self.required(&raw["name"], &format!("{place}.name"));
            if !name.is_empty() && !seen.insert(name.clone()) {
                self.fail(format!("duplicate stage name {name}"));
            }
            out.push(self.stage(raw, name, &place, layers, budget));
        }
        out
    }

    fn stage(&mut self, raw: &Value, name: String, place: &str, layers: &[String], budget: Budget) -> Stage {
        if raw.get("only_nets").is_some() && raw.get("skip_nets").is_some() {
            self.fail(format!("{place}: only_nets and skip_nets cannot both be set"));
        }
        let stage_layers = match raw.get("layers") {
            Some(value) => self.layers(value, &format!("{place}.layers")),
            None => layers.to_vec(),
        };
        let only_nets = self.names_or_none(raw, "only_nets", place);
        let skip_nets = self.names_or_none(raw, "skip_nets", place);
        let plane_nets = self.names_or_none(raw, "plane_nets", place);
        let neck_um = self.count_or(raw, "neck_um", 0, &format!("{place}.neck_um"));
        let unlock_nets = self.names_or_none(raw, "unlock_nets", place);
        let via_skip = self.names_or_none(raw, "via_skip", place);
        let remove_zones = self.names_or_none(raw, "remove_zones", place);
        let budget = self.budget(raw, budget, place);
        let route_planes = self.route_planes(raw.get("route_planes"), place);
        let (require_open, max_vias) = self.require(raw.get("require"), place);
        let keepouts = self.list(raw, "keepouts", &format!("{place}.keepouts must be a list")).iter().enumerate();
        let keepouts = keepouts.filter_map(|(k, ko)| self.keepout(ko, &format!("{place}.keepouts[{k}]"))).collect();
        Stage {
            name,
            only_nets,
            skip_nets,
            layers: stage_layers,
            plane_nets,
            route_planes,
            neck_um,
            unlock_nets,
            via_skip,
            remove_zones,
            keepouts,
            budget,
            require_open,
            max_vias,
        }
    }

    fn route_planes(&mut self, value: Option<&Value>, place: &str) -> bool {
        let Some(value) = value else { return false };
        value.as_bool().unwrap_or_else(|| {
            self.fail(format!("{place}.route_planes must be true or false"));
            false
        })
    }

    fn require(&mut self, value: Option<&Value>, place: &str) -> (u64, Option<u64>) {
        let Some(raw) = value else { return (0, None) };
        let require = format!("{place}.require");
        if !self.keys(raw, REQUIRE_KEYS, &require) {
            return (0, None);
        }
        let open = self.count_or(raw, "open", 0, &format!("{require}.open"));
        let vias = &raw["vias"];
        let vias = (!vias.is_null()).then(|| self.count(vias, &format!("{require}.vias")));
        (open, vias)
    }

    fn keepout(&mut self, raw: &Value, place: &str) -> Option<Keepout> {
        if !self.keys(raw, KEEPOUT_KEYS, place) {
            return None;
        }
        let name = self.required(&raw["name"], &format!("{place}.name"));
        let (mode, key) = match (raw.get("inside").is_some(), raw.get("outside").is_some()) {
            (true, false) => (KeepoutMode::Inside, "inside"),
            (false, true) => (KeepoutMode::Outside, "outside"),
            _ => {
                self.fail(format!("{place} needs exactly one of inside or outside"));
                return None;
            }
        };
        let bounds = self.rect(&raw[key], &format!("{place}.{key}"));
        let layers = match raw.get("layers") {
            Some(value) => self.layers(value, &format!("{place}.layers")),
            None => self.copper.to_vec(),
        };
        Some(Keepout { name, mode, bounds, layers })
    }

    fn pour(&mut self, raw: &Value, place: &str) -> Option<Pour> {
        if !self.keys(raw, POUR_KEYS, place) {
            return None;
        }
        let name = self.required(&raw["name"], &format!("{place}.name"));
        let net = self.required(&raw["net"], &format!("{place}.net"));
        let layer = self.required(&raw["layer"], &format!("{place}.layer"));
        if !layer.is_empty() && !self.copper.contains(&layer) {
            self.fail(format!("{place}: {layer} is not a copper layer of the board"));
        }
        let shape = self.pour_shape(&raw["shape"], place);
        let grow_mm = raw["grow_mm"].as_f64();
        if shape == PourShape::Around && !grow_mm.is_some_and(|grow| grow > 0.0) {
            self.fail(format!("{place}.grow_mm must be > 0 for an around pour"));
        }
        let connection = self.pour_connection(raw.get("connection"), place);
        let minus = self.list(raw, "minus", &format!("{place}.minus must be a list of boxes"));
        let priority = self.count_or(raw, "priority", 0, &format!("{place}.priority"));
        let minus = minus.iter().enumerate().map(|(j, b)| self.rect(b, &format!("{place}.minus[{j}]"))).collect();
        let mut mm_or = |key: &str, default: f64| raw.get(key).map_or(default, |value| self.mm(value, &format!("{place}.{key}")));
        let (clearance_mm, thermal_gap_mm, spoke_mm) = (mm_or("clearance_mm", 0.3), mm_or("thermal_gap_mm", 0.4), mm_or("spoke_mm", 1.0));
        Some(Pour { name, net, layer, shape, grow_mm, priority, connection, minus, clearance_mm, thermal_gap_mm, spoke_mm })
    }

    fn pour_shape(&mut self, value: &Value, place: &str) -> PourShape {
        match value.as_str() {
            Some("board") => PourShape::Board,
            Some("around") => PourShape::Around,
            _ => {
                self.fail(format!("{place}.shape must be board or around"));
                PourShape::Board
            }
        }
    }

    fn pour_connection(&mut self, value: Option<&Value>, place: &str) -> PourConnection {
        match value.map(Value::as_str) {
            None | Some(Some("full")) => PourConnection::Full,
            Some(Some("thermal")) => PourConnection::Thermal,
            Some(_) => {
                self.fail(format!("{place}.connection must be full or thermal"));
                PourConnection::Full
            }
        }
    }

    fn width(&mut self, raw: &Value, place: &str, layers: &[String]) -> Option<WidthRule> {
        if !self.keys(raw, WIDTH_KEYS, place) {
            return None;
        }
        let name = self.required(&raw["name"], &format!("{place}.name"));
        let bounds = self.rect(&raw["box"], &format!("{place}.box"));
        let layers = match raw.get("layers") {
            Some(value) => self.layers(value, &format!("{place}.layers")),
            None => layers.to_vec(),
        };
        let width_mm = self.mm(&raw["width_mm"], &format!("{place}.width_mm"));
        Some(WidthRule { name, bounds, layers, width_mm })
    }

    fn features(&mut self, value: Option<&Value>, known: Option<&BTreeSet<String>>) -> BTreeMap<String, bool> {
        let Some(value) = value else { return BTreeMap::new() };
        let Some(object) = value.as_object() else {
            self.fail("features must be an object".to_string());
            return BTreeMap::new();
        };
        let mut features = BTreeMap::new();
        for (key, value) in object {
            if known.is_some_and(|known| !known.contains(key)) {
                self.fail(format!("unknown feature {key}"));
            } else if let Some(on) = value.as_bool() {
                features.insert(key.clone(), on);
            } else {
                self.fail(format!("features.{key} must be true or false"));
            }
        }
        features
    }
}
