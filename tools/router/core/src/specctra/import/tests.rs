use super::*;

const NM: i64 = 100; // resolution um 10: one tick is 100 nm

fn segment() -> Geometry {
    Geometry::segment("P", "F.Cu", 200_000, (1000, 2000), (3000, 2000))
}

fn old() -> Vec<Existing> {
    vec![Existing { id: "old".to_string(), geometry: segment() }]
}

fn ids(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|id| id.to_string()).collect()
}

/// `(wire ...)` of the segment() copper, in ticks, with its mode line.
fn wire(mode: &str) -> String {
    let ty = if mode.is_empty() { String::new() } else { format!("(type {mode})") };
    format!("(wire(path F.Cu {} {} -{} {} -{}){ty})", 200_000 / NM, 1000 / NM, 2000 / NM, 3000 / NM, 2000 / NM)
}

fn session_text(wires: &str) -> String {
    format!("(session s (routes(resolution um 10)(library_out)(network_out(net P{wires}))))")
}

/// A DSN whose wiring is the segment() copper with this type.
fn dsn_text(mode: &str) -> String {
    format!("(resolution um 10)(unit um)(library)(wiring (wire (path F.Cu 200 1 -2 3 -2)(net P)(type {mode})))")
}

const BOARD: &str = "(kicad_pcb\n\t(layers\n\t\t(0 \"F.Cu\" signal)\n\t\t(2 \"B.Cu\" signal)\n\t)\n\t(footprint \"x\"\n\t\t(pad \"1\" smd rect\n\t\t\t(net \"P\")\n\t\t)\n\t)\n\t(segment\n\t\t(start 0.001 0.002)\n\t\t(end 0.003 0.002)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(net \"P\")\n\t\t(uuid \"old\")\n\t)\n)\n";

fn run(copper: &[Existing], preserved: &BTreeSet<String>, dsn: &str, ses: &str) -> Result<Imported, String> {
    import(&Session { board_text: BOARD, copper, preserved, dsn, ses, seed: "t" })
}

#[test]
fn an_exact_protected_copy_of_preserved_copper_is_not_written() {
    let result = run(&old(), &ids(&["old"]), &dsn_text("route"), &session_text(&wire("protect"))).unwrap();
    assert_eq!(result.added, 0);
    assert_eq!(result.replays[0].retained_uuid, "old");
    assert_eq!(result.replays[0].dsn_modes, ["route"]);
    assert_eq!(result.text, BOARD);
}

#[test]
fn repeated_protected_copies_all_count() {
    let ses = session_text(&format!("{0}{0}", wire("fix")));
    let result = run(&old(), &ids(&["old"]), &dsn_text("fix"), &ses).unwrap();
    assert_eq!(result.replays[0].ses_modes, ["fix", "fix"]);
    assert_eq!(result.added, 0);
}

#[test]
fn a_coincidence_with_copper_not_offered_as_route_is_refused() {
    let error = run(&old(), &ids(&[]), &dsn_text("fix"), &session_text(&wire("route"))).unwrap_err();
    assert_eq!(error, "unlocked source was not offered as unlocked wiring");
}

#[test]
fn unlocked_copper_returned_unchanged_is_the_routers_copy() {
    let result = run(&old(), &ids(&[]), &dsn_text("route"), &session_text(&wire("route"))).unwrap();
    assert_eq!(result.added, 1);
    assert!(!result.text.contains("(uuid \"old\")"));
    assert_eq!(result.text.matches("(segment").count(), 1);
}

#[test]
fn absent_provenance_and_unprotected_copies_are_refused() {
    let good = dsn_text("route");
    let no_wiring = "(resolution um 10)(unit um)(library)(wiring)";
    for (dsn, ses) in [
        (no_wiring.to_string(), session_text(&wire("protect"))),
        (good.clone(), session_text(&wire("route"))),
        (good.clone(), session_text(&wire(""))),
        (dsn_text("unknown"), session_text(&wire("protect"))),
    ] {
        assert!(run(&old(), &ids(&["old"]), &dsn, &ses).is_err(), "{dsn} {ses}");
    }
}

#[test]
fn an_untyped_replay_of_a_fixed_dsn_wire_is_accepted_and_nothing_else_is() {
    assert_eq!(run(&old(), &ids(&["old"]), &dsn_text("fix"), &session_text(&wire(""))).unwrap().added, 0);
    // The DSN at whole um: one coordinate 400 nm away.
    let near = "(resolution um 10)(unit um)(library)(wiring (wire (path F.Cu 200 1 -2 3 -2.4)(net P)(type fix)))";
    assert_eq!(run(&old(), &ids(&["old"]), near, &session_text(&wire(""))).unwrap().added, 0);
    for (dsn, ses) in [("route", wire("")), ("protect", wire("")), ("fix", wire("route")), ("fix", format!("{}{}", wire(""), wire("route")))] {
        let error = run(&old(), &ids(&["old"]), &dsn_text(dsn), &session_text(&ses)).unwrap_err();
        assert!(error.starts_with("unprotected"), "{error}");
    }
}

#[test]
fn two_sources_of_one_geometry_are_ambiguous() {
    let mut two = old();
    two.push(Existing { id: "old2".to_string(), geometry: segment() });
    let board = BOARD.replace("\n)\n", "\n\t(segment\n\t\t(uuid \"old2\")\n\t)\n)\n");
    let session = |preserved: &BTreeSet<String>, ses: &str| {
        let (dsn, copper) = (dsn_text("route"), two.clone());
        let session = Session { board_text: &board, copper: &copper, preserved, dsn: &dsn, ses, seed: "t" };
        import(&session).map(|result| result.added)
    };
    assert!(session(&ids(&["old", "old2"]), &session_text(&wire("protect"))).unwrap_err().contains("ambiguous"));
    assert!(session(&ids(&[]), &session_text(&wire("route"))).unwrap_err().contains("ambiguous"));
    let nothing = session_text("");
    assert_eq!(session(&ids(&["old", "old2"]), &nothing), Ok(0));
}

#[test]
fn identical_new_copies_are_duplicates_and_dropped() {
    let ses = session_text("(wire(path F.Cu 2000 50 -50 60 -50)(type route))(wire(path F.Cu 2000 60 -50 50 -50)(type route))");
    let result = run(&old(), &ids(&["old"]), &dsn_text("route"), &ses).unwrap();
    assert_eq!(result.added, 1);
    assert_eq!(result.duplicates.len(), 1);
    assert_eq!(result.duplicates[0].ends_nm, [(6000, 5000), (5000, 5000)]);
}

#[test]
fn two_new_vias_on_one_spot_are_refused() {
    let library = "(library_out(padstack \"Via[0-1]_600:300_um\"(shape(circle F.Cu 6000))(shape(circle B.Cu 6000))))";
    let via = "(via \"Via[0-1]_600:300_um\" 10 -20)";
    let ses = format!("(session s (routes(resolution um 10){library}(network_out(net P{via}{via}))))");
    let error = run(&old(), &ids(&["old"]), &dsn_text("route"), &ses).unwrap_err();
    assert_eq!(error, "new-new duplicate without preserved source");
}

#[test]
fn a_segment_shorter_than_the_dsn_unit_is_no_copper() {
    let ses = session_text("(wire(path F.Cu 2000 50 -50 53 -52)(type route))(wire(path F.Cu 2000 50 -50 60 -50)(type route))");
    let result = run(&old(), &ids(&["old"]), &dsn_text("route"), &ses).unwrap();
    assert_eq!(result.short.len(), 1);
    assert_eq!(result.short[0].ends_nm, [(5000, 5000), (5300, 5200)]);
    assert_eq!(result.added, 1);
}

#[test]
fn a_fixed_wire_is_left_to_the_replay_policy() {
    let short = session_text("(wire(path F.Cu 2000 50 -50 53 -52)(type fix))");
    assert_eq!(run(&old(), &ids(&["old"]), &dsn_text("route"), &short).unwrap().short.len(), 0);
}

#[test]
fn a_new_segment_is_written_with_the_files_direction_and_a_stable_uuid() {
    let ses = session_text("(wire(path F.Cu 2000 60 -50 50 -50)(type route))");
    let result = run(&old(), &ids(&["old"]), &dsn_text("route"), &ses).unwrap();
    assert!(result.text.contains("(start 0.006 0.005)\n\t\t(end 0.005 0.005)\n\t\t(width 0.2)\n\t\t(layer \"F.Cu\")\n\t\t(net \"P\")\n"));
    assert!(result.text.contains(&format!("(uuid \"{}\")", item_uuid("t", 0))));
    assert!(result.text.ends_with("\t)\n)\n"));
    assert!(result.text.contains("(uuid \"old\")"), "preserved copper stays");
}

#[test]
fn a_new_via_is_written_with_its_padstack() {
    let library = "(library_out(padstack \"Via[0-1]_600:300_um\"(shape(circle F.Cu 6000))(shape(circle B.Cu 6000))))";
    let ses = format!("(session s (routes(resolution um 10){library}(network_out(net P(via \"Via[0-1]_600:300_um\" 10 -20)))))");
    let result = run(&old(), &ids(&["old"]), &dsn_text("route"), &ses).unwrap();
    assert!(result.text.contains("(at 0.001 0.002)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers \"F.Cu\" \"B.Cu\")\n\t\t(net \"P\")\n"));
}

#[test]
fn a_net_or_layer_the_board_lacks_stops_the_import() {
    let net = session_text("").replace("(net P)", "(net Q(wire(path F.Cu 2000 50 -50 60 -50)))");
    assert!(run(&old(), &ids(&["old"]), &dsn_text("route"), &net).unwrap_err().contains("not on the board"));
    let layer = session_text("(wire(path In7.Cu 2000 50 -50 60 -50))");
    assert!(run(&old(), &ids(&["old"]), &dsn_text("route"), &layer).unwrap_err().contains("not on the board"));
}

#[test]
fn unknown_preserved_copper_and_preserved_arcs_are_refused() {
    let dsn = dsn_text("route");
    let ses = session_text("");
    assert_eq!(run(&old(), &ids(&["ghost"]), &dsn, &ses).unwrap_err(), "unknown preserved UUID");
    let arc = [Existing { id: "old".to_string(), geometry: Geometry::Unsupported("old".to_string()) }];
    assert!(run(&arc, &ids(&["old"]), &dsn, &ses).unwrap_err().contains("arc replay not proved"));
}

#[test]
fn every_unlocked_item_must_be_in_the_text() {
    let copper = [Existing { id: "gone".to_string(), geometry: segment() }];
    let ses = session_text("");
    assert!(run(&copper, &ids(&[]), &dsn_text("route"), &ses).unwrap_err().contains("0 of 1"));
}
