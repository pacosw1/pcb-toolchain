//! The `widths` rules of the board's route.json on a core result, before `iotroute write`: what `iotroute route` does after its
//! route. A board that limits track width in a box (ENV-SENSE, the thermal island) holds that limit for either router. Narrowing
//! never goes wider; KiCad DRC on the written board stays the verdict.
use crate::plan::{self, WidthRule};
use serde_json::Value;
use std::fs;
use std::path::Path;

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// The rules of `folder`/route.json; none when the board has no such file. `model` names the copper layers.
pub fn board_widths(folder: &Path, model: &Path) -> Result<Vec<WidthRule>, String> {
    let file = folder.join("route.json");
    if !file.is_file() {
        return Ok(Vec::new());
    }
    let copper: Vec<String> = serde_json::from_value(read_json(model)?["copper_layers"].clone()).map_err(|e| format!("{}: copper_layers: {e}", model.display()))?;
    let loaded = plan::load(&read_json(&file)?, &copper, None).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(loaded.widths)
}

fn point(track: &Value, key: &str) -> Option<(f64, f64)> {
    Some((track[key][0].as_f64()?, track[key][1].as_f64()?))
}

/// Each track of `result` a rule applies to gets the rule's width. The number of tracks changed.
fn narrow_tracks(result: &mut Value, rules: &[WidthRule]) -> Result<usize, String> {
    let mut changed = 0;
    for track in result["tracks"].as_array_mut().ok_or("result has no tracks")? {
        let (Some(a), Some(b), Some(layer), Some(width)) = (point(track, "a"), point(track, "b"), track["layer"].as_str().map(str::to_string), track["w"].as_f64()) else {
            return Err(format!("result track is not a track: {track}"));
        };
        let narrow = rules.iter().fold(width, |now, rule| if rule.applies(a, b, &layer, now) { rule.width_mm } else { now });
        if narrow < width {
            track["w"] = narrow.into();
            changed += 1;
        }
    }
    Ok(changed)
}

/// `narrow_tracks` on the core's result file.
pub fn narrow(route: &Path, rules: &[WidthRule]) -> Result<usize, String> {
    if rules.is_empty() {
        return Ok(0);
    }
    let mut result = read_json(route)?;
    let changed = narrow_tracks(&mut result, rules)?;
    if changed > 0 {
        let text = serde_json::to_string(&result).map_err(|e| e.to_string())?;
        fs::write(route, text).map_err(|e| format!("{}: {e}", route.display()))?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule() -> WidthRule {
        WidthRule { name: "ISLAND".to_string(), bounds: [0.0, 0.0, 10.0, 5.0], layers: vec!["F.Cu".to_string()], width_mm: 0.15 }
    }

    #[test]
    fn a_track_in_the_box_gets_the_rule_width() {
        let mut result = json!({"tracks": [
            {"net": "A", "layer": "F.Cu", "a": [1.0, 1.0], "b": [3.0, 1.0], "w": 0.25},
            {"net": "A", "layer": "B.Cu", "a": [1.0, 1.0], "b": [3.0, 1.0], "w": 0.25},
            {"net": "A", "layer": "F.Cu", "a": [20.0, 1.0], "b": [23.0, 1.0], "w": 0.25},
            {"net": "A", "layer": "F.Cu", "a": [1.0, 2.0], "b": [3.0, 2.0], "w": 0.1},
        ]});
        assert_eq!(narrow_tracks(&mut result, &[rule()]).unwrap(), 1);
        let widths: Vec<f64> = result["tracks"].as_array().unwrap().iter().map(|t| t["w"].as_f64().unwrap()).collect();
        assert_eq!(widths, [0.15, 0.25, 0.25, 0.1]);
    }

    #[test]
    fn a_result_without_tracks_is_refused() {
        assert!(narrow_tracks(&mut json!({}), &[rule()]).is_err());
    }
}
