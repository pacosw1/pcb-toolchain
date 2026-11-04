//! Durable pass-boundary state for the negotiation. Progress checkpoints are separate.
use super::*;

const SCHEMA: &str = "iot-lab.route-resume.v1";
type NetState = Vec<(Option<String>, u32)>;
type Best = Option<((usize, usize), usize, Vec<Shape>, NetState)>;

pub(crate) fn cpu_seconds() -> Result<f64, String> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let usage = unsafe { usage.assume_init() };
    let secs = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.0;
    Ok(secs(usage.ru_utime) + secs(usage.ru_stime))
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Snapshot {
    schema: String,
    binding: String,
    pass: usize,
    elapsed_s: f64,
    cpu_s: f64,
    shapes: Vec<Shape>,
    hist: Vec<f32>,
    vhist: Vec<f32>,
    lhist: Vec<f32>,
    pres: f32,
    max_clearance: f64,
    dead: Vec<(Vec<usize>, String)>,
    todo: Vec<usize>,
    state: NetState,
    best: Best,
    limited_prev: Vec<usize>,
    stall: usize,
    stall_sig: Option<Vec<(usize, Option<String>)>>,
    pour_seen: Vec<(String, usize)>,
    hard_doors: usize,
    moves: Vec<u32>,
    since_best: usize,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    sha256: String,
    payload: Box<serde_json::value::RawValue>,
    #[serde(default)]
    terminal: Option<String>,
}

pub(crate) fn check_paths(paths: &[(&str, &str)]) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let mut seen = Vec::new();
    for &(role, name) in paths {
        let path = std::path::Path::new(name);
        let canonical = match std::fs::canonicalize(path) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // A dangling symlink must not be treated as an unused destination.
                if std::fs::symlink_metadata(path).is_ok() { return Err(format!("{role}: dangling symlink")); }
                let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
                let file = path.file_name().ok_or_else(|| format!("{role}: invalid path"))?;
                std::fs::canonicalize(parent).map_err(|e| format!("{role}: {e}"))?.join(file)
            }
            Err(e) => return Err(format!("{role}: {e}")),
        };
        let inode = std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()));
        for (old_role, old_name, old_path, old_inode) in &seen {
            let same = *old_path == canonical || (inode.is_some() && *old_inode == inode);
            let permitted = (role == "resume input" && *old_role == "resume output") || (role == "resume output" && *old_role == "resume input");
            let symlink = std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink());
            if same && !(permitted && *old_name == name && !symlink) { return Err(format!("{role} aliases {old_role}")); }
        }
        seen.push((role, name, canonical, inode));
    }
    Ok(())
}

// Only execution limits and artifact paths may differ when resuming. Input bytes, binary, and all
// routing-affecting flags must match. --reuse is rejected by the caller because it reads another file.
pub(crate) fn binding(model: &str, args: &[String]) -> Result<String, String> {
    let binary = std::env::current_exe().and_then(std::fs::read).map_err(|e| e.to_string())?;
    let mut fields = vec![checkpoint::sha256(model.as_bytes()), checkpoint::sha256(&binary)];
    for pair in args.chunks_exact(2) {
        if !matches!(pair[0].as_str(), "--iters" | "--passes" | "--max-time" | "--checkpoint" | "--resume" | "--resume-save") {
            fields.extend_from_slice(pair);
        }
    }
    Ok(checkpoint::sha256(&serde_json::to_vec(&fields).map_err(|e| e.to_string())?))
}

impl Snapshot {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture(binding: &str, pass: usize, elapsed_s: f64, cpu_s: f64, ctx: &Ctx, todo: &[usize], state: &NetState, best: &Best,
        limited_prev: &[usize], stall: usize, stall_sig: &Option<Vec<(usize, Option<String>)>>, pour_seen: &[(String, usize)],
        hard_doors: usize, moves: &[u32], since_best: usize) -> Self {
        Self { schema: SCHEMA.into(), binding: binding.into(), pass, elapsed_s, cpu_s, shapes: ctx.bd.shapes.clone(), hist: ctx.gr.hist.clone(),
            vhist: ctx.gr.vhist.clone(), lhist: ctx.gr.lhist.clone(), pres: ctx.gr.pres, max_clearance: ctx.bd.maxc, dead: ctx.dead.clone(),
            todo: todo.to_vec(), state: state.clone(), best: best.clone(), limited_prev: limited_prev.to_vec(), stall,
            stall_sig: stall_sig.clone(), pour_seen: pour_seen.to_vec(), hard_doors, moves: moves.to_vec(), since_best }
    }

    pub(crate) fn save(&self, path: &str) -> Result<(), String> {
        let payload = serde_json::to_string(self).map_err(|e| e.to_string())?;
        let envelope = Envelope { sha256: checkpoint::sha256(payload.as_bytes()), terminal: None,
            payload: serde_json::value::RawValue::from_string(payload).map_err(|e| e.to_string())? };
        Self::put(path, envelope)
    }

    pub(crate) fn terminal(path: &str, reason: &str) -> Result<(), String> {
        let payload = "null".to_string();
        Self::put(path, Envelope { sha256: checkpoint::sha256(payload.as_bytes()), terminal: Some(reason.into()),
            payload: serde_json::value::RawValue::from_string(payload).map_err(|e| e.to_string())? })
    }

    fn put(path: &str, envelope: Envelope) -> Result<(), String> {
        use std::io::Write;
        let tmp = format!("{path}.tmp.{}", std::process::id());
        let bytes = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
        let parent = std::path::Path::new(path).parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
        std::fs::File::open(parent).and_then(|d| d.sync_all()).map_err(|e| e.to_string())
    }

    fn read(path: &str) -> Result<Self, String> {
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        let envelope: Envelope = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        if checkpoint::sha256(envelope.payload.get().as_bytes()) != envelope.sha256 {
            return Err("checkpoint digest mismatch".into());
        }
        if let Some(reason) = envelope.terminal { return Err(format!("checkpoint is terminal: {reason}")); }
        serde_json::from_str(envelope.payload.get()).map_err(|e| e.to_string())
    }

    pub(crate) fn load(path: &str, binding: &str, ctx: &Ctx, max_passes: usize) -> Result<Self, String> {
        let s = Self::read(path)?;
        let nn = ctx.bd.nets.len();
        let valid_net = |n: &usize| *n < nn;
        if s.schema != SCHEMA || s.binding != binding { return Err("checkpoint schema or run binding differs".into()); }
        if s.pass == 0 || s.pass >= max_passes { return Err("--iters must exceed saved pass".into()); }
        if !s.elapsed_s.is_finite() || s.elapsed_s < 0.0 || !s.cpu_s.is_finite() || s.cpu_s < 0.0 || !s.pres.is_finite() || s.pres < 0.0 || !s.max_clearance.is_finite() || s.max_clearance < ctx.bd.maxc {
            return Err("checkpoint accounting or present cost invalid".into());
        }
        if s.hist.len() != ctx.gr.hist.len() || s.vhist.len() != ctx.gr.vhist.len() || (!s.lhist.is_empty() && s.lhist.len() != nn * ctx.gr.nr)
            || s.state.len() != nn || s.dead.len() != nn || s.moves.len() != nn || !s.todo.iter().all(valid_net) || !s.limited_prev.iter().all(valid_net)
            || s.stall_sig.as_ref().is_some_and(|v| v.iter().any(|(n, _)| !valid_net(n))) || s.best.is_none() {
            return Err("checkpoint dimensions or state invalid".into());
        }
        let valid_shapes = |v: &[Shape]| v.iter().all(|x| x.owner >= -1 && x.owner < nn as i32 && x.net >= -1 && x.net < nn as i32);
        if !valid_shapes(&s.shapes)
            || s.shapes.iter().any(|shape| shape.alive && shape.owner < 0 && (!shape.clr.is_finite() || shape.clr > s.max_clearance))
            || s.dead.iter().flat_map(|(ids, _)| ids).any(|&id| id >= s.shapes.len()) {
            return Err("checkpoint shape indices invalid".into());
        }
        if let Some((_, pass, shapes, states)) = &s.best {
            if *pass == 0 || *pass > s.pass || states.len() != nn || !valid_shapes(shapes) {
                return Err("checkpoint incumbent invalid".into());
            }
        }
        Ok(s)
    }

    #[allow(clippy::type_complexity)]
    pub(crate) fn restore(self, ctx: &mut Ctx) -> (usize, f64, f64, Vec<usize>, NetState, Best, Vec<usize>, usize,
        Option<Vec<(usize, Option<String>)>>, Vec<(String, usize)>, usize, Vec<u32>, usize) {
        ctx.bd.shapes = self.shapes;
        ctx.bd.maxc = self.max_clearance;
        ctx.gr.hist = self.hist; ctx.gr.vhist = self.vhist; ctx.gr.lhist = self.lhist; ctx.gr.pres = self.pres;
        ctx.dead = self.dead;
        (self.pass, self.elapsed_s, self.cpu_s, self.todo, self.state, self.best, self.limited_prev, self.stall, self.stall_sig,
         self.pour_seen, self.hard_doors, self.moves, self.since_best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_covers_inputs_and_routing_flags() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let a = binding("model", &args(&["--seed", "4", "--iters", "2", "--resume-save", "a"])).unwrap();
        let b = binding("model", &args(&["--seed", "4", "--iters", "30", "--resume", "a"])).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, binding("other", &args(&["--seed", "4"])).unwrap());
        assert_ne!(a, binding("model", &args(&["--seed", "5"])).unwrap());
        assert_ne!(a, binding("model", &args(&["--seed", "4", "--source-sha", "other"])).unwrap());
    }
    #[test]
    fn snapshot_roundtrips_float_history_and_copper() {
        let s = Snapshot { schema: SCHEMA.into(), binding: "digest".into(), pass: 1, elapsed_s: 2.0, cpu_s: 1.0,
            shapes: vec![Shape { net: 0, owner: 0, geo: Geo::Seg(1.1, 2.2, 3.3, 4.4, 0.075), clr: 0.15,
                layers: 1, drill: 0.0, kind: Kind::Track, alive: true, grp: 0 }],
            hist: vec![0.3f32], vhist: vec![0.1f32], lhist: vec![], pres: 0.75, max_clearance: 0.15, dead: vec![(vec![], String::new())],
            todo: vec![0], state: vec![(None, 1)], best: None, limited_prev: vec![], stall: 0, stall_sig: None,
            pour_seen: vec![], hard_doors: 0, moves: vec![1], since_best: 0 };
        let got: Snapshot = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(got.hist[0].to_bits(), s.hist[0].to_bits());
        assert_eq!(got.vhist[0].to_bits(), s.vhist[0].to_bits());
        assert!(matches!(got.shapes[0].geo, Geo::Seg(1.1, 2.2, 3.3, 4.4, 0.075)));
        let path = std::env::temp_dir().join(format!("resume-test-{}.json", std::process::id()));
        let p = path.to_str().unwrap();
        s.save(p).unwrap();
        assert!(Snapshot::read(p).is_ok());
        let damaged = std::fs::read_to_string(p).unwrap().replace("\"pass\":1", "\"pass\":2");
        std::fs::write(p, damaged).unwrap();
        assert!(Snapshot::read(p).is_err());
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn terminal_checkpoint_cannot_be_resumed() {
        let p = std::env::temp_dir().join(format!("resume-terminal-{}", std::process::id()));
        Snapshot::terminal(p.to_str().unwrap(), "converged").unwrap();
        assert!(Snapshot::read(p.to_str().unwrap()).err().unwrap().contains("terminal: converged"));
        Snapshot::terminal(p.to_str().unwrap(), "hard-fails").unwrap();
        assert!(Snapshot::read(p.to_str().unwrap()).err().unwrap().contains("terminal: hard-fails"));
        std::fs::remove_file(p).unwrap();
    }
    #[test]
    fn rejects_path_aliases_including_symlinks_and_hardlinks() {
        use std::os::unix::fs::symlink;
        let d = std::env::temp_dir().join(format!("resume-paths-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let model = d.join("model"); let sym = d.join("sym"); let hard = d.join("hard");
        std::fs::write(&model, "model").unwrap(); symlink(&model, &sym).unwrap(); std::fs::hard_link(&model, &hard).unwrap();
        let m = model.to_str().unwrap(); let s = sym.to_str().unwrap(); let h = hard.to_str().unwrap();
        assert!(check_paths(&[("model", m), ("resume output", m)]).is_err());
        assert!(check_paths(&[("model", m), ("resume output", s)]).is_err());
        assert!(check_paths(&[("model", m), ("resume output", h)]).is_err());
        assert!(check_paths(&[("resume input", m), ("resume output", m)]).is_ok());
        assert!(check_paths(&[("resume input", m), ("resume output", s)]).is_err());
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn restores_clearance_reach_for_a_reserved_hard_door() {
        let m = serde_json::json!({"copper_layers":["F.Cu","In1.Cu","B.Cu"], "plane_layers":[], "outline_bbox":[0,0,20,10],
            "setup":{"edge_clearance":0.3}, "classes":{"Default":{"width":0.15,"clearance":0.15,"via":0.6,"drill":0.3}},
            "nets":{"A":{"class":"Default","width":0.15,"clearance":0.15,"layers":["F.Cu"]},
                    "B":{"class":"Default","width":0.15,"clearance":0.15,"layers":["F.Cu"]}}, "pads":[], "copper":[]});
        let mut bd = load(&m, DEF_HOLE_CLR);
        let other = bd.nets.iter().position(|n| n.name == "B").unwrap();
        let pour_net = bd.nets.iter().position(|n| n.name == "A").unwrap() as i32;
        bd.pours.push(pour::Pour { net: pour_net, layer: 0, clr: 2.0, gap: 0.2, sw: 0.2, mt: 0.2,
            bbox: [0.,0.,20.,10.], min_spokes: 1, pads: vec![], net_clr: Default::default(), island_mode: 0 });
        let o = super::super::tests_v6::opts();
        let mut ctx = super::super::tests_v8::ctx_of(&mut bd, &o);
        let fault = pour::Fault { pour: 0, layer: 0, pad: "synthetic".into(), good: 0, ignored: 0,
            door: vec![(5.,5.),(6.,5.)], path: vec![(5.,5.),(6.,5.)], walls: vec![other], fixed: false };
        ctx.reserve_door(&fault);
        assert_eq!(ctx.bd.maxc, 2.0);
        let nn = ctx.bd.nets.len();
        let state = vec![(None, 0); nn]; let best = Some(((1,1), 1, ctx.bd.shapes.clone(), state.clone()));
        let s = Snapshot::capture("bind", 1, 1.0, 0.5, &ctx, &[other], &state, &best, &[], 0, &None, &[], 1, &vec![0;nn], 0);
        ctx.bd.maxc = 0.15;
        s.restore(&mut ctx);
        ctx.bd.compact();
        assert_eq!(ctx.bd.maxc, 2.0);
        assert_eq!(ctx.bd.track_cost(other, 0, 5.5, 6.7, 0.075, 0.15, None), -1);
    }
    #[test]
    fn resume_replays_crossing_synthetic_nets() {
        let d = std::env::temp_dir().join(format!("resume-route-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = |name: &str| d.join(name).to_str().unwrap().to_string();
        let m = serde_json::json!({
            "copper_layers":["F.Cu", "B.Cu"], "plane_layers":[], "outline_bbox":[0,0,10,10],
            "setup":{"edge_clearance":0.25},
            "classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
            "nets":{"A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]},
                    "B":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]}},
            "pads":[
                {"ref":"J1","num":"1","net":"A","x":0.6,"y":5.0,"bbox":[0.3,4.7,0.9,5.3],"layers":["F.Cu"]},
                {"ref":"J2","num":"1","net":"A","x":9.4,"y":5.0,"bbox":[9.1,4.7,9.7,5.3],"layers":["F.Cu"]},
                {"ref":"J3","num":"1","net":"B","x":5.0,"y":0.6,"bbox":[4.7,0.3,5.3,0.9],"layers":["F.Cu"]},
                {"ref":"J4","num":"1","net":"B","x":5.0,"y":9.4,"bbox":[4.7,9.1,5.3,9.7],"layers":["F.Cu"]}
            ], "copper":[]
        });
        std::fs::write(p("model.json"), m.to_string()).unwrap();
        let run = |out: &str, extra: &[&str]| {
            let mut a = vec!["iotroute".into(), p("model.json"), p(out), "--pitch".into(), "0.2".into(), "--seed".into(), "7".into()];
            a.extend(extra.iter().map(|s| s.to_string()));
            route_cli(&a);
            serde_json::from_slice::<Value>(&std::fs::read(p(out)).unwrap()).unwrap()
        };
        let snapshot = p("state.json");
        let full = run("full.json", &["--iters", "5"]);
        run("partial.json", &["--iters", "1", "--resume-save", &snapshot]);
        assert!(std::path::Path::new(&snapshot).exists(), "the first pass must have unresolved work");
        let resumed = run("resumed.json", &["--iters", "5", "--resume", &snapshot]);
        for key in ["tracks", "vias", "failed", "passes"] { assert_eq!(full[key], resumed[key], "{key}"); }
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn converged_run_invalidates_older_snapshot() {
        let d = std::env::temp_dir().join(format!("resume-converged-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let model = d.join("model.json"); let out = d.join("out.json"); let save = d.join("state.json");
        let m = serde_json::json!({"copper_layers":["F.Cu", "B.Cu"], "plane_layers":[], "outline_bbox":[0,0,10,10],
            "setup":{"edge_clearance":0.25}, "classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
            "nets":{"A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]}},
            "pads":[{"ref":"J1","num":"1","net":"A","x":5.0,"y":5.0,"bbox":[4.7,4.7,5.3,5.3],"layers":["F.Cu"]}], "copper":[]});
        std::fs::write(&model, m.to_string()).unwrap();
        std::fs::write(&save, "old snapshot").unwrap();
        route_cli(&["iotroute".into(), model.to_str().unwrap().into(), out.to_str().unwrap().into(),
            "--pitch".into(), "0.2".into(), "--resume-save".into(), save.to_str().unwrap().into()]);
        assert!(Snapshot::read(save.to_str().unwrap()).err().unwrap().contains("terminal: converged"));
        std::fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn fixed_obstruction_invalidates_older_snapshot() {
        let d = std::env::temp_dir().join(format!("resume-hardfail-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let model = d.join("model.json"); let out = d.join("out.json"); let save = d.join("state.json"); let progress = d.join("progress.json");
        let m = serde_json::json!({"copper_layers":["F.Cu", "B.Cu"], "plane_layers":[], "outline_bbox":[0,0,10,10],
            "setup":{"edge_clearance":0.25}, "classes":{"Default":{"width":0.2,"clearance":0.2,"via":0.6,"drill":0.3}},
            "nets":{"A":{"class":"Default","width":0.2,"clearance":0.2,"layers":["F.Cu"]}},
            "pads":[{"ref":"J1","num":"1","net":"A","x":2.0,"y":5.0,"bbox":[1.7,4.7,2.3,5.3],"layers":["F.Cu"]},
                    {"ref":"J2","num":"1","net":"A","x":8.0,"y":5.0,"bbox":[7.7,4.7,8.3,5.3],"layers":["F.Cu"]}],
            "keepouts":[{"bbox":[4.0,0.0,6.0,10.0],"rect":true,"tracks":true,"vias":true,"layers":["F.Cu","B.Cu"]}], "copper":[]});
        std::fs::write(&model, m.to_string()).unwrap();
        std::fs::write(&save, "old snapshot").unwrap();
        route_cli(&["iotroute".into(), model.to_str().unwrap().into(), out.to_str().unwrap().into(),
            "--pitch".into(), "0.2".into(), "--iters".into(), "20".into(), "--checkpoint".into(), progress.to_str().unwrap().into(),
            "--resume-save".into(), save.to_str().unwrap().into()]);
        let progress: Value = serde_json::from_slice(&std::fs::read(progress).unwrap()).unwrap();
        assert_eq!(progress["stop"], "converged");
        assert_eq!(progress["unrouted"], 1);
        assert!(Snapshot::read(save.to_str().unwrap()).err().unwrap().contains("terminal: converged"));
        std::fs::remove_dir_all(d).unwrap();
    }
}
