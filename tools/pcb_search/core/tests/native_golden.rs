//! Records and output boards written by the Python implementation on a small synthetic board:
//! `python -m pcb_search.native_candidate` and `native_eco`, Python 3.13.5 in iot-lab-route:10.0. The board has what real
//! boards lack: escaped strings, unicode, a legacy numeric net and odd number forms. Hashes cover the raw text, so a
//! decoding reader fails here.

use std::fs;
use std::path::{Path, PathBuf};

use pcbsearch::native::candidate::scope_native;
use pcbsearch::native::eco::shift_via;
use pcbsearch::pyjson::indented;
use serde_json::Value;

const GOLDEN: &str = include_str!("fixtures/native-golden.json");

fn project(golden: &Value, name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pcbsearch-golden-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let board = dir.join("FIXTURE.kicad_pcb");
    fs::write(&board, golden["board"].as_str().unwrap()).unwrap();
    for extension in ["kicad_pro", "kicad_dru", "kicad_sch"] {
        fs::write(board.with_extension(extension), "fixture").unwrap();
    }
    board
}

fn flag_values(args: &[Value], flag: &str) -> Vec<String> {
    args.chunks(2).filter(|pair| pair[0] == flag).filter_map(|pair| pair.get(1)?.as_str().map(String::from)).collect()
}

fn run(case: &Value, board: &Path) -> Result<Value, String> {
    let args = case["args"].as_array().unwrap();
    let out = board.with_file_name("out");
    let outcome = if case["kind"] == "native_candidate" {
        let backend = board.with_file_name("backend.kicad_pcb");
        fs::write(&backend, case["backend"].as_str().unwrap()).unwrap();
        scope_native(board, &backend, &out, &flag_values(&args[3..], "--net"))
    } else {
        let fraction: f64 = flag_values(&args[4..], "--fraction")[0].parse().unwrap();
        shift_via(board, args[1].as_str().unwrap(), args[2].as_str().unwrap(), &out, fraction)
    };
    outcome.map_err(|error| error.to_string())
}

fn output_board(board: &Path, case: &Value) -> String {
    let name = if case["kind"] == "native_candidate" { "candidate.kicad_pcb" } else { "proposal.kicad_pcb" };
    fs::read_to_string(board.with_file_name("out").join(name)).unwrap()
}

#[test]
fn records_and_boards_match_the_python_implementation() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 9);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let board = project(&golden, name);
        match run(case, &board) {
            Ok(record) => {
                assert_eq!(indented(&record).unwrap(), indented(&case["record"]).unwrap(), "{name}");
                assert_eq!(output_board(&board, case), case["board"].as_str().unwrap(), "{name}");
            }
            Err(reason) => assert_eq!(format!("STUCK: {reason}"), case["stdout"].as_str().unwrap(), "{name}"),
        }
    }
}
