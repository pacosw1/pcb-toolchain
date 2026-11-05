//! Search and cost parameters, with the defaults the placer was tuned on (README, tools/placer/README.md).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
    // cost: RUDY (default: the old term, tracks 0, limit 0.1, the cost of P2 and P2R)
    pub rudy_cell: f64,
    pub mask_cell: f64,
    pub layers: f64,
    pub pitch: f64,
    pub limit: f64,
    pub pin_demand: f64,
    pub tracks: f64,
    pub gap: f64,
    // cost: weights; a weight of 0 means the term is not computed
    pub w_wl: f64,
    pub w_cong: f64,
    pub w_ov: f64,
    pub w_oob: f64,
    pub w_sp: f64,
    pub w_via: f64,
    pub w_x: f64,
    pub w_row: f64,
    pub w_esc: f64,
    pub w_mst: f64,
    pub via_d: f64,
    pub via_clr: f64,
    pub row_pitch: f64,
    /// 1 = a fully blocked IC side is illegal.
    pub esc_hard: f64,
    // search
    pub grid: f64,
    pub p_swap: f64,
    pub p_rot: f64,
    pub swap_ratio: f64,
    pub t_ratio: f64,
    pub t0: Option<f64>,
    pub w0: Option<f64>,
    pub w1: f64,
    pub ramp: f64,
    pub distinct: f64,
    pub mains: f64,
    /// Optional cumulative radius from the seed place; 0 = unbounded.
    pub max_displacement: f64,
    /// Soft clusters: the share of the epochs with cluster moves only; after it a member also moves alone inside clu_local mm.
    pub clu_phase: f64,
    pub clu_local: f64,
    /// 1 = start with each tied part at its pin.
    pub clu_gather: f64,
    /// 1 = a pad inside the edge clearance, measured exactly, is illegal (search/sprint.rs). 0 only to compare with the old search.
    pub exact_edge: f64,
    /// 1 = break equal sprint overflow by unclipped peak utilization. Experimental; no verified-rate gain yet.
    #[serde(default)]
    pub route_pressure: f64,
    // legalizer
    pub legal_step: f64,
    pub legal_radius: f64,
    pub legal_passes: f64,
    pub legal_time: f64,
    pub legal_rotate: f64,
    // analytic global placement (gplace)
    pub global: f64,
    pub target: f64,
    pub stop_overflow: f64,
    pub mu: f64,
    pub gamma: Option<f64>,
    pub max_move: f64,
    pub infl: f64,
    pub seed: f64,
    pub init: String,
    pub route_rounds: f64,
    pub route_overflow: f64,
    pub max_infl: f64,
    pub bins: f64,
    pub iters: f64,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            rudy_cell: 1.0,
            mask_cell: 0.1,
            layers: 2.0,
            pitch: 0.4,
            limit: 0.1,
            pin_demand: 0.0,
            tracks: 0.0,
            gap: 0.2,
            w_wl: 1.0,
            w_cong: 1.0,
            w_ov: 20.0,
            w_oob: 20.0,
            w_sp: 2.0,
            w_via: 10.0,
            w_x: 0.0,
            w_row: 0.0,
            w_esc: 0.0,
            w_mst: 0.0,
            via_d: 0.6,
            via_clr: 0.2,
            row_pitch: 1.0,
            esc_hard: 0.0,
            grid: 0.05,
            p_swap: 0.1,
            p_rot: 0.1,
            swap_ratio: 1.5,
            t_ratio: 1e-4,
            t0: None,
            w0: None,
            w1: 0.25,
            ramp: 20.0,
            distinct: 0.0,
            mains: 0.0,
            max_displacement: 0.0,
            clu_phase: 0.5,
            clu_local: 3.0,
            clu_gather: 1.0,
            exact_edge: 1.0,
            route_pressure: 0.0,
            legal_step: 0.25,
            legal_radius: 5.0,
            legal_passes: 3.0,
            legal_time: 60.0,
            legal_rotate: 1.0,
            global: 0.0,
            target: 0.9,
            stop_overflow: 0.1,
            mu: 1.05,
            gamma: None,
            max_move: 0.5,
            infl: 1.0,
            seed: 1.0,
            init: "centre".into(),
            route_rounds: 2.0,
            route_overflow: 0.2,
            max_infl: 2.0,
            bins: 64.0,
            iters: 1000.0,
        }
    }
}

impl Params {
    /// Defaults with `key=value` overrides. An unknown key is an error: a typo must not run a different search.
    pub fn from_args<S: AsRef<str>>(args: &[S]) -> crate::Result<Self> {
        let mut map = serde_json::to_value(Self::default())?;
        let fields = map.as_object_mut().expect("params serialize to an object");
        for arg in args {
            let (key, value) = arg.as_ref().split_once('=').ok_or_else(|| format!("bad --param {}", arg.as_ref()))?;
            if !fields.contains_key(key) {
                return Err(format!("unknown --param {key}").into());
            }
            fields.insert(key.to_string(), parse_value(value));
        }
        let params: Self = serde_json::from_value(map)?;
        if params.route_pressure != 0.0 && params.route_pressure != 1.0 {
            return Err("route_pressure must be 0 or 1".into());
        }
        Ok(params)
    }

    pub fn spacing_weights_at(&self, f: f64) -> (f64, f64) {
        let grow = self.ramp.powf(f);
        (self.w_ov * grow, self.w_oob * grow)
    }

    pub fn uses_escape(&self) -> bool {
        self.w_esc != 0.0 || self.esc_hard != 0.0
    }
}

/// A number, or a word (init=pose).
fn parse_value(v: &str) -> Value {
    v.parse::<f64>().ok().and_then(|n| serde_json::Number::from_f64(n)).map_or_else(|| Value::from(v), Value::Number)
}

#[cfg(test)]
mod tests {
    use super::Params;

    #[test]
    fn overrides_apply_and_typos_fail() {
        let p = Params::from_args(&["w_ov=5", "init=pose", "t0=1.5"]).unwrap();
        assert_eq!(p.w_ov, 5.0);
        assert_eq!(p.init, "pose");
        assert_eq!(p.t0, Some(1.5));
        assert!(Params::from_args(&["w_ovv=5"]).is_err());
        assert!(Params::from_args(&["w_ov"]).is_err());
    }
}
