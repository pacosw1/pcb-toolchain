//! Transmission line equations and the stackup they run on. All lengths in mm. The equations do not model solder mask; mask
//! lowers Z by a few ohm.
//!
//! Microstrip (outer layers): Hammerstad and Jensen 1980, "Accurate models for microstrip computer-aided design", with their
//! thickness correction. Wadell, "Transmission Line Design Handbook" (1991), section 3.5.
//! Edge-coupled microstrip: Kirschning and Jansen 1984, "Accurate wide-range design equations for the frequency-dependent
//! characteristic of parallel coupled microstrip lines" (static even/odd mode part), Wadell section 3.6. Zdiff = 2 * Z0odd.
//! Stripline (inner layers): IPC-2141A symmetric stripline, Z0 = 60/sqrt(Er) ln(4b / (0.67 pi (0.8w + t))),
//! Zdiff = 2 Z0 (1 - 0.374 exp(-2.9 s/b)). IPC-2141A is a coarse model (about +-10 %).
use regex_lite::Regex;
use std::collections::BTreeMap;
use std::f64::consts::{E, PI};

const ETA0: f64 = 376.73;
const C0_MM_PER_NS: f64 = 299.792458;

/// Hammerstad-Jensen impedance of a zero-thickness microstrip in air, u = w/h.
fn z01(u: f64) -> f64 {
    let f = 6.0 + (2.0 * PI - 6.0) * (-(30.666 / u).powf(0.7528)).exp();
    ETA0 / (2.0 * PI) * (f / u + (1.0 + (2.0 / u).powf(2.0)).sqrt()).ln()
}

fn eeff0(u: f64, er: f64) -> f64 {
    let a = 1.0 + ((u.powf(4.0) + (u / 52.0).powf(2.0)) / (u.powf(4.0) + 0.432)).ln() / 49.0 + (1.0 + (u / 18.1).powf(3.0)).ln() / 18.7;
    let b = 0.564 * ((er - 0.9) / (er + 3.0)).powf(0.053);
    (er + 1.0) / 2.0 + (er - 1.0) / 2.0 * (1.0 + 10.0 / u).powf(-a * b)
}

/// Z0, Eeff and u_r of a single microstrip with the Hammerstad-Jensen thickness correction.
fn microstrip(w: f64, h: f64, t: f64, er: f64) -> (f64, f64, f64) {
    let u = w / h;
    let (du1, dur) = if t > 0.0 {
        let tn = t / h;
        let du1 = tn / PI * (1.0 + 4.0 * E / (tn / (6.517 * u).sqrt().tanh().powf(2.0))).ln();
        (du1, 0.5 * (1.0 + 1.0 / (er - 1.0).sqrt().cosh()) * du1)
    } else {
        (0.0, 0.0)
    };
    let (u1, ur) = (u + du1, u + dur);
    let z = z01(ur) / eeff0(ur, er).sqrt();
    (z, eeff0(ur, er) * (z01(u1) / z01(ur)).powf(2.0), ur)
}

pub fn microstrip_z0(w: f64, h: f64, t: f64, er: f64) -> f64 {
    microstrip(w, h, t, er).0
}

/// Differential impedance 2 * Z0odd of an edge-coupled microstrip pair (Kirschning-Jansen, static).
pub fn microstrip_zdiff(w: f64, s: f64, h: f64, t: f64, er: f64) -> f64 {
    let (zl, eeff, u) = microstrip(w, h, t, er);
    let g = s / h;
    // Odd mode effective permittivity.
    let ao = 0.7287 * (eeff - (er + 1.0) / 2.0) * (1.0 - (-0.179 * u).exp());
    let bo = 0.747 * er / (0.15 + er);
    let co = bo - (bo - 0.207) * (-0.414 * u).exp();
    let d_o = 0.593 + 0.694 * (-0.562 * u).exp();
    let eo = ((er + 1.0) / 2.0 + ao - eeff) * (-co * g.powf(d_o)).exp() + eeff;
    // Odd mode impedance.
    let q1 = 0.8695 * u.powf(0.194);
    let q2 = 1.0 + 0.7519 * g + 0.189 * g.powf(2.31);
    let q3 = 0.1975 + (16.6 + (8.4 / g).powf(6.0)).powf(-0.387) + (g.powf(10.0) / (1.0 + (g / 3.4).powf(10.0))).ln() / 241.0;
    let q4 = 2.0 * q1 / q2 / ((-g).exp() * u.powf(q3) + (2.0 - (-g).exp()) * u.powf(-q3));
    let q5 = 1.794 + 1.14 * (1.0 + 0.638 / (g + 0.517 * g.powf(2.43))).ln();
    let q6 = 0.2305 + (g.powf(10.0) / (1.0 + (g / 5.8).powf(10.0))).ln() / 281.3 + (1.0 + 0.598 * g.powf(1.154)).ln() / 5.1;
    let q7 = (10.0 + 190.0 * g.powf(2.0)) / (1.0 + 82.3 * g.powf(3.0));
    let q8 = (-6.5 - 0.95 * g.ln() - (g / 0.15).powf(5.0)).exp();
    let q9 = q7.ln() * (q8 + 1.0 / 16.5);
    let q10 = (q2 * q4 - q5 * (u.ln() * q6 * u.powf(-q9)).exp()) / q2;
    let zo = zl * (eeff / eo).sqrt() / (1.0 - zl / ETA0 * eeff.sqrt() * q10);
    2.0 * zo
}

pub fn stripline_z0(w: f64, b: f64, t: f64, er: f64) -> f64 {
    60.0 / er.sqrt() * (4.0 * b / (0.67 * PI * (0.8 * w + t))).ln()
}

pub fn stripline_zdiff(w: f64, s: f64, b: f64, t: f64, er: f64) -> f64 {
    2.0 * stripline_z0(w, b, t, er) * (1.0 - 0.374 * (-2.9 * s / b).exp())
}

/// C per length of a microstrip in pF/mm: C' = sqrt(Eeff) / (c0 x Z0).
pub fn microstrip_pf_per_mm(w: f64, h: f64, t: f64, er: f64) -> f64 {
    let (z, eeff, _) = microstrip(w, h, t, er);
    1000.0 * eeff.sqrt() / (C0_MM_PER_NS * z)
}

/// A copper layer: its thickness, and the height and Er of the dielectric toward the board centre.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StackLayer {
    pub t_mm: Option<f64>,
    pub h_mm: Option<f64>,
    pub er: Option<f64>,
}

pub type Stackup = BTreeMap<String, StackLayer>;

struct Item {
    name: String,
    kind: String,
    thickness: Option<f64>,
    er: Option<f64>,
}

fn number_after(pattern: &str, text: &str) -> Result<Option<f64>, String> {
    let re = Regex::new(pattern).expect("a fixed pattern");
    let Some(found) = re.captures(text) else { return Ok(None) };
    found[1].parse().map(Some).map_err(|_| format!("could not convert string to float: '{}'", &found[1]))
}

/// The text of the (stackup ...) of a board: up to (copper_finish, else the end of the file.
fn stackup_body(text: &str) -> Option<&str> {
    let body = &text[text.find("(stackup")? + "(stackup".len()..];
    Some(body.find("(copper_finish").map_or(body, |end| &body[..end]))
}

fn stackup_items(body: &str) -> Result<Vec<Item>, String> {
    let kind = Regex::new(r#"\(type "([^"]+)"\)"#).expect("a fixed pattern");
    let mut items = Vec::new();
    for chunk in body.split("(layer \"").skip(1) {
        let Some((name, rest)) = chunk.split_once('"') else { continue };
        if name.is_empty() {
            continue;
        }
        items.push(Item {
            name: name.to_string(),
            kind: kind.captures(rest).map_or(String::new(), |c| c[1].to_string()),
            thickness: number_after(r"\(thickness ([\d.]+)", rest)?,
            er: number_after(r"\(epsilon_r ([\d.]+)\)", rest)?,
        });
    }
    Ok(items)
}

/// The dielectric toward the board centre: below for the top half, above for B.Cu.
fn dielectric_of<'a>(items: &'a [Item], at: usize, name: &str) -> Option<&'a Item> {
    let step: isize = if name == "B.Cu" { -1 } else { 1 };
    let mut j = at as isize + step;
    while let Some(item) = usize::try_from(j).ok().and_then(|i| items.get(i)) {
        if !matches!(item.kind.as_str(), "" | "Top Solder Mask" | "Bottom Solder Mask") {
            return matches!(item.kind.as_str(), "prepreg" | "core").then_some(item);
        }
        j += step;
    }
    None
}

/// The (stackup ...) of a .kicad_pcb text. For F.Cu and B.Cu, h_mm and er are of the dielectric to the adjacent plane layer.
/// The board JSON has no epsilon_r, so this reads the file text. None: no (stackup) section.
pub fn parse_stackup(text: &str) -> Result<Option<Stackup>, String> {
    let Some(body) = stackup_body(text) else { return Ok(None) };
    let items = stackup_items(body)?;
    let mut out = Stackup::new();
    for (i, item) in items.iter().enumerate().filter(|(_, item)| item.kind == "copper") {
        let d = dielectric_of(&items, i, &item.name);
        out.insert(item.name.clone(), StackLayer { t_mm: item.thickness, h_mm: d.and_then(|d| d.thickness), er: d.and_then(|d| d.er) });
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    // JLC04161H-7628 outer layer (jlcpcb.com/impedance, read 2026-09-26): 1 oz copper, 7628 prepreg 0.2104 mm, Er 4.4.
    const T: f64 = 0.035;
    const H: f64 = 0.2104;
    const ER: f64 = 4.4;

    fn pct(a: f64, b: f64) -> f64 {
        (a - b).abs() / b * 100.0
    }

    #[test]
    fn air_microstrip_matches_the_textbook() {
        // Hammerstad-Jensen, w/h = 1, zero thickness, Er = 1: 126.5 ohm (Pozar, Microwave Engineering, fig. 3.26).
        assert!((microstrip_z0(1.0, 1.0, 0.0, 1.0) - 126.5).abs() < 0.5);
    }

    #[test]
    fn jlc_50_ohm_single_uncoated() {
        // JLC calculator: 50 ohm at w = 0.3244 mm, solder mask included. The uncoated model must be above 50 and within 10 %.
        let z = microstrip_z0(0.3244, H, T, ER);
        assert!(z > 50.0 && pct(z, 50.0) < 10.0);
    }

    #[test]
    fn jlc_pair_holdout() {
        // JLC calculator: 90 ohm at w 0.2332 / s 0.15, 100 ohm at w 0.1722 / s 0.15. A mask factor fitted on the first predicts
        // the second within 2 %.
        let k = 90.0 / microstrip_zdiff(0.2332, 0.15, H, T, ER);
        assert!(pct(k * microstrip_zdiff(0.1722, 0.15, H, T, ER), 100.0) < 2.0);
    }

    #[test]
    fn a_wider_gap_raises_zdiff() {
        assert!(microstrip_zdiff(0.2, 0.3, H, T, ER) > microstrip_zdiff(0.2, 0.15, H, T, ER));
    }

    #[test]
    fn stripline_follows_ipc_2141() {
        // b = 1.0, w = 0.2, t = 0.0152, Er = 4.6: 60/2.1448 * ln(4 / 0.3687) = 66.7 ohm (hand calculation).
        assert!((stripline_z0(0.2, 1.0, 0.0152, 4.6) - 66.7).abs() < 0.3);
    }

    pub const STACKUP_TEXT: &str = r#"
  (stackup
   (layer "F.Mask" (type "Top Solder Mask") (thickness 0.01) (material "LPI") (epsilon_r 3.8))
   (layer "F.Cu" (type "copper") (thickness 0.035))
   (layer "dielectric 1" (type "prepreg") (thickness 0.2104) (material "7628") (epsilon_r 4.4) (loss_tangent 0.02))
   (layer "In1.Cu" (type "copper") (thickness 0.0152))
   (layer "dielectric 2" (type "core") (thickness 1.065) (material "FR4") (epsilon_r 4.6) (loss_tangent 0.02))
   (layer "In2.Cu" (type "copper") (thickness 0.0152))
   (copper_finish "HAL lead-free")
  )
"#;

    #[test]
    fn copper_takes_the_dielectric_below_it() {
        let st = parse_stackup(STACKUP_TEXT).unwrap().unwrap();
        assert_eq!(st["F.Cu"], StackLayer { t_mm: Some(0.035), h_mm: Some(0.2104), er: Some(4.4) });
        assert_eq!(st["In1.Cu"], StackLayer { t_mm: Some(0.0152), h_mm: Some(1.065), er: Some(4.6) });
    }

    #[test]
    fn b_cu_takes_the_dielectric_above_it() {
        let text = r#"(stackup (layer "dielectric 3" (type "prepreg") (thickness 0.2) (epsilon_r 4.1)) (layer "B.Cu" (type "copper") (thickness 0.03)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01)))"#;
        assert_eq!(parse_stackup(text).unwrap().unwrap()["B.Cu"].h_mm, Some(0.2));
    }

    #[test]
    fn no_stackup_section_reads_as_none() {
        assert_eq!(parse_stackup("(kicad_pcb)").unwrap(), None);
    }

    #[test]
    fn the_capacitance_of_a_line_follows_its_impedance() {
        let (z, eeff, _) = microstrip(0.2, H, T, ER);
        assert!((microstrip_pf_per_mm(0.2, H, T, ER) - 1000.0 * eeff.sqrt() / (C0_MM_PER_NS * z)).abs() < 1e-15);
    }
}
