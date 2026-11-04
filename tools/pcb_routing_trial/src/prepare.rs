use super::*;
use process::{executable, probe};
use std::io::Write;

fn board_config(root: &Path, board: &str) -> Result<(Value, PathBuf)> {
    ensure(
        !board.is_empty()
            && board
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
            && board.as_bytes()[0] != b'-',
        "invalid board ID",
    )?;
    let folder = root.join("hardware-design/boards").join(board);
    let cfg = read(&folder.join("gate.json"))?;
    let name = cfg["project"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("gate configuration requires a project")?;
    let project = absolute(&folder.join(name))?;
    ensure(
        project.starts_with(root.join("hardware-design/boards"))
            && project != root.join("hardware-design/boards"),
        "project escapes the board registry tree",
    )?;
    Ok((cfg, project))
}

fn board_for(root: &Path, native: &Path, board: Option<&str>) -> Result<String> {
    if let Some(board) = board {
        ensure(
            board_config(root, board)?.1.with_extension("kicad_pcb") == native,
            "controlled route input differs from the configured board",
        )?;
        return Ok(board.into());
    }
    let mut found = Vec::new();
    for entry in fs::read_dir(root.join("hardware-design/boards")).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.join("gate.json").is_file() {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if board_config(root, &name)?.1.with_extension("kicad_pcb") == native {
                found.push(name);
            }
        }
    }
    ensure(
        found.len() == 1,
        "controlled route requires one authoritative configured board binding",
    )?;
    Ok(found.remove(0))
}

fn admission_inputs(
    root: &Path,
    bindings: &BTreeMap<PathBuf, String>,
) -> Result<BTreeMap<PathBuf, String>> {
    let mut result = BTreeMap::new();
    for (name, digest) in bindings {
        let path = absolute(&root.join(name))?;
        ensure(
            name.is_absolute() || path.starts_with(root),
            "admission binding escapes its checkout",
        )?;
        result.insert(path, digest.clone());
    }
    check_inputs(&result)?;
    Ok(result)
}

fn gate_admission(
    root: &Path,
    board: &str,
    cfg: &Value,
    gate: &GateAdmission,
) -> Result<BTreeMap<PathBuf, String>> {
    let stage = cfg["stage"].as_str().unwrap_or("G4");
    ensure(
        ["G4", "G5"].contains(&stage) && gate.stage == stage,
        "controlled routing gate configuration rejected: controlled routing requires a G4 or G5 gate",
    )?;
    let bindings = admission_inputs(root, &gate.inputs)?;
    for path in [
        root.join("hardware-design/boards")
            .join(board)
            .join("gate.json"),
        root.join("tools/lib/gate-core.mjs"),
    ] {
        ensure(
            bindings.get(&path) == Some(&hash(&path)?),
            "controlled routing needs source-bound gate-core admission from the Mac",
        )?;
    }
    Ok(bindings)
}

fn features(root: &Path, cfg: &Value) -> Result<Value> {
    let mut features = read(&root.join("tools/route-features.json"))?["features"].clone();
    ensure(features.is_object(), "route features must be an object")?;
    if let Some(overrides) = cfg["route_features"].as_object() {
        for (name, changes) in overrides {
            if features.get(name).is_none() {
                features[name] = json!({});
            }
            for (key, value) in changes
                .as_object()
                .ok_or("route feature overrides must be objects")?
            {
                features[name][key] = value.clone();
            }
        }
    }
    Ok(features)
}

fn backend(
    root: &Path,
    router: &Path,
    env: &mut Environment,
    admission: Option<&BackendAdmission>,
) -> Result<(Value, BTreeMap<PathBuf, String>)> {
    let Some(manifest) = env
        .get("FASTROUTE_QUALITY_MANIFEST")
        .filter(|s| !s.is_empty())
        .cloned()
    else {
        ensure(
            admission.is_none_or(|a| a.policy["mode"] == "legacy-unverified"),
            "backend admission differs from the selected runtime",
        )?;
        return Ok((
            json!({"mode":"legacy-unverified", "qualified":false}),
            BTreeMap::new(),
        ));
    };
    let path = absolute(Path::new(&manifest))?;
    ensure(
        path.is_file(),
        "selected quality backend manifest is unavailable",
    )?;
    let admission = admission
        .ok_or("selected quality backend requires shared backend-quality admission from the Mac")?;
    let bindings = admission_inputs(root, &admission.inputs)?;
    ensure(
        admission.policy["mode"] == "quality-first"
            && admission.policy["binary_sha256"] == hash(router)?
            && admission.policy["manifest_sha256"] == hash(&path)?
            && bindings.get(&path) == Some(&hash(&path)?),
        "backend admission differs from the selected runtime",
    )?;
    backend_effort(&admission.policy)?;
    env.insert("FASTROUTE_QUALITY_MANIFEST".into(), text(&path));
    Ok((admission.policy.clone(), bindings))
}

/// Gate/backend admissions are produced by the existing shared Mac validators and rebound to the staged job paths.
pub fn prepare(request: PrepareRequest, env: &Environment) -> Result<Prepared> {
    let root = absolute(&request.root)?;
    let native = absolute(&request.native)?;
    let output = absolute(&request.output)?;
    let config = validate(request.config, request.total_timeout_s)?;
    ensure(
        native.starts_with(&root) && native.is_file(),
        "solver input must be the isolated workspace native PCB",
    )?;
    ensure(!output.exists(), "solver output must be a fresh directory")?;
    let board = board_for(&root, &native, request.board.as_deref())?;
    let cfg = board_config(&root, &board)?.0;
    let mut bindings = gate_admission(&root, &board, &cfg, &request.gate)?;
    ensure(
        !["ROUTE_FEATURES", "ROUTE_FEATURES_FILE"]
            .iter()
            .any(|key| env.get(*key).is_some_and(|s| !s.is_empty())),
        "external route feature overrides are unsupported in controlled trials",
    )?;
    ensure(
        env.get("ROUTE_BOARD")
            .is_none_or(|s| s.is_empty() || *s == board),
        "route environment belongs to another board",
    )?;
    ensure(
        ![
            "PYTHONHOME",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
            "DYLD_LIBRARY_PATH",
        ]
        .iter()
        .any(|key| env.get(*key).is_some_and(|s| !s.is_empty())),
        "external runtime loader overrides are unsupported in controlled trials",
    )?;
    let context = match request.runtime {
        Runtime::Native => native_execution_context(env)?,
        Runtime::Container => execution_context(env)?,
    };
    ensure(
        config.threads as f64 <= context.cpus,
        if request.runtime == Runtime::Container {
            "router threads exceed the actual container CPU quota"
        } else {
            "router threads exceed the admitted native CPU budget"
        },
    )?;
    let python_default = if cfg!(target_os = "macos") {
        "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3"
    } else {
        "python3"
    };
    let python = executable(
        env.get("KICAD_PYTHON")
            .or_else(|| env.get("KICAD_PY"))
            .map_or(python_default, String::as_str),
        env,
    )?;
    let router_default = PathBuf::from(env.get("HOME").ok_or("HOME is unavailable")?)
        .join("opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute");
    let router = executable(
        env.get("FASTROUTE_BIN").map_or(
            router_default.to_str().ok_or("non-UTF8 router path")?,
            String::as_str,
        ),
        env,
    )?;
    let kicad = executable(
        env.get("KICAD_CLI").map_or(
            if cfg!(target_os = "macos") {
                "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
            } else {
                "kicad-cli"
            },
            String::as_str,
        ),
        env,
    )?;
    let script = root.join("tools/fastroute_job.py");
    ensure(
        script.is_file(),
        "existing fastroute job producer is missing from the snapshot",
    )?;
    let features = features(&root, &cfg)?;
    let thermal = config.thermal();
    ensure(
        !(thermal && features["routing_rules"]["on"] == true),
        "native thermal checkback requires internal routing/repair stages disabled",
    )?;
    for name in [
        "tools/fastroute_job.py",
        "tools/route_features.py",
        "tools/route_rule_coverage.py",
        "tools/route_project_coverage.py",
        "tools/route_hole_coverage.py",
        "tools/backend_quality.py",
        "tools/route-features.json",
    ] {
        let path = root.join(name);
        bindings.insert(path.clone(), hash(&path)?);
    }
    // The port binds its compiled implementation; legacy Python producer dependencies stay until their owners port them.
    let implementation = std::env::current_exe().map_err(|e| e.to_string())?;
    for path in [&implementation, &python, &router, &kicad] {
        bindings.insert(path.clone(), hash(path)?);
    }
    if thermal {
        let path = root.join("tools/route_native_thermals.py");
        bindings.insert(path.clone(), hash(&path)?);
    }
    for extension in ["kicad_pcb", "kicad_sch", "kicad_pro", "kicad_dru"] {
        let path = native.with_extension(extension);
        ensure(
            path.is_file(),
            "controlled routing requires the exact four native sidecars",
        )?;
        bindings.insert(path.clone(), hash(&path)?);
    }
    let mut child_env = runtime_environment(
        env,
        &root,
        &board,
        &python,
        &router,
        &kicad,
        &context,
        &config,
        request.runtime,
    )?;
    let mut probes = Vec::new();
    let mut versions = BTreeMap::new();
    for (name, path) in [("python", &python), ("router", &router), ("kicad", &kicad)] {
        versions.insert(
            name,
            probe(&[text(path), "--version".into()], &child_env, &mut probes)?,
        );
    }
    let (backend, backend_bindings) =
        backend(&root, &router, &mut child_env, request.backend.as_ref())?;
    bindings.extend(backend_bindings);
    let command = command(&python, &script, &native, &output, &config);
    let parent = output.parent().ok_or("solver output has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let receipt = parent.join("execution-policy.json");
    let original = parent.join("execution-context.json");
    ensure(
        !receipt.exists() && !original.exists(),
        "controlled execution receipts must be new",
    )?;
    let mut source = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&original)
        .map_err(|e| e.to_string())?;
    source.write_all(&context.raw).map_err(|e| e.to_string())?;
    let context_sha256 = sha256::sha256(&context.raw);
    let policy = policy(
        &command,
        &child_env,
        &context,
        &config,
        &features,
        &bindings,
        &versions,
        &python,
        &router,
        &kicad,
        &backend,
        &request.gate.stage,
        request.total_timeout_s,
        &context_sha256,
        request.runtime,
    )?;
    atomic_json(&parent.join("runtime-probes.json"), &json!(probes))?;
    atomic_json(&receipt, &policy)?;
    Ok(Prepared {
        command,
        env: child_env,
        policy,
        policy_path: receipt,
        output,
        native,
        config,
        context_path: context.path.unwrap_or(original),
        context_sha256,
        runtime_kind: request.runtime,
    })
}

#[allow(clippy::too_many_arguments)]
fn runtime_environment(
    env: &Environment,
    root: &Path,
    board: &str,
    python: &Path,
    router: &Path,
    kicad: &Path,
    context: &ExecutionContext,
    config: &RoutingPolicy,
    runtime: Runtime,
) -> Result<Environment> {
    let mut result = env.clone();
    let memory = context.memory_bytes as f64 / 1_073_741_824.0;
    let job_memory = if runtime == Runtime::Native {
        env.get("IOT_JOB_MEMORY_GIB")
            .map_or(Ok(8.0), |s| s.parse::<f64>().map_err(|e| e.to_string()))?
            .min(memory)
    } else {
        memory
    };
    for (key, value) in [
        ("IOT_LAB", text(root)),
        ("ROUTE_BOARD", board.into()),
        ("FASTROUTE_BIN", text(router)),
        ("KICAD_CLI", text(kicad)),
        ("KICAD_PYTHON", text(python)),
        ("KICAD_PY", text(python)),
        ("PYTHONPATH", text(&root.join("tools"))),
        ("IOT_CPU_BUDGET", (context.cpus.floor() as u64).to_string()),
        ("IOT_RESOURCE_CPU", config.threads.to_string()),
        ("IOT_MEMORY_BUDGET_GIB", float_text(memory)),
        ("IOT_JOB_MEMORY_GIB", float_text(job_memory)),
    ] {
        result.insert(key.into(), value);
    }
    Ok(result)
}
fn float_text(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{value:.1}")
    } else {
        value.to_string()
    }
}
fn command(
    python: &Path,
    script: &Path,
    native: &Path,
    output: &Path,
    config: &RoutingPolicy,
) -> Vec<String> {
    let mut args = vec![
        text(python),
        text(script),
        text(native),
        text(output),
        "--preflight".into(),
    ];
    for (key, value) in [
        ("--skip-net", String::new()),
        ("--plane-nets", String::new()),
        ("--only-nets", config.only_nets.join(",")),
        ("--layers", config.layers.join(",")),
        ("--passes", config.passes.to_string()),
        ("--threads", config.threads.to_string()),
        ("--max-time", config.timeout_s.to_string()),
        ("--optimizer", config.optimizer.clone()),
        ("--snapshot-interval-s", "0".into()),
    ] {
        args.extend([key.into(), value]);
    }
    if config.thermal() {
        args.push("--native-thermal-checkback".into());
    }
    args
}

#[allow(clippy::too_many_arguments)]
fn policy(
    command: &[String],
    env: &Environment,
    context: &ExecutionContext,
    config: &RoutingPolicy,
    features: &Value,
    bindings: &BTreeMap<PathBuf, String>,
    versions: &BTreeMap<&str, String>,
    python: &Path,
    router: &Path,
    kicad: &Path,
    backend: &Value,
    stage: &str,
    total_timeout: f64,
    context_sha: &str,
    runtime: Runtime,
) -> Result<Value> {
    let mut tools = json!({});
    for (name, path) in [("python", python), ("router", router), ("kicad", kicad)] {
        tools[name] = json!({"version":versions[name], "sha256":hash(path)?});
    }
    let environment: BTreeMap<_, _> = [
        "ROUTE_BOARD",
        "ROUTE_FEATURES",
        "ROUTE_FEATURES_FILE",
        "FASTROUTE_BIN",
        "FASTROUTE_QUALITY_MANIFEST",
        "KICAD_CLI",
        "KICAD_PYTHON",
        "PYTHONPATH",
        "IOT_CPU_BUDGET",
        "IOT_RESOURCE_CPU",
        "IOT_MEMORY_BUDGET_GIB",
        "IOT_JOB_MEMORY_GIB",
    ]
    .into_iter()
    .map(|key| (key, env.get(key)))
    .collect();
    let rules = &features["routing_rules"];
    let mut result = json!({"schema":if runtime==Runtime::Container { EXECUTION } else { "iot-lab.placement-outcome-execution.v2" }, "command":command,
        "runtime":{"image_id":context.image_id,"tools":tools}, "resources":{"cpus":context.cpus,"memory_bytes":context.memory_bytes,"threads":config.threads},
        "effort":{"timeout_s":total_timeout,"router_timeout_s":config.timeout_s,"passes":config.passes,"max_repairs":0,"optimizer":config.optimizer,
            "backend_policy":backend_effort(backend)?,"max_repairs_scope":"separate CLI repair operations only",
            "internal_repair_iterations":if rules["on"]==true { rules.get("repair_iterations").cloned().unwrap_or(json!(2)) } else { json!(0) },"feature_policy":features},
        "execution_context":{"path":"operation/execution-context.json","sha256":context_sha,"container_id":context.container_id,"observed_cgroup":context.observed_cgroup,
            "attribution":"host Docker inspect matched to running hostname and exposed cgroup limits"}, "gate_admission":{"stage":stage,"validator":"gate-core.validateConfig"},
        "inputs":bindings,"environment":environment,"controls":{"status":"prepared","effective_configuration_verified":false},"qualified":false});
    if runtime == Runtime::Native {
        result["runtime"]["kind"] = json!("native");
        result["runtime"]["host_identity"] = json!(context.identity);
        result["resources"]["enforcement"] =
            json!("cooperative-reservation-and-backend-worker-caps");
        result["resources"]["memory_is_hard_limit"] = json!(false);
        result["resources"]["network_isolated"] = json!(false);
        result["execution_context"]["kind"] = json!("native");
        result["execution_context"]["attribution"] =
            json!("locally observed OS and cooperative resource budget; no container isolation");
    }
    if config.thermal() {
        result["effort"]["thermal_verification"] = json!("native-checkback");
    }
    Ok(result)
}
