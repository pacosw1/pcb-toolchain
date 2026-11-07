//! Shared immutable preparation and native finalization for a packed sprint job.
//! These do not adopt a board. The controller still runs its configured gate.
use super::*;
use serde::{Deserialize, Serialize};

const SCHEMA: &str = "iot-lab.route-prepared.v1";

/// A reader never sees a half-written result: write a sibling, then rename over the target.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temp, bytes)?;
    let moved = fs::rename(&temp, path);
    if moved.is_err() { let _ = fs::remove_file(&temp); }
    moved
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepared {
    schema: String,
    args: Args,
    src: PathBuf,
    folder: PathBuf,
    route_in: PathBuf,
    model: PathBuf,
    binary_sha256: String,
    files: BTreeMap<String, String>,
    lock: Option<LockStage>,
}

fn bind(files: &mut BTreeMap<String, String>, path: &Path) -> Result<(), String> {
    if path.is_file() { files.insert(path.display().to_string(), sha_file(path)?); }
    Ok(())
}

fn validate(prepared: &Prepared, exe: &Path) -> Result<(), String> {
    if prepared.schema != SCHEMA || sha_file(exe)? != prepared.binary_sha256 {
        return Err("prepared model schema/binary binding differs".into());
    }
    for required in [&prepared.src, &prepared.route_in, &prepared.model] {
        if !prepared.files.contains_key(&required.display().to_string()) { return Err("prepared model has an unbound input".into()); }
    }
    for (path, expected) in &prepared.files {
        if sha_file(Path::new(path))? != *expected { return Err(format!("prepared input changed: {path}")); }
    }
    Ok(())
}

fn prepare_job(args: &[String]) -> Result<Prepared, String> {
    let a = parse_args(args)?;
    if a.reuse.is_some() { return Err("sprints do not combine with --reuse".into()); }
    if a.ref_reuse { return Err("--ref-reuse is supported by iotroute run, not sprint preparation".into()); }
    let out = absolute(&a.out)?;
    let work = PathBuf::from(format!("{}.iotroute", out.display()));
    let mut rec = Record::new(out.display().to_string(), work.display().to_string());
    let context = super::prepare(&a, &mut rec, &out, &work)?;
    let mut files = BTreeMap::new();
    for pcb in [&context.src, &context.route_in] {
        for ext in ["kicad_pcb", "kicad_pro", "kicad_sch", "kicad_dru"] { bind(&mut files, &pcb.with_extension(ext))?; }
    }
    bind(&mut files, &context.model)?;
    for entry in fs::read_dir(&context.folder).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "json") { bind(&mut files, &path)?; }
    }
    let prepared = Prepared { schema: SCHEMA.into(), args: a.clone(), src: context.src, folder: context.folder,
        route_in: context.route_in, model: context.model, binary_sha256: sha_file(&context.steps.exe)?, files, lock: rec.stages.lock };
    fs::write(work.join("prepared.json"), serde_json::to_vec_pretty(&prepared).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(prepared)
}

pub fn prepare_cli(args: &[String]) -> i32 {
    match prepare_job(args) {
        Ok(p) => { println!("{}", serde_json::to_string(&p).unwrap()); 0 }
        Err(e) => { eprintln!("sprint preparation: {e}"); 2 }
    }
}

fn finish_job(prepared: &Prepared, route: &Path, out: &Path, work: &Path, seed: u64, via_cost: f64, route_log: &Path, rec: &mut Record) -> Result<(), String> {
    finish_job_using(prepared, route, out, work, seed, via_cost, route_log, rec, Steps::new(&prepared.args.tools)?, super::finish)
}

fn finish_job_using(prepared: &Prepared, route: &Path, out: &Path, work: &Path, seed: u64, via_cost: f64, route_log: &Path, rec: &mut Record,
    steps: Steps, finish: impl FnOnce(&mut Record, &Path, &Path) -> Result<DrcCounts, String>) -> Result<(), String> {
    if out.extension().and_then(|e| e.to_str()) != Some("kicad_pcb") || out.exists() || work.exists() {
        rec.work = None;
        return Err("sprint finish needs a new .kicad_pcb output and work folder".into());
    }
    if prepared.args.ref_reuse { return Err("sprint finish does not enable experimental feedback reuse".into()); }
    if !via_cost.is_finite() || via_cost <= 0.0 { return Err("via cost must be finite and positive".into()); }
    if !route_log.is_file() { return Err("sprint finish requires the original core log".into()); }

    validate(prepared, &steps.exe)?;
    let result: serde_json::Value = serde_json::from_slice(&fs::read(route).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if result["schema"] != "iot-lab.route-result.v0" || !result["tracks"].is_array() || !result["vias"].is_array() || !result["failed"].is_array() {
        return Err("sprint finish requires a finalized route, never a yield receipt".into());
    }
    fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let local_route = work.join("route.json");
    fs::copy(route, &local_route).map_err(|e| e.to_string())?;
    fs::copy(route_log, work.join("route.log")).map_err(|e| e.to_string())?;
    // Feedback raises model costs; checkpoint input remains immutable for every variant.
    let model = work.join("model.json");
    fs::copy(&prepared.model, &model).map_err(|e| e.to_string())?;
    let mut args = prepared.args.clone();
    args.seed = Some(seed); args.via_cost = Some(via_cost);
    let widths = widths::board_widths(&prepared.folder, &prepared.model)?;
    rec.board = prepared.folder.file_name().map(|n| n.to_string_lossy().into_owned());
    rec.input = Some(prepared.src.display().to_string());
    rec.input_sha256 = Some(sha_file(&prepared.src)?);
    rec.iters = Some(prepared.args.iters); rec.seed = Some(seed);
    rec.stages.binary = Some(BinaryStage { path: steps.exe.display().to_string(), how: "self", sources_sha256: sources_sha(&prepared.args.tools), sha256: prepared.binary_sha256.clone() });
    rec.stages.lock = prepared.lock.clone();
    rec.stages.model = Some(ModelStage { line: "shared prepared model".into(), sha256: sha_file(&prepared.model)? });
    rec.stages.write = Some(steps.write_route(&prepared.route_in, &local_route, out, work, &widths)?);
    place_sidecars(&prepared.src, out)?;
    rec.pro_restored = Some(restore_pro(&prepared.src, out)?);
    let context = Run { a: &args, steps, model, route_in: prepared.route_in.clone(),
        route_in_sha256: sha_file(&prepared.route_in)?, src: prepared.src.clone(), folder: prepared.folder.clone(), widths };
    rec.stages.ref_gate = Some(context.ref_gate(out, work)?);
    validate(prepared, &context.steps.exe)?;
    finish(rec, out, work)?;
    let result: serde_json::Value = serde_json::from_slice(&fs::read(&local_route).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Core failures may describe rules not reducible to a native connectivity count.
    if !result["failed"].as_array().is_some_and(|failed| failed.is_empty()) {
        rec.status = Status::Fail; rec.cause = Some("finalized core result still has failed nets".into());
    }
    Ok(())
}

pub fn finish_cli(args: &[String]) -> i32 {
    let [manifest, route, output, seed, via_cost, route_log] = args else { eprintln!("usage: iotroute sprint-finish PREPARED.json ROUTE.json OUT.kicad_pcb SEED VIA_COST ROUTE.log"); return 2 };
    let prepared: Prepared = match fs::read(manifest).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
        Ok(p) => p, Err(e) => { eprintln!("prepared input: {e}"); return 2 }
    };
    let Ok(seed) = seed.parse::<u64>() else { eprintln!("seed must be an unsigned integer"); return 2 };
    let Ok(via_cost) = via_cost.parse::<f64>() else { eprintln!("invalid via cost"); return 2 };
    let out = match absolute(output) { Ok(p) => p, Err(e) => { eprintln!("{e}"); return 2 } };
    let work = PathBuf::from(format!("{}.iotroute", out.display()));
    let start = Instant::now();
    let mut rec = Record::new(out.display().to_string(), work.display().to_string());
    let code = match finish_job(&prepared, Path::new(route), &out, &work, seed, via_cost, Path::new(route_log), &mut rec) {
        Ok(()) => i32::from(rec.status != Status::Pass),
        Err(e) => { rec.status = Status::Error; rec.cause = Some(e); 2 }
    };
    rec.seconds = Some(start.elapsed().as_secs_f64());
    if rec.work.is_some() && work.is_dir() { let _ = write_atomic(&work.join("result.json"), &serde_json::to_vec_pretty(&rec).unwrap()); }
    println!("{}\n{}", rec.summary_line(), sorted_json(&rec).unwrap());
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn sprint_feedback_is_private_preserves_variant_and_checks_selected_failures() {
        use std::os::unix::fs::PermissionsExt;
        struct Temp(PathBuf);
        impl Drop for Temp { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let root = Temp(std::env::temp_dir().join(format!("sprint-feedback-{}", std::process::id())));
        fs::create_dir_all(&root.0).unwrap();
        let backend = root.0.join("backend.sh");
        fs::write(&backend, r##"#!/bin/sh
set -eu
case "$1" in
  write)
    mkdir -p "$4"
    cp "$2" "$4/input.kicad_pcb"
    echo 'WRITE PASS drc 0 {} unconnected 0 parity 0'
    ;;
  si-planes)
    # Fail only the initial screen; a selected feedback route ends the loop.
    if [ ! -d "${2}.iotroute/ref-r2" ]; then echo 'FAIL unknown-driver F.Cu A: crossing'; exit 1; fi
    echo '0 reference-plane failures'
    ;;
  *)
    printf '%s\n' "$@" > "$(dirname "$2")/args.txt"
    failed=$(cat "$(dirname "$0")/failed")
    printf '{"schema":"iot-lab.route-result.v0","tracks":[],"vias":[],"failed":%s}' "$failed" > "$2"
    echo 'ROUTE PASS converged true iters 1 tracks 0 vias 0 failed 0 notes 0 0 s -> route.json'
    ;;
esac
"##).unwrap();
        fs::set_permissions(&backend, fs::Permissions::from_mode(0o700)).unwrap();
        let src = root.0.join("input.kicad_pcb"); fs::write(&src, "(kicad_pcb)").unwrap();
        fs::write(src.with_extension("kicad_pro"), "{}").unwrap();
        fs::write(root.0.join("gate.json"), r#"{"checks":{"planes":"planes.json"}}"#).unwrap();
        let model = root.0.join("prepared-model.json");
        fs::write(&model, r#"{"nets":{"A":{"ref_soft":true,"ref_cost":3.0}}}"#).unwrap();
        let mut prepared = Prepared { schema: SCHEMA.into(), args: parse_args(&["B".into(), "out.kicad_pcb".into()]).unwrap(),
            src: src.clone(), folder: root.0.clone(), route_in: src.clone(), model: model.clone(),
            binary_sha256: sha_file(&backend).unwrap(), files: BTreeMap::new(), lock: None };
        bind(&mut prepared.files, &src).unwrap(); bind(&mut prepared.files, &model).unwrap();
        let initial = root.0.join("initial.json");
        fs::write(&initial, r#"{"schema":"iot-lab.route-result.v0","tracks":[],"vias":[],"failed":[]}"#).unwrap();
        let log = root.0.join("initial.log"); fs::write(&log, "actual initial core log\n").unwrap();
        for (index, failed, expected) in [(0, "[]", Status::Pass), (1, "[\"A\"]", Status::Fail), (2, "null", Status::Fail)] {
            fs::write(root.0.join("failed"), failed).unwrap();
            let out = root.0.join(format!("variant-{index}.kicad_pcb"));
            let work = PathBuf::from(format!("{}.iotroute", out.display()));
            let mut steps = Steps::new(&root.0).unwrap(); steps.exe = backend.clone();
            let mut rec = Record::new(out.display().to_string(), work.display().to_string());
            finish_job_using(&prepared, &initial, &out, &work, 23, 7.5, &log, &mut rec, steps, |rec, board, work| {
                // The final native check must run after feedback has selected its board.
                assert!(work.join("ref-r2/route.json").is_file());
                assert_eq!(fs::read(board).unwrap(), fs::read(&src).unwrap());
                rec.status = Status::Pass; Ok(DrcCounts::default())
            }).unwrap();
            assert_eq!(rec.status, expected);
            assert_eq!(rec.stages.ref_gate.unwrap().rounds.len(), 2);
            assert_eq!(fs::read_to_string(work.join("route-initial.log")).unwrap(), "actual initial core log\n");
            assert_ne!(sha_file(&work.join("model.json")).unwrap(), sha_file(&model).unwrap());
            validate(&prepared, &backend).unwrap();
            let args = fs::read_to_string(work.join("ref-r2/args.txt")).unwrap();
            assert!(args.contains("\n--seed\n23\n")); assert!(args.contains("\n--via-cost\n7.5\n"));
            assert!(!args.contains("--reuse"));
        }
        // Missing logs and invalid costs fail before any child can run or work directory is created.
        for (cost, log_path, message) in [(f64::NAN, log.clone(), "via cost"), (0.0, log.clone(), "via cost"), (3.0, root.0.join("missing.log"), "original core log")] {
            let out = root.0.join("invalid.kicad_pcb"); let work = root.0.join("invalid-work");
            let mut steps = Steps::new(&root.0).unwrap(); steps.exe = backend.clone();
            let mut rec = Record::new(out.display().to_string(), work.display().to_string());
            let err = finish_job_using(&prepared, &initial, &out, &work, 0, cost, &log_path, &mut rec, steps,
                |_, _, _| panic!("invalid input reached native check")).unwrap_err();
            assert!(err.contains(message)); assert!(!work.exists());
        }
    }

    #[test]
    fn sprint_preparation_refuses_an_ignored_feedback_experiment() {
        let error = prepare_job(&["BOARD".into(), "out.kicad_pcb".into(), "--ref-reuse".into()]).err().unwrap();
        assert!(error.contains("not sprint preparation"));
    }
    #[test]
    fn unbound_or_changed_preparation_is_rejected_before_native_work() {
        let d = std::env::temp_dir().join(format!("sprint-bind-{}", std::process::id())); fs::create_dir_all(&d).unwrap();
        let source = d.join("source"); fs::write(&source, "old").unwrap();
        let exe = std::env::current_exe().unwrap();
        let mut p = Prepared { schema: SCHEMA.into(), args: parse_args(&["X".into(), "out.kicad_pcb".into()]).unwrap(),
            src: source.clone(), folder: d.clone(), route_in: source.clone(), model: source.clone(),
            binary_sha256: sha_file(&exe).unwrap(), files: BTreeMap::new(), lock: None };
        assert!(validate(&p, &exe).unwrap_err().contains("unbound"));
        bind(&mut p.files, &source).unwrap(); assert!(validate(&p, &exe).is_ok());
        fs::write(&source, "changed").unwrap(); assert!(validate(&p, &exe).unwrap_err().contains("changed"));
        fs::remove_dir_all(d).unwrap();
    }
}
