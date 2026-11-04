//! Current in copper, by the formulas of the paths gate (tools/pcbtool.py): IPC-2221 with the external constant on every layer
//! (IPC-2152), via barrels rated by their cross-section.
use super::text::round_to;
use std::f64::consts::PI;

const IPC_K: f64 = 0.048;

fn area_amps(area_mm2: f64, dt: f64) -> f64 {
    IPC_K * dt.powf(0.44) * (area_mm2 / 0.0254f64.powf(2.0)).powf(0.725)
}

/// The current of a track.
pub fn ipc_amps(width_mm: f64, thick_mm: f64, dt: f64) -> f64 {
    area_amps(width_mm * thick_mm, dt)
}

/// The current of one via barrel.
pub fn via_amps(drill_mm: f64, plating_mm: f64, dt: f64) -> f64 {
    area_amps(PI * drill_mm * plating_mm, dt)
}

/// Smallest track width in mm, rounded up to 0.01 mm, that carries `amps` by `ipc_amps`. 0 for no current.
pub fn ipc_width(amps: f64, thick_mm: f64, dt: f64) -> f64 {
    if amps <= 0.0 {
        return 0.0;
    }
    let solved = (amps / (IPC_K * dt.powf(0.44))).powf(1.0 / 0.725) * 0.0254f64.powf(2.0) / thick_mm;
    let mut w = (solved * 100.0 - 1e-9).ceil() / 100.0;
    while ipc_amps(w, thick_mm, dt) < amps {
        w += 0.01;
    }
    round_to(w, 2)
}

/// (drill, diameter) of the smallest via that carries `amps`: the drill grows in 0.05 mm steps from `drill`, with the same
/// annular ring. The via as given when it already does.
pub fn via_for_current(drill: f64, diameter: f64, amps: f64, plating_mm: f64, dt: f64) -> (f64, f64) {
    let mut d = drill;
    while via_amps(d, plating_mm, dt) < amps && d < 1.0 {
        d = round_to(d + 0.05, 2);
    }
    (d, round_to(diameter + d - drill, 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_power_via_grows_until_it_carries_the_current() {
        // ESP32-CORE b4 paths_low: VIN_REG 2.1 A through one 0.3 mm via = 1.92 A at dT 20 K, plating 18 um.
        assert!(via_amps(0.3, 0.018, 20.0) < 2.1);
        let (drill, diameter) = via_for_current(0.3, 0.6, 2.1, 0.018, 20.0);
        assert_eq!((drill, diameter), (0.35, 0.65));
        assert!(via_amps(drill, 0.018, 20.0) >= 2.1);
        assert_eq!(via_for_current(0.3, 0.6, 1.0, 0.018, 20.0), (0.3, 0.6));
    }

    #[test]
    fn a_width_is_the_first_hundredth_that_carries_the_current() {
        assert_eq!(ipc_width(0.0, 0.035, 10.0), 0.0);
        let w = ipc_width(1.5, 0.035, 10.0);
        assert!(ipc_amps(w, 0.035, 10.0) >= 1.5);
        assert!(ipc_amps(w - 0.01, 0.035, 10.0) < 1.5);
    }
}
