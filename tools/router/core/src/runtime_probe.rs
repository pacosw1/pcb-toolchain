//! Configurable, copy-only runtime measurements. No result from this command qualifies a board.
use crate::kicad::api::{Client, Server, PINNED_COMMIT, decode, read_board, via_types};
use crate::kicad::api::proto::kiapi::{board::{commands as bc, jobs as bj, types as bt}, common::{commands as cc, types as ct}};
use crate::run::project::project_files;
use crate::sha256::sha256;
use prost_types::Any;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::{Path, PathBuf}, process::Command, time::Instant};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Runtime { #[default] Stable, Nightly }

#[derive(Debug, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct Config { runtime: Runtime, stable_cli: String, nightly_cli: String, repeats: usize }
impl Default for Config {
    fn default() -> Self { Self { runtime: Runtime::Stable, stable_cli: "kicad-cli".into(), nightly_cli: "kicad-cli-nightly".into(), repeats: 3 } }
}
impl Config {
    fn parse(text: &str) -> Result<Self, String> {
        let value: Self = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if !(1..=10).contains(&value.repeats) || value.stable_cli.is_empty() || value.nightly_cli.is_empty() {
            return Err("repeats must be 1..10 and CLI paths must be nonempty".into());
        }
        Ok(value)
    }
}

fn hashes(source: &Path) -> Result<BTreeMap<String, String>, String> {
    let files = project_files(source)?;
    let mut hashes = BTreeMap::new();
    for file in std::iter::once(source.to_path_buf()).chain(files.into_values()) {
        hashes.insert(file.display().to_string(), sha256(&fs::read(&file).map_err(|e| e.to_string())?));
    }
    Ok(hashes)
}

fn stage_copy(source: &Path, out: &Path) -> Result<PathBuf, String> {
    // Refuse existing destinations, including symlinks: no caller file is ever replaced.
    fs::create_dir(out).map_err(|e| format!("new output directory required: {e}"))?;
    let input = out.join("input"); fs::create_dir(&input).map_err(|e| e.to_string())?;
    let copy = input.join(source.file_name().ok_or("source has no file name")?);
    fs::copy(source, &copy).map_err(|e| e.to_string())?;
    for (name, file) in project_files(source)? {
        if Path::new(&name).components().any(|c| !matches!(c,std::path::Component::Normal(_))) {
            return Err(format!("sidecar escapes the copy: {name}"));
        }
        let target = if name.starts_with('.') { copy.with_extension(name.trim_start_matches('.')) } else { input.join(name) };
        if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        fs::copy(file, target).map_err(|e| e.to_string())?;
    }
    Ok(copy)
}

fn command(cli: &str, args: &[String], out: &Path, label: &str, api_cli: Option<&str>) -> Result<Value, String> {
    let mut command = Command::new(cli); command.args(args);
    if let Some(api_cli) = api_cli { command.env("KICAD_API_CLI", api_cli); }
    let at = Instant::now(); let result = command.output().map_err(|e| format!("{cli}: {e}"))?;
    fs::write(out.join(format!("{label}.stdout")), &result.stdout).map_err(|e| e.to_string())?;
    fs::write(out.join(format!("{label}.stderr")), &result.stderr).map_err(|e| e.to_string())?;
    Ok(json!({"command":std::iter::once(cli.to_string()).chain(args.iter().cloned()).collect::<Vec<_>>(),
        "exit":result.status.code(),"seconds":at.elapsed().as_secs_f64()}))
}

fn board_value(client: &mut Client, board: &Path) -> Result<Value, String> {
    let _version = client.version().map_err(|e| e.to_string())?;
    let mut value = serde_json::to_value(read_board(client, board).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let kinds = via_types(client).map_err(|e| e.to_string())?;
    for item in value["copper"].as_array_mut().into_iter().flatten() {
        if let Some(via) = item.get_mut("Via") {
            via["via_type"] = kinds.get(via["id"].as_str().unwrap_or("")).map_or("Unknown", String::as_str).into();
        }
    }
    Ok(value)
}

/// Group membership is an unordered set in KiCad. Do not normalize ordered geometry such as polygon points.
fn comparable(mut board: Value) -> Value {
    for group in board["groups"].as_array_mut().into_iter().flatten() {
        if let Some(items) = group["items"].as_array_mut() { items.sort_by(|a,b|a.as_str().cmp(&b.as_str())); }
    }
    board
}

fn edit_rollback(client: &mut Client, doc: &ct::DocumentSpecifier) -> Result<Value, String> {
    let items = client.items(doc, &[ct::KiCadObjectType::KotPcbTrace]).map_err(|e| e.to_string())?;
    let original = items.iter().find_map(decode::<bt::Track>).ok_or("no track for rollback probe")?;
    let mut changed = original.clone(); changed.width.as_mut().ok_or("track has no width")?.value_nm += 1;
    let header = ct::ItemHeader { document: Some(doc.clone()), ..Default::default() };
    let at = Instant::now();
    let commit: cc::BeginCommitResponse = client.call(&cc::BeginCommit { header: Some(header.clone()) }).map_err(|e| e.to_string())?;
    let updated = client.call::<_, cc::UpdateItemsResponse>(&cc::UpdateItems { header: Some(header.clone()), items: vec![Any::from_msg(&changed).map_err(|e| e.to_string())?] });
    // Always drop a pending edit, even when the update was refused.
    let _: cc::EndCommitResponse = client.call(&cc::EndCommit { id: commit.id, action: cc::CommitAction::CmaDrop as i32, message: String::new(), header: Some(header) }).map_err(|e| e.to_string())?;
    let updated = updated.map_err(|e| e.to_string())?;
    let modified = updated.updated_items.iter().filter_map(|r|r.item.as_ref()).filter_map(decode::<bt::Track>)
        .any(|t|t.id==original.id && t.width==changed.width);
    let after = client.items(doc, &[ct::KiCadObjectType::KotPcbTrace]).map_err(|e| e.to_string())?.iter().filter_map(decode::<bt::Track>).find(|t| t.id == original.id);
    Ok(json!({"seconds":at.elapsed().as_secs_f64(),"update_status":updated.status().as_str_name(),"modified_item_returned":modified,"original_restored":after.as_ref()==Some(&original)}))
}

fn nightly(cfg: &Config, board: &Path, out: &Path) -> Result<Value, String> {
    let at = Instant::now(); let (_server, mut client) = Server::start_with_cli(board, &cfg.nightly_cli)?;
    let startup = at.elapsed().as_secs_f64(); let version = client.version().map_err(|e| e.to_string())?;
    if !version.full_version.contains(&PINNED_COMMIT[..10]) { return Err(format!("unreviewed IPC protocol: {} (expected {PINNED_COMMIT})", version.full_version)); }
    let doc = client.board_document().map_err(|e| e.to_string())?;
    let reader = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut warm = Vec::new(); let mut cold = Vec::new();
    for i in 0..cfg.repeats {
        let at = Instant::now(); let value = board_value(&mut client, board)?;
        let digest = sha256(&serde_json::to_vec(&value).map_err(|e| e.to_string())?);
        let normalized = sha256(&serde_json::to_vec(&comparable(value.clone())).map_err(|e|e.to_string())?);
        warm.push(json!({"seconds":at.elapsed().as_secs_f64(),"board_sha256":digest,"comparison_sha256":normalized,
            "footprints":value["footprints"].as_array().map(Vec::len),"copper":value["copper"].as_array().map(Vec::len),
            "zones":value["zones"].as_array().map(Vec::len),"nets":value["nets"].as_object().map(|n|n.len())}));
        fs::write(out.join(format!("warm-read-{i}.json")),serde_json::to_vec(&value).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        let label = format!("cold-read-{i}");
        let run = command(reader.to_str().ok_or("nonutf8 reader")?, &["board-json".into(),board.display().to_string()], out, &label, Some(&cfg.nightly_cli))?;
        let fresh: Value = serde_json::from_slice(&fs::read(out.join(format!("{label}.stdout"))).map_err(|e| e.to_string())?).map_err(|e| format!("cold read failed: {e}"))?;
        cold.push(json!({"run":run,"same_board_value":sha256(&serde_json::to_vec(&comparable(fresh["board"].clone())).map_err(|e| e.to_string())?)==normalized}));
    }
    let rollback = edit_rollback(&mut client, &doc).map_or_else(|e| json!({"error":e}), |v| v);
    let svg = out.join("warm.svg"); let at = Instant::now();
    let exported: Result<ct::RunJobResponse, _> = client.call(&bj::RunBoardJobExportSvg {
        job_settings: Some(ct::RunJobSettings { document: Some(doc.clone()), output_path: svg.display().to_string() }),
        plot_settings: Some(bj::BoardPlotSettings { layers: vec![bt::BoardLayer::BlFCu as i32], scale:1.0,
            plot_reference_designators:true,plot_footprint_values:true,drill_marks:bj::PlotDrillMarks::PdmFull as i32,..Default::default() }),
        fit_page_to_board:true,precision:4,page_mode:bj::BoardJobPaginationMode::BjpmAllLayersOnePage as i32 });
    let export = exported.map_or_else(|e| json!({"error":e.to_string()}), |r| json!({"seconds":at.elapsed().as_secs_f64(),"status":r.status().as_str_name(),"files":r.output_path,"file_exists":svg.is_file(),"message":r.message}));
    let at = Instant::now(); let refill = client.command(&bc::RefillZones { board:Some(doc.clone()), zones:Vec::new() });
    let refill = json!({"seconds":at.elapsed().as_secs_f64(),"error":refill.err().map(|e|e.to_string())});
    let saved = out.join("nightly-saved.kicad_pcb");
    let save = client.command(&cc::SaveCopyOfDocument { document:Some(doc),path:saved.display().to_string(),options:Some(cc::SaveOptions{overwrite:false,include_project:true}) });
    let save = json!({"error":save.err().map(|e|e.to_string()),"file_exists":saved.is_file(),"path":saved});
    let compatibility = if saved.is_file() {
        // Supply the same schematic/rules under the saved copy's stem, without replacing its generated project.
        for ext in ["kicad_sch","kicad_dru"] {
            let source = board.with_extension(ext);
            if source.is_file() { fs::copy(source,saved.with_extension(ext)).map_err(|e|e.to_string())?; }
        }
        command(&cfg.stable_cli,&["pcb".into(),"drc".into(),"--schematic-parity".into(),"--format".into(),"json".into(),"-o".into(),out.join("stable-after-save-drc.json").display().to_string(),saved.display().to_string()],out,"stable-after-save",None)?
    } else { json!({"unavailable":"nightly copy was not saved"}) };
    Ok(json!({"version":version.full_version,"startup_s":startup,"warm_reads":warm,"cold_reads":cold,"edit_rollback":rollback,
        "svg_export":export,"refill":refill,"copy_save":save,"stable_reopen":compatibility,
        "drc_erc_parity_ipc":"not in the pinned request protocol; remain CLI operations"}))
}

pub fn cli(args: &[String]) -> i32 {
    let [config, source, output] = args else { eprintln!("usage: iotroute runtime-probe CONFIG.json BOARD.kicad_pcb NEW_OUTDIR");return 2; };
    match run(Path::new(config),Path::new(source),Path::new(output)) {
        Ok(()) => 0, Err(e) => { eprintln!("runtime-probe: {e}");2 }
    }
}

fn run(config: &Path, source: &Path, out: &Path) -> Result<(), String> {
    let cfg = Config::parse(&fs::read_to_string(config).map_err(|e|e.to_string())?)?;
    let source = fs::canonicalize(source).map_err(|e|e.to_string())?;
    let before = hashes(&source)?; let board = stage_copy(&source,out)?;
    let out = fs::canonicalize(out).map_err(|e|e.to_string())?;
    let board = fs::canonicalize(board).map_err(|e|e.to_string())?;
    let cli = if cfg.runtime==Runtime::Nightly { &cfg.nightly_cli } else { &cfg.stable_cli };
    let version = command(cli,&["--version".into()],&out,"version",None)?;
    let mut svg = Vec::new();
    for i in 0..cfg.repeats {
        svg.push(command(cli,&["pcb".into(),"export".into(),"svg".into(),"--layers".into(),"F.Cu".into(),"--mode-single".into(),
            "--page-size-mode".into(),"2".into(),"--exclude-drawing-sheet".into(),"-o".into(),out.join(format!("cold-{i}.svg")).display().to_string(),board.display().to_string()],&out,&format!("cold-svg-{i}"),None)?);
    }
    let drc = command(cli,&["pcb".into(),"drc".into(),"--schematic-parity".into(),"--format".into(),"json".into(),"-o".into(),out.join("cli-drc.json").display().to_string(),board.display().to_string()],&out,"cli-drc",None)?;
    let ipc = if cfg.runtime==Runtime::Nightly { Some(nightly(&cfg,&board,&out).map_or_else(|e|json!({"error":e}),|v|v)) } else { None };
    let after = hashes(&source)?; let unchanged = before==after;
    let result = json!({"schema":"pcb.kicad-runtime-probe.v1","config":cfg,"acceptance":false,"source_unchanged":unchanged,
        "source_hashes":before,"runtime_version":version,"cold_svg":svg,"cli_drc":drc,"ipc":ipc});
    fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    if !unchanged { return Err("source files changed during probe".into()); }
    println!("{}",result);Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn config_requires_explicit_nightly_and_refuses_typos() {
        assert_eq!(Config::parse("{}").unwrap().runtime,Runtime::Stable);
        assert_eq!(Config::parse(r#"{"runtime":"nightly"}"#).unwrap().runtime,Runtime::Nightly);
        assert!(Config::parse(r#"{"runtime":"nightlly"}"#).is_err());
        assert!(Config::parse(r#"{"repeats":0}"#).is_err());
        assert!(Config::parse(r#"{"default_image":"changed"}"#).is_err());
    }
    #[test] fn copy_refuses_existing_destination_and_keeps_source_bytes() {
        let root = std::env::temp_dir().join(format!("runtime-probe-test-{}",std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("board.kicad_pcb");fs::write(&source,"source board").unwrap();
        fs::write(source.with_extension("kicad_pro"),"{}").unwrap();
        let before = hashes(&source).unwrap();
        let out = root.join("copy");let copied = stage_copy(&source,&out).unwrap();
        assert_eq!(fs::read(copied).unwrap(),b"source board");
        fs::write(out.join("keep"),"reviewed output").unwrap();
        assert!(stage_copy(&source,&out).is_err());
        assert_eq!(fs::read_to_string(out.join("keep")).unwrap(),"reviewed output");
        assert_eq!(hashes(&source).unwrap(),before);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn comparison_only_normalizes_unordered_group_members() {
        let a=json!({"groups":[{"items":["b","a"]}],"polygon":[[0,0],[1,0],[0,1]]});
        let b=json!({"groups":[{"items":["a","b"]}],"polygon":[[0,0],[1,0],[0,1]]});
        assert_eq!(comparable(a.clone()),comparable(b));
        let moved=json!({"groups":[{"items":["a","b"]}],"polygon":[[0,0],[0,1],[1,0]]});
        assert_ne!(comparable(a),comparable(moved),"ordered geometry must remain significant");
    }
}
