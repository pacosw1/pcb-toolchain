//! --seed, --checkpoint and --stall-passes (cargo test --release). The route tests run the whole CLI on the RouteModel of
//! CHECKIN-FRONT (fixtures/checkin_front.json, 14 parts, 8 negotiation passes) at 0.1 mm pitch: about 1 s a run.
use super::seed::{Jitter, Rng, shuffle_groups};
use super::*;

const MODEL: &str = include_str!("fixtures/checkin_front.json");

struct Dir(std::path::PathBuf);

impl Dir {
    fn new(tag: &str) -> Dir {
        let d = std::env::temp_dir().join(format!("iotroute-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("model.json"), MODEL).unwrap();
        Dir(d)
    }
    fn p(&self, f: &str) -> String {
        self.0.join(f).to_str().unwrap().to_string()
    }
    /// route with these flags into `out`; the bytes of the result
    fn route(&self, out: &str, flags: &[&str]) -> Vec<u8> {
        let mut a: Vec<String> = ["iotroute".to_string(), self.p("model.json"), self.p(out)].into();
        a.extend(["--pitch", "0.1", "--iters", "30"].iter().chain(flags).map(|s| s.to_string()));
        route_cli(&a);
        std::fs::read(self.p(out)).unwrap()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn json(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap()
}

/// The published SplitMix64 stream (seed 1234567): the same numbers on every machine.
#[test]
fn rng_is_splitmix64() {
    let mut r = Rng::new(1234567);
    let v: Vec<u64> = (0..5).map(|_| r.next()).collect();
    assert_eq!(v, [6457827717110365317, 3203168211198807973, 9817491932198370423, 4593380528125082431, 16408922859458223821]);
    assert!((0..1000).all(|_| (0.0..1.0).contains(&r.unit())));
}

#[test]
fn shuffle_keeps_the_groups_and_follows_the_seed() {
    let group = |n: usize| (n / 10) as u8;
    let base: Vec<usize> = (0..30).collect();
    let run = |s: u64| {
        let mut o = base.clone();
        shuffle_groups(&mut o, &group, &mut Rng::new(s));
        o
    };
    let a = run(1);
    assert_eq!(a, run(1), "same seed, same order");
    assert_ne!(a, run(2), "another seed, another order");
    assert_ne!(a, base);
    for g in 0..3 {
        let mut part = a[g * 10..(g + 1) * 10].to_vec();
        part.sort();
        assert_eq!(part, base[g * 10..(g + 1) * 10], "group {g} stays in its place");
    }
}

#[test]
fn jitter_is_seeded_bounded_and_empty_without_a_seed() {
    let f = |s: u64| Jitter::new(&mut Rng::new(s), 101, 81, 2, 0.05);
    let (a, b, c) = (f(5), f(5), f(6));
    let cells = 101 * 81 * 2;
    assert!((0..cells).all(|i| a.cell(i) == b.cell(i)), "same seed, same field");
    assert!((0..cells).any(|i| a.cell(i) != c.cell(i)), "another seed, another field");
    assert!((0..cells).all(|i| a.cell(i).abs() <= 0.125), "within AMP / 2 of 0");
    let mean = (0..cells).map(|i| a.cell(i)).sum::<f64>() / cells as f64;
    assert!(mean.abs() < 0.03, "mean near 0, so the search keeps its pace: {mean}");
    assert!((0..101 * 81).any(|i| a.via(i) != a.cell(i)), "the via sites have their own field");
    // neighbouring cells differ by little: the field moves a route to another channel, it does not make a rough cost
    assert!((1..101).all(|i| (a.cell(i) - a.cell(i - 1)).abs() < 0.01));
    let none = Jitter::default();
    assert_eq!((none.cell(7), none.via(7)), (0.0, 0.0));
}

/// The key rule: flags that do not act leave the route byte for byte as it is, and the run repeats itself.
#[test]
fn flags_off_and_watching_flags_do_not_change_the_route() {
    let d = Dir::new("off");
    let base = d.route("a.json", &[]);
    assert_eq!(base, d.route("b.json", &[]), "no seed: two runs");
    let ck = d.p("c.ckpt");
    assert_eq!(base, d.route("c.json", &["--checkpoint", &ck]), "the checkpoint only reads");
    assert_eq!(base, d.route("d.json", &["--stall-passes", "99"]), "a stall limit that never acts");
    assert!(json(&base)["notes"].as_array().unwrap().iter().all(|n| !n.as_str().unwrap().starts_with("seed")));
}

#[test]
fn a_seed_repeats_and_seeds_differ() {
    let d = Dir::new("seed");
    let base = d.route("base.json", &[]);
    let s1 = d.route("a.json", &["--seed", "1"]);
    assert_eq!(s1, d.route("b.json", &["--seed", "1"]), "same seed and input: same bytes");
    let s2 = d.route("c.json", &["--seed", "2"]);
    let s0 = d.route("d.json", &["--seed", "0"]);
    for (s, name) in [(&s1, "1"), (&s2, "2"), (&s0, "0")] {
        assert_ne!(*s, base, "seed {name} differs from no seed");
        let v = json(s);
        assert!(v["failed"].as_array().unwrap().is_empty(), "seed {name} routes the board: {}", v["failed"]);
        assert!(v["notes"].as_array().unwrap().iter().any(|n| *n == format!("seed {name}").as_str()), "seed {name} is in the notes");
    }
    assert_ne!(s1, s2);
    assert_ne!(s1, s0);
    let tr = |b: &[u8]| json(b)["tracks"].to_string();
    assert_ne!(tr(&s1), tr(&s2), "another copper, not only another note");
}

#[test]
fn checkpoint_is_one_complete_json_per_pass() {
    let d = Dir::new("ckpt");
    let ck = d.p("run.ckpt");
    let r = json(&d.route("a.json", &["--seed", "3", "--checkpoint", &ck]));
    assert!(!std::path::Path::new(&format!("{ck}.tmp")).exists(), "the temp file was renamed");
    let c: Value = serde_json::from_str(&std::fs::read_to_string(&ck).unwrap()).unwrap();
    assert_eq!(c["schema"], "iot-lab.route-checkpoint.v0");
    assert_eq!((c["state"].as_str(), c["stop"].as_str()), (Some("done"), Some("converged")));
    assert_eq!((c["seed"].as_u64(), c["pass"].as_u64()), (Some(3), r["passes"].as_u64()));
    assert_eq!(c["vias"].as_u64().unwrap() as usize, r["vias"].as_array().unwrap().len());
    assert_eq!((c["unrouted"].as_u64(), c["conflicts"]["pairs"].as_u64()), (Some(0), Some(0)));
    assert!(c["wire_mm"].as_f64().unwrap() > 0.0 && c["elapsed_s"].as_f64().unwrap() > 0.0);
    let hot = c["hot"].as_array().unwrap();
    assert!(!hot.is_empty() && hot.len() <= 8, "the negotiation left history");
    assert!(hot[0]["hist"].as_f64().unwrap() >= hot.last().unwrap()["hist"].as_f64().unwrap(), "hottest first");
    let e = &json(MODEL.as_bytes())["outline_bbox"];
    let x = hot[0]["x"].as_f64().unwrap();
    assert!(x >= e[0].as_f64().unwrap() && x <= e[2].as_f64().unwrap(), "x {x} is a board coordinate in mm");
}

/// FIPS 180-2 examples, one of them over two blocks, and a length that needs a padding block of its own.
#[test]
fn sha256_matches_the_standard() {
    use super::checkpoint::sha256;
    assert_eq!(sha256(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(sha256(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!(sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    assert_eq!(sha256(&[b'a'; 1000]), "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
}

/// The bind block names the run: the model file, its rules and its geometry apart, the flags, the source given by iotroute run.
#[test]
fn checkpoint_binds_the_run() {
    let d = Dir::new("bind");
    let ck = d.p("run.ckpt");
    d.route("a.json", &["--seed", "4", "--checkpoint", &ck, "--source-sha", "abc123"]);
    let c: Value = serde_json::from_str(&std::fs::read_to_string(&ck).unwrap()).unwrap();
    let b = &c["bind"];
    assert_eq!(b["model_sha256"].as_str().unwrap(), super::checkpoint::sha256(MODEL.as_bytes()));
    assert_eq!(b["source_sha256"], "abc123");
    assert_eq!(b["binary_sha256"].as_str().unwrap().len(), 64);
    assert_eq!(b["args"][1], "0.1");
    let bind = |v: &Value| super::checkpoint::Bind::new("", v, None, &[]);
    let hash = |x: &super::checkpoint::Bind, k: &str| serde_json::to_value(x).unwrap()[k].clone();
    let m0 = json(MODEL.as_bytes());
    let (mut moved, mut rule, mut path) = (m0.clone(), m0.clone(), m0.clone());
    moved["pads"][0]["x"] = 1.5.into();
    rule["setup"]["changed"] = 1.into();
    path["pcb"] = "/elsewhere/X.kicad_pcb".into();
    let (a, m, r, p) = (bind(&m0), bind(&moved), bind(&rule), bind(&path));
    assert_ne!(hash(&a, "geometry_sha256"), hash(&m, "geometry_sha256"));
    assert_eq!(hash(&a, "rules_sha256"), hash(&m, "rules_sha256"), "a moved pad is no rule change");
    assert_ne!(hash(&a, "rules_sha256"), hash(&r, "rules_sha256"));
    assert_eq!(hash(&a, "geometry_sha256"), hash(&r, "geometry_sha256"));
    assert_eq!((hash(&a, "rules_sha256"), hash(&a, "geometry_sha256")), (hash(&p, "rules_sha256"), hash(&p, "geometry_sha256")), "where the board file lies is neither");
}

/// --max-time ends at a pass end with the best pass restored and says so. 0.001 s: the first pass is already over it.
#[test]
fn a_timed_out_run_says_so_and_keeps_its_best_pass() {
    let d = Dir::new("time");
    let ck = d.p("run.ckpt");
    let r = json(&d.route("a.json", &["--max-time", "0.001", "--checkpoint", &ck]));
    let c: Value = serde_json::from_str(&std::fs::read_to_string(&ck).unwrap()).unwrap();
    assert_eq!((c["state"].as_str(), c["stop"].as_str(), c["pass"].as_u64()), (Some("done"), Some("max-time"), Some(1)));
    assert_eq!((r["passes"].as_u64(), c["best"]["pass"].as_u64()), (Some(1), Some(1)));
    assert_eq!(c["conflicts"]["pairs"], 0, "the written copper is legal");
    assert!(!r["tracks"].as_array().unwrap().is_empty(), "the incumbent is written");
}

/// No present-cost growth and no history: nothing changes between passes, so the conflicts stay and the run has to stop.
#[test]
fn stall_passes_stops_and_says_why() {
    let d = Dir::new("stall");
    let ck = d.p("run.ckpt");
    let frozen = ["--pres-mult", "1", "--hist", "0"];
    let mut flags = frozen.to_vec();
    flags.extend(["--stall-passes", "2", "--checkpoint", ck.as_str()]);
    let r = json(&d.route("a.json", &flags));
    let passes = r["passes"].as_u64().unwrap();
    assert!(passes < 30, "stopped at pass {passes}");
    assert!(r["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().starts_with("stopped early: no progress for 2 passes")));
    let c: Value = serde_json::from_str(&std::fs::read_to_string(&ck).unwrap()).unwrap();
    assert_eq!(c["stop"], "stall-passes");
    assert_eq!(c["passes_since_best"], 2);
    let free = json(&d.route("b.json", &frozen));
    assert!(free["passes"].as_u64().unwrap() > passes, "default off: the same run goes on");
}
