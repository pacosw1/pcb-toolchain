//! The placement a session reports against the board it was routed for.
//!
//! The import writes copper only, so a part cannot move here. A session that holds a part elsewhere was still routed against another
//! placement, and its copper is no result for this board: it stops the job. Only rounding onto the declared Specctra grid is
//! accepted, and only when the nearest grid point is unique.
use super::records::{Point, atom, directives, resolution_step, scaled, section};
use crate::kicad::raw::Form;
use std::collections::{BTreeMap, BTreeSet};

/// `(place REF x y side rotation ...)`.
#[derive(Debug, Clone, PartialEq)]
struct Place {
    at: Point,
    side: String,
    rotation: f64,
}

/// Nanometres of one grid step of a file: `(resolution um N)`, the same everywhere in it.
fn grid_of(text: &str) -> Result<i64, String> {
    let found: BTreeSet<Vec<String>> = directives(text, "resolution", 2).into_iter().collect();
    let mut rows = found.iter();
    let (Some(row), None) = (rows.next(), rows.next()) else { return Err("missing or ambiguous Specctra resolution".to_string()) };
    resolution_step(&row[0], &row[1]).map_err(|_| "unsupported Specctra resolution".to_string())
}

/// The export grid both files declare, in nanometres.
pub fn grid_nm(dsn: &str, ses: &str) -> Result<i64, String> {
    let (exported, imported) = (grid_of(dsn)?, grid_of(ses)?);
    if exported != imported {
        return Err("DSN/SES resolution mismatch".to_string());
    }
    Ok(exported)
}

fn walk_places<'a>(form: &'a Form, out: &mut Vec<&'a Form>) {
    for item in form.items() {
        if item.is("place") {
            out.push(item);
        } else if item.is("component") {
            walk_places(item, out);
        }
    }
}

/// The placed parts of a file by reference. A row with no position is a part the file does not place.
fn places(text: &str, scale: i64) -> Result<BTreeMap<String, Place>, String> {
    let root = section(text, "placement")?;
    let mut rows = Vec::new();
    walk_places(&root, &mut rows);
    let mut out = BTreeMap::new();
    for row in rows.into_iter().filter(|row| row.items().len() >= 6) {
        let reference = atom(row, 1)?.to_string();
        let rotation: f64 = atom(row, 5)?.parse().map_err(|_| format!("unsupported rotation of {reference}"))?;
        let place = Place { at: (scaled(atom(row, 2)?, scale)?, -scaled(atom(row, 3)?, scale)?), side: atom(row, 4)?.to_string(), rotation };
        if out.insert(reference.clone(), place).is_some() {
            return Err(format!("duplicate placement of {reference}"));
        }
    }
    Ok(out)
}

/// Whether `new` is `old` itself, or `old` on the uniquely nearest point of the grid. Equidistant ties are no attributable rounding.
fn rounded(old: i64, new: i64, step: i64) -> bool {
    if old == new {
        return true;
    }
    let (quotient, rest) = (old.div_euclid(step), old.rem_euclid(step));
    let nearest = (quotient + i64::from(2 * rest > step)) * step;
    2 * rest != step && new == nearest && 2 * (new - old).abs() <= step
}

/// Refuses a session that moved, turned, flipped or invented a part; the grid in nanometres otherwise. The side and rotation are
/// compared with the DSN of the same run, which holds them in the words of the format; the position with the board itself.
pub fn check(footprints: &[(String, Point)], dsn: &str, ses: &str) -> Result<i64, String> {
    let step = grid_nm(dsn, ses)?;
    let mut board = BTreeMap::new();
    for (reference, position) in footprints {
        if board.insert(reference.as_str(), *position).is_some() {
            return Err("missing/duplicate footprint UUID or reference".to_string());
        }
    }
    let exported = places(dsn, 1000)?;
    for (reference, place) in places(ses, step)? {
        let (Some(old), Some(offered)) = (board.get(reference.as_str()), exported.get(&reference)) else {
            return Err(format!("SES added/removed footprints: {reference}"));
        };
        if place.side != offered.side {
            return Err(format!("SES changed footprint layer: {reference}"));
        }
        if place.rotation != offered.rotation {
            return Err(format!("SES changed footprint angle: {reference}"));
        }
        if !rounded(old.0, place.at.0, step) || !rounded(old.1, place.at.1, step) {
            return Err(format!("SES displaced footprint beyond export rounding: {reference}"));
        }
    }
    Ok(step)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSN: &str = "(pcb x (resolution um 10)(unit um)(placement (component \"a\" (place U1 1000.5 -2000 front 90 (PN x)))))";

    fn session(place: &str) -> String {
        format!("(session s (placement (resolution um 10)(component \"a\" {place}))(routes (resolution um 10)))")
    }

    fn u1(position: Point) -> Vec<(String, Point)> {
        vec![("U1".to_string(), position)]
    }

    #[test]
    fn exact_and_rounded_poses_are_accepted() {
        let ses = session("(place U1 10005 -20000 front 90)");
        assert_eq!(check(&u1((1_000_500, 2_000_000)), DSN, &ses), Ok(100));
        // Off the 100 nm grid by 20 and 40 nm: the session holds the nearest point.
        assert_eq!(check(&u1((1_000_520, 2_000_040)), DSN, &ses), Ok(100));
        assert_eq!(check(&u1((1_000_480, 1_999_960)), DSN, &ses), Ok(100));
    }

    #[test]
    fn a_larger_or_non_rounding_translation_is_refused() {
        let ses = session("(place U1 10005 -20000 front 90)");
        for position in [(1_000_700, 2_000_000), (1_000_500, 2_000_100), (1_000_400, 2_000_000)] {
            assert!(check(&u1(position), DSN, &ses).unwrap_err().contains("beyond export rounding"), "{position:?}");
        }
        // Exactly between two grid points: not attributable.
        assert!(check(&u1((1_000_450, 2_000_000)), DSN, &ses).unwrap_err().contains("beyond export rounding"));
        assert!(check(&u1((1_000_550, 2_000_000)), DSN, &ses).unwrap_err().contains("beyond export rounding"));
        assert!(!rounded(150, 200, 100) && !rounded(150, 100, 100) && rounded(149, 100, 100) && rounded(151, 200, 100));
        assert!(rounded(-149, -100, 100) && !rounded(-150, -100, 100));
    }

    #[test]
    fn a_rotation_a_flip_and_a_new_part_are_refused() {
        let at = u1((1_000_500, 2_000_000));
        assert!(check(&at, DSN, &session("(place U1 10005 -20000 front 180)")).unwrap_err().contains("angle"));
        assert!(check(&at, DSN, &session("(place U1 10005 -20000 back 90)")).unwrap_err().contains("layer"));
        assert!(check(&at, DSN, &session("(place U2 10005 -20000 front 90)")).unwrap_err().contains("added/removed"));
        assert!(check(&[], DSN, &session("(place U1 10005 -20000 front 90)")).unwrap_err().contains("added/removed"));
        let twice = "(place U1 10005 -20000 front 90)(place U1 10005 -20000 front 90)";
        assert!(check(&at, DSN, &session(twice)).unwrap_err().contains("duplicate"));
    }

    #[test]
    fn a_part_the_session_leaves_out_stays_and_a_row_with_no_position_places_nothing() {
        let mut board = u1((1_000_500, 2_000_000));
        board.push(("U9".to_string(), (0, 0)));
        assert_eq!(check(&board, DSN, &session("(place U1 10005 -20000 front 90)(place U9)")), Ok(100));
        assert_eq!(check(&board, DSN, &session("")), Ok(100));
    }

    #[test]
    fn duplicate_references_on_the_board_are_refused() {
        let board = vec![("U1".to_string(), (0, 0)), ("U1".to_string(), (1, 1))];
        assert!(check(&board, DSN, &session("")).unwrap_err().contains("duplicate"));
    }

    #[test]
    fn the_declared_grid_is_matched_and_fails_closed() {
        assert_eq!(grid_nm("(resolution um 10)", "(resolution um 10)(resolution um 10)"), Ok(100));
        assert_eq!(grid_nm("(resolution um 1)", "(resolution um 1)"), Ok(1000));
        assert_eq!(grid_nm("(resolution um 10)", "(resolution um 100)").unwrap_err(), "DSN/SES resolution mismatch");
        for bad in ["", "(resolution um 10)(resolution um 100)"] {
            assert_eq!(grid_nm(bad, "(resolution um 10)").unwrap_err(), "missing or ambiguous Specctra resolution");
        }
        for bad in ["(resolution mm 10)", "(resolution um 0)", "(resolution um 3)"] {
            assert_eq!(grid_nm(bad, bad).unwrap_err(), "unsupported Specctra resolution");
        }
    }
}
