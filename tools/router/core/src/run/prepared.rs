//! Shared immutable preparation and native finalization for a packed sprint job.
//! These do not adopt a board. The controller still runs its configured gate.
use super::*;
use serde::{Deserialize, Serialize};

const SCHEMA: &str = "iot-lab.route-prepared.v1";

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

fn finish_job(prepared: &Prepared, route: &Path, out: &Path, work: &Path, seed: u64, rec: &mut Record) -> Result<(), String> {
    if out.extension().and_then(|e| e.to_str()) != Some("kicad_pcb") || out.exists() || work.exists() {
        rec.work = None;
        return Err("sprint finish needs a new .kicad_pcb output and work folder".into());
    }
    let steps = Steps::new(&prepared.args.tools)?;
    validate(prepared, &steps.exe)?;
    let result: serde_json::Value = serde_json::from_slice(&fs::read(route).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if result["schema"] != "iot-lab.route-result.v0" || !result["tracks"].is_array() || !result["vias"].is_array() || !result["failed"].is_array() {
        return Err("sprint finish requires a finalized route, never a yield receipt".into());
    }
    fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let local_route = work.join("route.json");
    fs::copy(route, &local_route).map_err(|e| e.to_string())?;
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
    super::finish(rec, out, work)?;
    // Core failures may describe rules not reducible to a native connectivity count.
    if !result["failed"].as_array().unwrap().is_empty() {
        rec.status = "FAIL"; rec.cause = Some("finalized core result still has failed nets".into());
    }
    Ok(())
}

pub fn finish_cli(args: &[String]) -> i32 {
    let [manifest, route, output, seed] = args else { eprintln!("usage: iotroute sprint-finish PREPARED.json ROUTE.json OUT.kicad_pcb SEED"); return 2 };
    let prepared: Prepared = match fs::read(manifest).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
        Ok(p) => p, Err(e) => { eprintln!("prepared input: {e}"); return 2 }
    };
    let Ok(seed) = seed.parse::<u64>() else { eprintln!("seed must be an unsigned integer"); return 2 };
    let out = match absolute(output) { Ok(p) => p, Err(e) => { eprintln!("{e}"); return 2 } };
    let work = PathBuf::from(format!("{}.iotroute", out.display()));
    let start = Instant::now();
    let mut rec = Record::new(out.display().to_string(), work.display().to_string());
    let code = match finish_job(&prepared, Path::new(route), &out, &work, seed, &mut rec) {
        Ok(()) => i32::from(rec.status != "PASS"),
        Err(e) => { rec.status = "ERROR"; rec.cause = Some(e); 2 }
    };
    rec.seconds = Some(start.elapsed().as_secs_f64());
    if rec.work.is_some() && work.is_dir() { let _ = fs::write(work.join("result.json"), serde_json::to_vec_pretty(&rec).unwrap()); }
    println!("{}\n{}", rec.summary_line(), sorted_json(&rec).unwrap());
    code
}

#[cfg(test)]
mod tests {
    use super::*;
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
