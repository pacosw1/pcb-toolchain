use super::*;

/// The native thermal checker is owned by its existing producer. Both methods must reopen native evidence.
/// Passing an already-read receipt through unchanged is not a verifier implementation.
pub trait ThermalVerifier {
    fn validate_capability(
        &mut self,
        capability: &Value,
        source: &Path,
        base: &Path,
        selected_nets: &[String],
    ) -> Result<Value>;
    fn discharge(
        &mut self,
        capability: &Value,
        candidate: &Path,
        fill_receipt: &Path,
        drc_receipt: &Path,
    ) -> Result<Value>;
}

fn matching_files(folder: &Path, prefix: &str, suffix: &str) -> Result<Vec<PathBuf>> {
    if !folder.exists() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(folder).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().unwrap().to_string_lossy();
        if name.starts_with(prefix) && name.ends_with(suffix) {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn configuration(prepared: &Prepared) -> Value {
    let c = &prepared.config;
    let mut expected = json!({"board":prepared.native,"outdir":prepared.output,"passes":c.passes,"layers":c.layers.join(","),
        "only_nets":c.only_nets.join(","),"threads":c.threads,"max_time":c.timeout_s,"optimizer":c.optimizer,"preflight":true,
        "skip_net":"","plane_nets":"","gnd_vias":false,"route_planes":false,"unlock_nets":"","set":[],"neck_um":0});
    if c.thermal() {
        expected["native_thermal_checkback"] = json!(true);
    }
    expected
}

fn same_configuration(actual: &Value, expected: &Value) -> bool {
    expected
        .as_object()
        .unwrap()
        .iter()
        .all(|(key, value)| actual.get(key) == Some(value))
}

fn coverage_inputs(coverage: &Value, message: &str) -> Result<()> {
    if let Some(bindings) = coverage["inputs"].as_object() {
        for (name, digest) in bindings {
            let path = Path::new(name);
            let actual = if path.is_file() {
                json!(hash(path)?)
            } else {
                Value::Null
            };
            ensure(actual == *digest, format!("{message}{name}"))?;
        }
    }
    Ok(())
}

fn incomplete(
    prepared: &Prepared,
    policy: &mut Value,
    returncode: i32,
    cause: &str,
) -> Result<Value> {
    policy["controls"]["status"] = json!("incomplete");
    policy["controls"]["effective_configuration_verified"] = json!(false);
    policy["controls"]["tool_exit"] = json!(returncode);
    atomic_json(&prepared.policy_path, policy)?;
    Ok(json!({"status":"failed","controls_verified":false,"candidate":null,"cause":cause}))
}

fn initial_thermal(prepared: &Prepared, verifier: &mut impl ThermalVerifier) -> Result<Value> {
    let output = &prepared.output;
    let snapshot_path = output.join("native-thermal-source.json");
    let snapshot = read(&snapshot_path)?;
    let captured = output.join("native-thermal-source").join(
        prepared
            .native
            .file_name()
            .ok_or("native input has no name")?,
    );
    let board_hash = &prepared.policy["inputs"][text(&prepared.native)];
    let mut originals = BTreeMap::new();
    let mut copies = BTreeMap::new();
    for suffix in ["kicad_pcb", "kicad_pro", "kicad_dru", "kicad_sch"] {
        let original = prepared.native.with_extension(suffix);
        let digest = prepared.policy["inputs"][text(&original)]
            .as_str()
            .ok_or("thermal source lacks sidecar binding")?
            .to_string();
        originals.insert(original, digest.clone());
        copies.insert(captured.with_extension(suffix), digest);
    }
    ensure(
        snapshot["schema"] == "iot-lab.native-thermal-source.v1"
            && snapshot["original"] == json!({"path":prepared.native,"sha256":board_hash})
            && snapshot["captured"] == json!({"path":captured,"sha256":board_hash})
            && snapshot["original_files"] == json!(originals)
            && snapshot["inputs"] == json!(copies)
            && copies.iter().all(|(path, expected)| {
                regular_original(path) && hash(path).as_ref() == Ok(expected)
            }),
        "native thermal original snapshot differs from the controlled input",
    )?;
    let path = output.join("native-thermal-initial.json");
    ensure(
        path.is_file(),
        "native thermal execution lacks the initial capability",
    )?;
    verifier.validate_capability(
        &read(&path)?,
        &captured,
        &output.join("base.kicad_pcb"),
        &prepared.config.only_nets,
    )
}

fn validate_stage(
    path: &Path,
    prepared: &Prepared,
    expected: &Value,
    initial: Option<&Value>,
) -> Result<Option<Value>> {
    let stage = read(path)?;
    ensure(
        same_configuration(&stage["configuration"], expected),
        "a router stage changed the controlled configuration",
    )?;
    ensure(
        backend_effort(&stage["backend_policy"])? == prepared.policy["effort"]["backend_policy"],
        "a router stage changed the backend algorithm",
    )?;
    ensure(
        [
            "global_rayon_threads",
            "autorouter_workers",
            "optimizer_workers",
        ]
        .iter()
        .all(|key| stage["backend_resources"][key] == prepared.config.threads),
        "actual router worker caps differ from the controlled policy",
    )?;
    let binding = &stage["rule_coverage"];
    let coverage_path = Path::new(binding["path"].as_str().unwrap_or(""));
    ensure(
        coverage_path.parent() == Some(prepared.output.as_path())
            && coverage_path.is_file()
            && json!(hash(coverage_path)?) == binding["sha256"],
        "router stage lacks sealed rule-coverage admission",
    )?;
    let coverage = read(coverage_path)?;
    let pending = coverage["status"] == "pending_native";
    ensure(
        (coverage["status"] == "passed" || (prepared.config.thermal() && pending))
            && coverage["solver_launch_allowed"] == true,
        "router stage ran without passing rule coverage",
    )?;
    let mut capability = None;
    if pending {
        let value = &coverage["native_thermal_capability"];
        ensure(
            value.is_object() && Some(value) == initial,
            "pending thermal coverage lacks its initial native capability",
        )?;
        let required_count = value["required_count"]
            .as_u64()
            .ok_or("native thermal capability lacks required count")?;
        let obligations = json!([{"constraint":"min_resolved_spokes","required_count":required_count.to_string(),"capability_sha256":value["content_sha256"]}]);
        ensure(
            coverage["model_status"] == "partial"
                && coverage["native_postconditions"] == obligations,
            "pending thermal coverage has missing or different native obligations",
        )?;
        capability = Some(value.clone());
    }
    let dsn = &coverage["dsn"];
    let dsn_path = Path::new(dsn["path"].as_str().unwrap_or(""));
    ensure(
        dsn_path.is_file()
            && json!(hash(dsn_path)?) == dsn["sha256"]
            && dsn["sha256"] == stage["dsn_sha256"],
        "rule coverage differs from actual router model",
    )?;
    let command: Vec<String> = serde_json::from_value(stage["command"].clone())
        .map_err(|_| "router command does not use its admitted model")?;
    let models: Vec<_> = command
        .iter()
        .enumerate()
        .filter(|(_, arg)| *arg == "-de")
        .map(|(i, _)| i)
        .collect();
    ensure(
        models.len() == 1 && command.get(models[0] + 1).map(String::as_str) == dsn["path"].as_str(),
        "router command does not use its admitted model",
    )?;
    let quality = prepared.policy["effort"]["backend_policy"]["mode"] == "quality-first";
    ensure(
        command
            .iter()
            .filter(|arg| *arg == "--quality-first")
            .count()
            == usize::from(quality),
        "router command backend algorithm differs from the controlled policy",
    )?;
    let command_hash = sha256::sha256(ascii_json(&json!(command)).as_bytes());
    ensure(
        coverage["backend_command"] == json!(command)
            && coverage["backend_command_sha256"] == command_hash,
        "router command differs from project-rule admission",
    )?;
    coverage_inputs(&coverage, "router rule-coverage input changed: ")?;
    Ok(capability)
}

fn discharge(
    prepared: &Prepared,
    policy: &mut Value,
    returncode: i32,
    initial: Option<Value>,
    capabilities: Vec<Value>,
    verifier: &mut impl ThermalVerifier,
) -> Result<()> {
    if returncode != 0 {
        policy["controls"]["native_thermal_obligations"] = json!({"status":"unfulfilled","cause":"producer did not complete with a discharged native obligation"});
        return Ok(());
    }
    let final_path = prepared.output.join("native-thermal-final.json");
    ensure(
        initial.is_some() && final_path.is_file(),
        "native thermal obligation was not discharged before completion",
    )?;
    let final_receipt = read(&final_path)?;
    let capabilities = if capabilities.is_empty() {
        vec![initial.unwrap()]
    } else {
        capabilities
    };
    let candidate = prepared.output.join("routed.kicad_pcb");
    for capability in capabilities {
        let checked = verifier.discharge(
            &capability,
            &candidate,
            &prepared.output.join("native-thermal-final-fill.json"),
            &prepared.output.join("native-thermal-final-drc.json"),
        )?;
        ensure(
            checked == final_receipt,
            "final thermal receipt differs from actual native discharge",
        )?;
    }
    let root = prepared
        .policy_path
        .parent()
        .and_then(Path::parent)
        .ok_or("execution policy has no run root")?;
    let retain = |path: PathBuf| -> Result<Value> {
        Ok(
            json!({"path":path.strip_prefix(root).map_err(|e| e.to_string())?, "sha256":hash(&path)?}),
        )
    };
    policy["controls"]["native_thermal_obligations"] = json!({"status":"passed",
        "initial":retain(prepared.output.join("native-thermal-initial.json"))?, "final":retain(final_path)?,
        "source_snapshot":retain(prepared.output.join("native-thermal-source.json"))?, "candidate":retain(candidate)?});
    Ok(())
}

/// Reopen every input, command, coverage binding, worker cap, and candidate outcome. No ERC/DRC is run here.
pub fn finalize(
    prepared: &Prepared,
    returncode: i32,
    thermal_verifier: &mut impl ThermalVerifier,
) -> Result<Value> {
    let output = &prepared.output;
    let mut policy = prepared.policy.clone();
    check_inputs(&inputs(&policy["inputs"])?)?;
    ensure(
        hash(&prepared.context_path)? == prepared.context_sha256,
        "original host execution context changed during routing",
    )?;
    let copied = prepared
        .policy_path
        .with_file_name("execution-context.json");
    ensure(
        copied.is_file() && hash(&copied)? == prepared.context_sha256,
        "retained original execution context differs from the host receipt",
    )?;
    if prepared.runtime_kind == Runtime::Native {
        ensure(
            native_execution_context(&prepared.env)?.raw
                == fs::read(&copied).map_err(|e| e.to_string())?,
            "native host or resource policy changed during routing",
        )?;
    }
    let manifest = output.join("input-manifest.json");
    if !manifest.is_file() {
        ensure(
            returncode != 0,
            "successful router did not record its effective input configuration",
        )?;
        return incomplete(
            prepared,
            &mut policy,
            returncode,
            "router did not record its effective input configuration",
        );
    }
    let actual = read(&manifest)?;
    let expected = configuration(prepared);
    ensure(
        prepared.config.thermal() || actual["configuration"]["native_thermal_checkback"] != true,
        "strict v1 routing cannot activate native thermal checkback",
    )?;
    ensure(
        same_configuration(&actual["configuration"], &expected),
        "router effective configuration differs from the controlled policy",
    )?;
    ensure(
        actual["board_sha256"] == policy["inputs"][text(&prepared.native)],
        "router operated on another placement input",
    )?;
    ensure(
        actual["router_sha256"] == policy["runtime"]["tools"]["router"]["sha256"],
        "router binary differs from the recorded runtime",
    )?;
    let backend_path = output.join("backend-policy.json");
    ensure(
        backend_path.is_file()
            && backend_effort(&read(&backend_path)?)? == policy["effort"]["backend_policy"],
        "router backend algorithm differs from the controlled policy",
    )?;
    let mut features = actual.get("features").cloned().unwrap_or(json!({}));
    if let Some(features) = features.as_object_mut() {
        features.remove("_board_dir");
    }
    ensure(
        features == policy["effort"]["feature_policy"],
        "actual route features differ from the source-bound policy",
    )?;
    let configurations = matching_files(output, "effective-configuration", ".json")?;
    let mut blocked = Vec::new();
    for path in matching_files(output, "rule-coverage", ".json")? {
        let coverage = read(&path)?;
        if coverage["status"] == "blocked" && coverage["solver_launch_allowed"] == false {
            coverage_inputs(&coverage, "rule coverage input changed after admission: ")?;
            blocked.push(json!({"path":path,"sha256":hash(&path)?,"cause":coverage["cause"]}));
        }
    }
    if !blocked.is_empty() {
        ensure(
            returncode != 0,
            "solver success contradicts blocked rule coverage",
        )?;
        let cause = "router rule coverage blocked before solver: ".to_string()
            + &blocked
                .iter()
                .map(|row| row["cause"].as_str().unwrap_or("None"))
                .collect::<Vec<_>>()
                .join("; ");
        policy["controls"] = json!({"status":"blocked","effective_configuration_verified":false,"tool_exit":returncode,"rule_coverage":blocked,"solver_launched":!configurations.is_empty()});
        atomic_json(&prepared.policy_path, &policy)?;
        return Ok(
            json!({"status":"failed","controls_verified":false,"candidate":null,"qualified":false,"cause":cause,"rule_coverage":blocked,"solver_launched":!configurations.is_empty()}),
        );
    }
    if configurations.is_empty() {
        ensure(
            returncode != 0,
            "successful solver lacks actual backend worker-cap evidence",
        )?;
        return incomplete(
            prepared,
            &mut policy,
            returncode,
            "no observed backend invocation/worker caps; inspect retained failure evidence",
        );
    }
    let initial = if prepared.config.thermal() {
        Some(initial_thermal(prepared, thermal_verifier)?)
    } else {
        None
    };
    let mut capabilities = Vec::new();
    for path in &configurations {
        if let Some(capability) = validate_stage(path, prepared, &expected, initial.as_ref())? {
            capabilities.push(capability);
        }
    }
    let outcome_path = output.join("outcome.json");
    let outcome = if outcome_path.is_file() {
        read(&outcome_path)?
    } else {
        Value::Null
    };
    let candidate = output.join("routed.kicad_pcb");
    ensure(
        returncode != 0 || outcome["status"] == "complete",
        "successful router lacks a complete candidate outcome",
    )?;
    let has_candidate = ["complete", "stuck"].contains(&outcome["status"].as_str().unwrap_or(""));
    if has_candidate {
        ensure(
            candidate.is_file()
                && outcome["board_sha256"] == hash(&candidate)?
                && outcome["optimizer"] == prepared.config.optimizer,
            "router outcome is not bound to the actual candidate/optimizer",
        )?;
    }
    if prepared.config.thermal() {
        discharge(
            prepared,
            &mut policy,
            returncode,
            initial,
            capabilities,
            thermal_verifier,
        )?;
    }
    let phase_path = output.join("stages.jsonl");
    let repairs = if phase_path.is_file() {
        let phases = fs::read_to_string(&phase_path)
            .map_err(|e| e.to_string())?
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<Value>(line).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>>>()?;
        json!(
            phases
                .into_iter()
                .filter(|row| {
                    let stage = row["stage"].as_str().unwrap_or("").to_lowercase();
                    stage.contains("repair") || stage.contains("thermal")
                })
                .collect::<Vec<_>>()
        )
    } else {
        Value::Null
    };
    let seals: BTreeMap<_, _> = configurations
        .iter()
        .map(|path| {
            Ok((
                path.file_name().unwrap().to_string_lossy().into_owned(),
                hash(path)?,
            ))
        })
        .collect::<Result<_>>()?;
    for (name, value) in [
        ("status", json!("observed")),
        ("effective_configuration_verified", json!(true)),
        ("tool_exit", json!(returncode)),
        ("effective_configurations", json!(seals)),
        ("input_manifest_sha256", json!(hash(&manifest)?)),
        ("outcome", outcome.clone()),
        ("native_repair_phases", repairs),
    ] {
        policy["controls"][name] = value;
    }
    atomic_json(&prepared.policy_path, &policy)?;
    let cause = if returncode == 0 {
        "actual effective controls match; full candidate gate remains required".into()
    } else {
        format!(
            "router exited {returncode}; outcome={}",
            outcome["status"].as_str().unwrap_or("unknown")
        )
    };
    Ok(
        json!({"status":if returncode == 0 { "passed" } else { "failed" },"cause":cause,"controls_verified":true,
        "candidate":if has_candidate { json!(candidate) } else { Value::Null },"outcome":outcome,"qualified":false,"native_gate_required":true}),
    )
}
