use super::*;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};

fn config() -> Value {
    json!({"schema":SCHEMA,"layers":["F.Cu","B.Cu"],"only_nets":["/A","/B"],"passes":7,"threads":1,"timeout_s":20,"optimizer":"off","max_repairs":0})
}
fn write(path: &Path, value: &Value) {
    atomic_json(path, value).unwrap();
}

struct Fixture {
    root: PathBuf,
    native: PathBuf,
    output: PathBuf,
    env: Environment,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "routing-trial-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let native = root.join("hardware-design/boards/X/cad/X.kicad_pcb");
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        for suffix in ["kicad_pcb", "kicad_pro", "kicad_dru", "kicad_sch"] {
            fs::write(native.with_extension(suffix), format!("fixture {suffix}")).unwrap();
        }
        let tools = root.join("tools");
        fs::create_dir_all(tools.join("lib")).unwrap();
        let original = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        for name in ["route-features.json", "lib/gate-core.mjs"] {
            fs::copy(original.join(name), tools.join(name)).unwrap();
        }
        write(
            &root.join("hardware-design/boards/X/gate.json"),
            &json!({"project":"cad/X","stage":"G4","checks":{"erc":true,"drc":true,"paths":"paths.json","viapads":{},"kicad_happy":{},"port_labels":true}}),
        );
        let executable = root.join("fixture-runtime");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' 'fixture runtime 1'\n",
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        let mut env = Environment::from([
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), text(&root)),
            ("IOT_CPU_BUDGET".into(), "1".into()),
            ("IOT_MEMORY_BUDGET_GIB".into(), "2".into()),
        ]);
        for name in ["IOTROUTE_BIN", "ROUTE_COVERAGE_BIN", "KICAD_API_CLI", "FASTROUTE_BIN", "KICAD_CLI"] {
            env.insert(name.into(), text(&executable));
        }
        let output = root.join("run/operation/router");
        Self {
            root,
            native,
            output,
            env,
        }
    }
    fn request(&self, config: Value) -> PrepareRequest {
        let bindings = [
            "hardware-design/boards/X/gate.json",
            "tools/lib/gate-core.mjs",
        ]
        .into_iter()
        .map(|name| (PathBuf::from(name), hash(&self.root.join(name)).unwrap()))
        .collect();
        PrepareRequest {
            root: self.root.clone(),
            native: self.native.clone(),
            output: self.output.clone(),
            config,
            total_timeout_s: 30.0,
            board: Some("X".into()),
            runtime: Runtime::Native,
            gate: GateAdmission {
                stage: "G4".into(),
                inputs: bindings,
            },
            backend: None,
        }
    }
    fn prepared(&self) -> Prepared {
        prepare(self.request(config()), &self.env).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct RejectThermals;
impl ThermalVerifier for RejectThermals {
    fn validate_capability(
        &mut self,
        _: &Value,
        _: &Path,
        _: &Path,
        _: &[String],
    ) -> Result<Value> {
        Err("unexpected thermal verification".into())
    }
    fn discharge(&mut self, _: &Value, _: &Path, _: &Path, _: &Path) -> Result<Value> {
        Err("unexpected thermal discharge".into())
    }
}

fn producer(prepared: &Prepared) {
    let output = &prepared.output;
    fs::create_dir_all(output).unwrap();
    let configuration = json!({"board":prepared.native,"outdir":output,"passes":7,"layers":"F.Cu,B.Cu","only_nets":"/A,/B","threads":1,"max_time":20,
        "optimizer":"off","preflight":true,"skip_net":"","plane_nets":"","gnd_vias":false,"route_planes":false,"unlock_nets":"","set":[],"neck_um":0});
    write(
        &output.join("input-manifest.json"),
        &json!({"configuration":configuration,"board_sha256":hash(&prepared.native).unwrap(),
        "router_sha256":prepared.policy["runtime"]["tools"]["router"]["sha256"],"features":prepared.policy["effort"]["feature_policy"]}),
    );
    write(
        &output.join("backend-policy.json"),
        &json!({"mode":"legacy-unverified","qualified":false}),
    );
    let dsn = output.join("board.dsn");
    fs::write(&dsn, "fixture model").unwrap();
    let command = json!(["fastroute", "-de", dsn, "-do", output.join("board.ses")]);
    let coverage = output.join("rule-coverage.json");
    write(
        &coverage,
        &json!({"status":"passed","solver_launch_allowed":true,"dsn":{"path":dsn,"sha256":hash(&dsn).unwrap()},
        "backend_command":command,"backend_command_sha256":sha256::sha256(ascii_json(&command).as_bytes()),"inputs":{text(&prepared.native):hash(&prepared.native).unwrap()}}),
    );
    write(
        &output.join("effective-configuration.json"),
        &json!({"configuration":configuration,"backend_policy":{"mode":"legacy-unverified","qualified":false},
        "backend_resources":{"global_rayon_threads":1,"autorouter_workers":1,"optimizer_workers":1},"rule_coverage":{"path":coverage,"sha256":hash(&coverage).unwrap()},
        "dsn_sha256":hash(&dsn).unwrap(),"command":command}),
    );
    let candidate = output.join("routed.kicad_pcb");
    fs::write(&candidate, "fixture candidate").unwrap();
    write(
        &output.join("outcome.json"),
        &json!({"status":"complete","board_sha256":hash(&candidate).unwrap(),"optimizer":"off"}),
    );
}
fn edit(path: &Path, change: impl FnOnce(&mut Value)) {
    let mut value = read(path).unwrap();
    change(&mut value);
    write(path, &value);
}
fn reseal_coverage(prepared: &Prepared) {
    edit(
        &prepared.output.join("effective-configuration.json"),
        |stage| {
            stage["rule_coverage"]["sha256"] =
                json!(hash(&prepared.output.join("rule-coverage.json")).unwrap())
        },
    );
}

#[test]
fn policy_is_exact_typed_and_bounded() {
    assert_eq!(json!(validate(config(), 30.0).unwrap()), config());
    for (key, value) in [
        ("threads", json!(true)),
        ("passes", json!(1.0)),
        ("max_repairs", json!(1)),
        ("timeout_s", json!(0)),
        ("optimizer", json!("always")),
        ("layers", json!(["In31.Cu"])),
        ("layers", json!(["In01.Cu"])),
        ("only_nets", json!(["/A*"])),
        ("only_nets", json!(["/A", "/A"])),
        ("unknown", json!(false)),
    ] {
        let mut invalid = config();
        invalid[key] = value;
        assert!(validate(invalid, 30.0).is_err(), "accepted {key}");
    }
    assert!(validate(config(), 19.0).is_err());
    assert!(validate(config(), f64::INFINITY).is_err());
    let mut thermal = config();
    thermal["schema"] = json!(THERMAL_SCHEMA);
    assert!(validate(thermal.clone(), 30.0).is_err());
    thermal["thermal_verification"] = json!("native-checkback");
    assert!(validate(thermal, 30.0).unwrap().thermal());
    assert_eq!(
        ascii_json(&json!(["café", "\u{1f4a1}"])),
        "[\"caf\\u00e9\",\"\\ud83d\\udca1\"]"
    );
}

#[test]
fn inspect_receipt_matches_hostname_readonly_mount_and_exact_cgroup_quota() {
    use context::{Limits, validate_context};
    let raw = json!({"Id":"a".repeat(64),"Image":"sha256:".to_owned()+&"b".repeat(64),"Config":{"Hostname":"fixture"},
        "Mounts":[{"Destination":"/input","RW":false}],"HostConfig":{"NetworkMode":"none","NanoCpus":2_000_000_000u64,"Memory":2_147_483_648u64}});
    let observed = Limits {
        cpu: Some(Some((200_000, 100_000))),
        memory: Some(Some(2_147_483_648)),
        affinity: Some(2),
    };
    let parse = |value: &Value, limits: Limits| {
        validate_context(
            PathBuf::from("/input/inspect.json"),
            serde_json::to_vec(value).unwrap(),
            "fixture",
            limits,
        )
    };
    let actual = parse(&raw, observed.clone()).unwrap();
    assert_eq!(actual.cpus, 2.0);
    assert_eq!(actual.memory_bytes, 2_147_483_648);
    let mut writable = raw.clone();
    writable["Mounts"][0]["RW"] = json!(true);
    assert!(
        parse(&writable, observed.clone())
            .unwrap_err()
            .contains("read-only")
    );
    let mut wrong = observed.clone();
    wrong.cpu = Some(Some((1, 1)));
    assert!(parse(&raw, wrong).unwrap_err().contains("cgroup"));
    let mut affinity = observed.clone();
    affinity.affinity = Some(1);
    assert!(parse(&raw, affinity).unwrap_err().contains("affinity"));
    let mut network = raw.clone();
    network["HostConfig"]["NetworkMode"] = json!("bridge");
    assert!(
        parse(&network, observed)
            .unwrap_err()
            .contains("network-none")
    );
}

#[test]
fn native_identity_is_repeatable_and_honest_about_enforcement() {
    let env = Environment::from([
        ("IOT_CPU_BUDGET".into(), "1".into()),
        ("IOT_MEMORY_BUDGET_GIB".into(), "2".into()),
    ]);
    let context = native_execution_context(&env).unwrap();
    assert_eq!(context.raw, native_execution_context(&env).unwrap().raw);
    let value: Value = serde_json::from_slice(&context.raw).unwrap();
    assert_eq!(value["memory_is_hard_limit"], false);
    assert_eq!(value["network_isolated"], false);
    assert_eq!(context.identity, Some(sha256::sha256(&context.raw)));
}

#[test]
fn preparation_binds_inputs_and_preserves_explicit_controls() {
    let f = Fixture::new();
    let p = f.prepared();
    assert_eq!(p.command[2], text(&f.native));
    assert_eq!(p.command[3], text(&f.output));
    assert_eq!(p.env["IOT_RESOURCE_CPU"], "1");
    assert_eq!(p.env["IOT_MEMORY_BUDGET_GIB"], "2.0");
    assert_eq!(p.policy["resources"]["memory_is_hard_limit"], false);
    assert_eq!(p.policy["qualified"], false);
    assert!(!p.command.iter().any(|arg| arg == "node"));
    assert_eq!(read(&p.policy_path).unwrap(), p.policy);
    assert!(
        prepare(f.request(config()), &f.env)
            .unwrap_err()
            .contains("receipts must be new")
    );
}

#[test]
fn stale_gate_or_loader_override_stops_before_probing() {
    let f = Fixture::new();
    let mut request = f.request(config());
    request.gate.inputs.insert(
        PathBuf::from("hardware-design/boards/X/gate.json"),
        "changed".into(),
    );
    assert!(
        prepare(request, &f.env)
            .unwrap_err()
            .contains("input/tool changed")
    );
    let mut env = f.env.clone();
    env.insert("ROUTE_FEATURES_FILE".into(), "elsewhere".into());
    assert!(
        prepare(f.request(config()), &env)
            .unwrap_err()
            .contains("feature overrides")
    );
    assert!(!f.output.parent().unwrap().exists());
}

#[test]
fn a_verified_invocation_still_requires_native_gate_acceptance() {
    let f = Fixture::new();
    let p = f.prepared();
    producer(&p);
    let result = finalize(&p, 0, &mut RejectThermals).unwrap();
    assert_eq!(result["status"], "passed");
    assert_eq!(result["controls_verified"], true);
    assert_eq!(result["qualified"], false);
    assert_eq!(result["native_gate_required"], true);
    assert_eq!(
        result["candidate"],
        json!(p.output.join("routed.kicad_pcb"))
    );
    let recorded = read(&p.policy_path).unwrap();
    assert_eq!(recorded["controls"]["status"], "observed");
    assert_eq!(
        finalize(&p, 3, &mut RejectThermals).unwrap()["status"],
        "failed"
    );
}

#[test]
fn changed_effective_inputs_worker_caps_and_outcomes_are_rejected() {
    let cases: [(&str, &str, &str, Value); 8] = [
        ("input-manifest.json", "configuration", "threads", json!(2)),
        ("input-manifest.json", "", "board_sha256", json!("wrong")),
        ("input-manifest.json", "", "router_sha256", json!("wrong")),
        (
            "effective-configuration.json",
            "backend_resources",
            "autorouter_workers",
            json!(2),
        ),
        (
            "effective-configuration.json",
            "configuration",
            "passes",
            json!(8),
        ),
        ("outcome.json", "", "optimizer", json!("if-routed")),
        ("outcome.json", "", "board_sha256", json!("wrong")),
        ("outcome.json", "", "status", json!("stuck")),
    ];
    for (name, section, key, value) in cases {
        let f = Fixture::new();
        let p = f.prepared();
        producer(&p);
        edit(&p.output.join(name), |row| {
            if section.is_empty() {
                row[key] = value
            } else {
                row[section][key] = value
            }
        });
        assert!(
            finalize(&p, 0, &mut RejectThermals).is_err(),
            "accepted {name} {key}"
        );
    }
}

#[test]
fn model_command_and_rule_admission_must_be_the_observed_ones() {
    for key in ["backend_command_sha256", "status", "inputs", "dsn"] {
        let f = Fixture::new();
        let p = f.prepared();
        producer(&p);
        edit(&p.output.join("rule-coverage.json"), |row| {
            row[key] = match key {
                "inputs" => json!({text(&p.native):"wrong"}),
                "dsn" => json!({"path":p.output.join("board.dsn"),"sha256":"wrong"}),
                _ => json!("wrong"),
            }
        });
        reseal_coverage(&p);
        assert!(
            finalize(&p, 0, &mut RejectThermals).is_err(),
            "accepted coverage {key}"
        );
    }
    let f = Fixture::new();
    let p = f.prepared();
    producer(&p);
    edit(&p.output.join("effective-configuration.json"), |row| {
        row["command"] = json!(["fastroute", "-de", "another.dsn"])
    });
    assert!(
        finalize(&p, 0, &mut RejectThermals)
            .unwrap_err()
            .contains("admitted model")
    );
}

#[test]
fn failure_before_launch_is_retained_and_success_without_controls_is_rejected() {
    let f = Fixture::new();
    let p = f.prepared();
    assert_eq!(
        finalize(&p, 124, &mut RejectThermals).unwrap()["controls_verified"],
        false
    );
    assert!(
        finalize(&p, 0, &mut RejectThermals)
            .unwrap_err()
            .contains("effective input configuration")
    );
    producer(&p);
    fs::remove_file(p.output.join("effective-configuration.json")).unwrap();
    assert_eq!(
        finalize(&p, 4, &mut RejectThermals).unwrap()["controls_verified"],
        false
    );
    write(
        &p.output.join("rule-coverage-blocked.json"),
        &json!({"status":"blocked","solver_launch_allowed":false,"cause":"uncovered sourced rule","inputs":{}}),
    );
    let blocked = finalize(&p, 4, &mut RejectThermals).unwrap();
    assert_eq!(blocked["solver_launched"], false);
    assert_eq!(blocked["qualified"], false);
    assert!(
        finalize(&p, 0, &mut RejectThermals)
            .unwrap_err()
            .contains("contradicts blocked")
    );
}

#[test]
fn retained_context_and_original_inputs_cannot_change_during_routing() {
    let f = Fixture::new();
    let p = f.prepared();
    producer(&p);
    fs::write(&p.context_path, "changed context").unwrap();
    assert!(
        finalize(&p, 0, &mut RejectThermals)
            .unwrap_err()
            .contains("execution context changed")
    );
    let f = Fixture::new();
    let p = f.prepared();
    producer(&p);
    fs::write(&p.native, "changed board").unwrap();
    assert!(
        finalize(&p, 0, &mut RejectThermals)
            .unwrap_err()
            .contains("input/tool changed")
    );
}

struct FixtureThermals {
    calls: Vec<&'static str>,
    initial: Value,
    final_receipt: Value,
}
impl ThermalVerifier for FixtureThermals {
    fn validate_capability(
        &mut self,
        capability: &Value,
        source: &Path,
        base: &Path,
        nets: &[String],
    ) -> Result<Value> {
        ensure(
            source.is_file()
                && base.is_file()
                && nets == ["/A", "/B"]
                && capability == &self.initial,
            "fixture thermal initial mismatch",
        )?;
        self.calls.push("initial");
        Ok(self.initial.clone())
    }
    fn discharge(
        &mut self,
        capability: &Value,
        candidate: &Path,
        fill: &Path,
        drc: &Path,
    ) -> Result<Value> {
        ensure(
            capability == &self.initial
                && fill.is_file()
                && drc.is_file()
                && self.final_receipt["candidate_sha256"] == hash(candidate)?,
            "fixture thermal discharge mismatch",
        )?;
        self.calls.push("final");
        Ok(self.final_receipt.clone())
    }
}

#[test]
fn thermal_trials_reopen_captured_sources_and_discharge_every_pending_capability() {
    let f = Fixture::new();
    edit(&f.root.join("tools/route-features.json"), |row| {
        row["features"]["routing_rules"]["on"] = json!(false)
    });
    let mut c = config();
    c["schema"] = json!(THERMAL_SCHEMA);
    c["thermal_verification"] = json!("native-checkback");
    let p = prepare(f.request(c), &f.env).unwrap();
    producer(&p);
    for name in ["input-manifest.json", "effective-configuration.json"] {
        edit(&p.output.join(name), |row| {
            row["configuration"]["native_thermal_checkback"] = json!(true)
        });
    }
    let captured = p.output.join("native-thermal-source/X.kicad_pcb");
    fs::create_dir_all(captured.parent().unwrap()).unwrap();
    let mut originals = BTreeMap::new();
    let mut copies = BTreeMap::new();
    for suffix in ["kicad_pcb", "kicad_pro", "kicad_dru", "kicad_sch"] {
        let original = p.native.with_extension(suffix);
        let copy = captured.with_extension(suffix);
        fs::copy(&original, &copy).unwrap();
        originals.insert(original.clone(), hash(&original).unwrap());
        copies.insert(copy, hash(&original).unwrap());
    }
    write(
        &p.output.join("native-thermal-source.json"),
        &json!({"schema":"iot-lab.native-thermal-source.v1","original":{"path":p.native,"sha256":hash(&p.native).unwrap()},
        "captured":{"path":captured,"sha256":hash(&captured).unwrap()},"original_files":originals,"inputs":copies}),
    );
    fs::copy(&p.native, p.output.join("base.kicad_pcb")).unwrap();
    let initial = json!({"required_count":2,"content_sha256":"fixture-capability"});
    write(&p.output.join("native-thermal-initial.json"), &initial);
    edit(&p.output.join("rule-coverage.json"), |row| {
        row["status"] = json!("pending_native");
        row["model_status"] = json!("partial");
        row["native_thermal_capability"] = initial.clone();
        row["native_postconditions"] = json!([{"constraint":"min_resolved_spokes","required_count":"2","capability_sha256":"fixture-capability"}]);
    });
    reseal_coverage(&p);
    let final_receipt = json!({"status":"passed","candidate_sha256":hash(&p.output.join("routed.kicad_pcb")).unwrap()});
    write(&p.output.join("native-thermal-final.json"), &final_receipt);
    write(
        &p.output.join("native-thermal-final-fill.json"),
        &json!({"fixture":"fill"}),
    );
    write(
        &p.output.join("native-thermal-final-drc.json"),
        &json!({"fixture":"drc"}),
    );
    let mut verifier = FixtureThermals {
        calls: vec![],
        initial,
        final_receipt,
    };
    assert_eq!(finalize(&p, 0, &mut verifier).unwrap()["status"], "passed");
    assert_eq!(verifier.calls, ["initial", "final"]);
    fs::write(
        captured.with_extension("kicad_dru"),
        "changed captured rule",
    )
    .unwrap();
    assert!(
        finalize(&p, 0, &mut verifier)
            .unwrap_err()
            .contains("original snapshot differs")
    );
}
