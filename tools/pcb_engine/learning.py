"""Observe sealed engine attempts without promoting internal gate results.

An accepted label requires the terminal outer operation's full configured gate
and semantic acceptance, and the selected attempt's exact candidate bytes.
Unselected or incomplete attempts remain unknown, never fabricated negatives.
"""
import json
from pathlib import Path
import hashlib
import re
import urllib.request
from urllib.parse import urlsplit
from datetime import datetime, timezone

import pcb_ml_data as data
import pcb_ml_features as features
import placement_outcomes as outcomes

CORPUS = "iot-lab.pcb-engine-corpus.v1"
TARGETS = {
    "accepted_within_budget": {"type": "binary", "direction": "max"},
    "owned_elapsed_s": {"type": "regression", "direction": "min", "unit": "s"},
    "successful_completion_elapsed_s": {"type": "regression", "direction": "min", "unit": "s"},
    "routed_track_length_mm": {"type": "regression", "direction": "min", "unit": "mm"},
    "routed_via_count": {"type": "regression", "direction": "min", "unit": "count"},
}


def ingest_public_corpus(manifest_path, destination):
    """Fetch original pinned public files. No routing labels are inferred."""
    request = json.loads(Path(manifest_path).read_text())
    if request.get("schema") != "iot-lab.pcb-engine-public-corpus.v1":
        raise ValueError("unsupported public corpus manifest")
    revision = request.get("revision", "")
    if not re.fullmatch("[0-9a-f]{40}", revision):
        raise ValueError("public corpus must pin the full source commit")
    sources, licenses = request.get("sources"), request.get("license_evidence")
    if not isinstance(sources, list) or not sources or not isinstance(licenses, list) or not licenses:
        raise ValueError("public corpus needs source assets and retained license evidence")
    allowed = {"CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"}
    for source in sources:
        if source.get("license") not in allowed or not source.get("attribution"):
            raise ValueError("public source lacks supported license declaration and attribution")
    paths = set()
    assets = licenses + sources
    for asset in assets:
        path = asset.get("path")
        parsed = urlsplit(asset.get("url", ""))
        if (not isinstance(path, str) or not path or Path(path).is_absolute()
                or ".." in Path(path).parts or path in paths
                or parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password
                or revision not in parsed.path.split("/")
                or not re.fullmatch("[0-9a-f]{64}", asset.get("sha256", ""))):
            raise ValueError("public asset requires a unique relative path, pinned HTTPS URL and SHA256")
        paths.add(path)
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("public corpus destination already exists")
    destination.mkdir(parents=True)
    verified = []
    for asset in assets:
        with urllib.request.urlopen(asset["url"], timeout=30) as response:
            if urlsplit(response.url).scheme != "https":
                raise ValueError("public source redirected away from HTTPS")
            payload = response.read(16 * 1024 * 1024 + 1)
        if len(payload) > 16 * 1024 * 1024 or hashlib.sha256(payload).hexdigest() != asset["sha256"]:
            raise ValueError("public source size or SHA256 mismatch: " + asset["path"])
        path = destination / asset["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(payload)
        verified.append(dict(asset, path=str(path), bytes=len(payload),
                             retrieved_at=datetime.now(timezone.utc).isoformat()))
    return dict(schema="iot-lab.pcb-engine-public-source-receipt.v1",
                status="source_verified", revision=revision, sources=verified[len(licenses):],
                license_evidence=verified[:len(licenses)],
                source_manifest_sha256=outcomes.sha(manifest_path),
                labels_eligible=False, promotion=False, qualified=False,
                labels=None, files_unmodified=True,
                redistribution="Retain the recorded attribution and licenses with these original files; derivative/model licensing is not determined by this receipt.",
                next="Collect sealed engine routing observations before assigning any outcome labels.")


def _manifest(root, path):
    path = (Path(root) / path).resolve()
    manifest = json.loads(path.read_text())
    if manifest.get("schema") != CORPUS or not isinstance(manifest.get("trials"), list):
        raise ValueError("expected engine corpus manifest")
    for trial in manifest["trials"]:
        if (any(not isinstance(trial.get(k), str) or not trial[k] for k in
                ("id", "family", "path", "sha256", "attempt_id"))
                or trial.get("split") not in data.SPLITS
                or Path(trial["attempt_id"]).name != trial["attempt_id"]
                or not trial["attempt_id"].startswith("attempt-")):
            raise ValueError("invalid engine corpus trial")
    return path, manifest


def dependencies(root, path):
    path, manifest = _manifest(root, path)
    evidence = outcomes.Evidence(root)
    evidence.file(path)
    for trial in manifest["trials"]:
        outcomes.sealed_run(evidence, trial["path"], trial["sha256"])
    evidence.file(__file__)
    evidence.file(features.__file__)
    from pcb_ml_adapters import _code_inputs
    for name, digest in _code_inputs(observer=True).items():
        evidence.file(name, digest)
    return evidence.inputs


def _controls(evidence, attempt, input_sha):
    """Validate native-v2 retained controls; no invented container identity."""
    policy = evidence.read(attempt / "execution-policy.json")
    context_path = attempt / "execution-context.json"
    context = evidence.read(context_path, policy["execution_context"]["sha256"])
    runtime, resources = policy.get("runtime", {}), policy.get("resources", {})
    controls = policy.get("controls", {})
    if (policy.get("schema") != "iot-lab.placement-outcome-execution.v2"
            or runtime.get("kind") != "native" or runtime.get("image_id") is not None
            or runtime.get("host_identity") != outcomes.sha(context_path)
            or context.get("schema") != "iot-lab.native-execution-context.v1"
            or resources.get("memory_is_hard_limit") is not False
            or resources.get("enforcement") != "cooperative-reservation-and-backend-worker-caps"
            or any(resources.get(k) != context.get(k) for k in ("cpus", "memory_bytes"))
            or controls.get("effective_configuration_verified") is not True):
        raise ValueError("native engine controls are incomplete or inconsistent")
    if not runtime.get("tools") or any(not v.get("sha256") or not v.get("version") for v in runtime["tools"].values()):
        raise ValueError("native runtime tool attribution missing")
    actual = evidence.read(attempt / "router/input-manifest.json", controls["input_manifest_sha256"])
    if (actual.get("board_sha256") != input_sha
            or actual.get("router_sha256") != runtime["tools"].get("router", {}).get("sha256")):
        raise ValueError("actual native execution source/tool differs")
    configurations = controls.get("effective_configurations")
    if not isinstance(configurations, dict) or not configurations:
        raise ValueError("actual native execution configurations missing")
    for name, digest in configurations.items():
        if Path(name).name != name:
            raise ValueError("configuration escapes router evidence")
        configuration = evidence.read(attempt / "router" / name, digest)
        for key in ("global_rayon_threads", "autorouter_workers", "optimizer_workers"):
            if configuration.get("backend_resources", {}).get(key) != resources["threads"]:
                raise ValueError("native worker caps differ from policy")
        binding = configuration.get("rule_coverage", {})
        coverage = evidence.read(attempt / "router" / Path(binding["path"]).name, binding["sha256"])
        if coverage.get("solver_launch_allowed") is not True or coverage.get("status") not in ("passed", "pending_native"):
            raise ValueError("solver rule admission not established")
    summary = evidence.read(attempt / "router-summary.json")
    if summary.get("controls_verified") is not True:
        raise ValueError("engine did not finish control verification")
    return policy


def _guarded_controls(evidence, attempt, receipt, original, candidate):
    """Recheck engine-owned native writers without inventing solver receipts."""
    from pcb_search.native_srj import geometry_digest
    source_sha = outcomes.sha(original)
    kind = receipt.get("strategy", {}).get("kind")
    if candidate is None:
        raise ValueError("guarded engine attempt has no retained native candidate")
    candidate_sha = outcomes.sha(candidate)
    def board_hash(files):
        values = [digest for name, digest in files.items() if name.endswith(".kicad_pcb")]
        if len(values) != 1:
            raise ValueError("native writer source board is ambiguous")
        return values[0]
    if kind == "repair":
        guard = evidence.read(attempt / "repair/guard.json")
        if (guard.get("schema") != "iot-lab.local-routing-guard.v1"
                or guard.get("status") != "proposed"
                or board_hash(guard.get("source_inputs", {})) != source_sha
                or guard.get("candidate_sha256") != candidate_sha
                or geometry_digest(original, guard.get("allowed_original_edits", []))
                   != guard.get("protected_geometry_sha256")
                or geometry_digest(candidate, guard.get("allowed_original_edits", []) + guard.get("added_items", []))
                   != guard.get("protected_geometry_sha256")):
            raise ValueError("guarded repair geometry/source proof differs from retained candidate")
        proof = guard
    elif kind == "local":
        exported = evidence.read(attempt / "export/record.json")
        imported = evidence.read(attempt / "import/record.json")
        proposal = evidence.read(attempt / "local-proposal.json")
        source = evidence.file(attempt / "export/input.kicad_pcb")
        output = evidence.file(attempt / "import/candidate.kicad_pcb")
        if (exported.get("schema") != "iot-lab.native-srj.v1"
                or exported.get("copper_policy") != "retain" or exported.get("removed_items")
                or not exported.get("kicad_version")
                or board_hash(exported.get("sources", {})) != source_sha
                or imported.get("status") != "candidate"
                or imported.get("input_files") != exported.get("input_files")
                or board_hash(imported.get("output_files", {})) != candidate_sha
                or outcomes.sha(output) != candidate_sha
                or imported.get("route_sha256") != outcomes.sha(attempt / "local-proposal.json")
                or proposal.get("status") != "candidate"
                or geometry_digest(original) != geometry_digest(source)
                or geometry_digest(source) != imported.get("protected_geometry_sha256")
                or geometry_digest(candidate, imported.get("added_items", [])) != geometry_digest(source)):
            raise ValueError("local routing import/source geometry proof is incomplete")
        proof = imported
    else:
        raise ValueError("unknown guarded engine strategy")
    return dict(kind="engine_guarded_native", strategy=kind,
                proof_sha256=data.artifact_identity(proof), policy=receipt["policy"])


def build_dataset(root, manifest_path, dataset_id=None):
    path, manifest = _manifest(root, manifest_path)
    evidence = outcomes.Evidence(root)
    evidence.file(path)
    rows = []
    contract = features.feature_contract("routing")
    for trial in manifest["trials"]:
        folder, terminal, run, operation, final_candidate = outcomes.sealed_run(
            evidence, trial["path"], trial["sha256"])
        attempt = folder / "operation/engine" / trial["attempt_id"]
        original = evidence.file(attempt / "input.kicad_pcb")
        receipt = evidence.read(attempt / "input.json")
        original_sha = outcomes.sha(original)
        if receipt.get("schema") != "iot-lab.engine-input.v1" or receipt.get("board_sha256") != original_sha:
            raise ValueError("engine pre-decision source mismatch")
        measured, feature_reasons = features.routing_features(original.read_text())
        targets = {name: None for name in TARGETS}
        unknowns = []
        candidate = evidence.file(attempt / "candidate.kicad_pcb") if (attempt / "candidate.kicad_pcb").is_file() else None
        try:
            if receipt.get("strategy", {}).get("kind") in ("repair", "local"):
                policy = _guarded_controls(evidence, attempt, receipt, original, candidate)
            else:
                policy = _controls(evidence, attempt, original_sha)
        except (ValueError, KeyError, OSError) as error:
            policy = None
            unknowns.append(str(error))
        selected = bool(final_candidate and candidate and outcomes.sha(final_candidate) == outcomes.sha(candidate))
        gate = evidence.read(folder / "gate/result.json") if (folder / "gate/result.json").is_file() else {}
        native = outcomes.native_observation(evidence, folder, gate, final_candidate) if final_candidate else None
        checks = gate.get("checks", {})
        full = bool(selected and terminal["status"] == "passed"
            and operation.get("candidate_verified") is True and operation.get("identity_preserved") is True
            and operation.get("source_unchanged") is True and not operation.get("protected_source_changes")
            and gate.get("exit") == 0 and gate.get("changedDuringRun") is False and not gate.get("preflightErrors")
            and native and all(native[k] == 0 for k in ("errors", "opens", "parity"))
            and checks and all(c.get("status") == "passed" and not c.get("cached") for c in checks.values()))
        elapsed, budget = terminal.get("elapsed_s"), run.get("timeout_s")
        if selected and outcomes.finite(elapsed):
            targets["owned_elapsed_s"] = elapsed
        if full and policy and outcomes.finite(elapsed) and outcomes.finite(budget) and budget > 0:
            targets["accepted_within_budget"] = int(elapsed <= budget)
            if elapsed <= budget:
                targets["successful_completion_elapsed_s"] = elapsed
                quality = outcomes.routed_quality(evidence, final_candidate)
                for name in ("routed_track_length_mm", "routed_via_count"):
                    targets[name] = quality[name]
        else:
            unknowns.append("No selected attempt with complete outer semantic/native acceptance and verified controls.")
        # Case identity excludes placement but keeps authored copper and rules.
        from pcb_operations import pcb_identity
        from placer.dru import _tree, _tokens
        source_record = folder / "operation/source.json"
        source_files = evidence.read(source_record).get("files", {}) if source_record.is_file() else {}
        sidecars = {name: digest for name, digest in source_files.items()
                    if Path(name).suffix in (".kicad_sch", ".kicad_pro", ".kicad_dru")}
        # Tool/model/policy changes must not turn the same board case into a new
        # holdout group. Keep their attribution separately from case identity.
        case = data.artifact_identity(dict(identity=pcb_identity(original),
            copper=outcomes.retained_copper(_tree(_tokens(original.read_text()))[0]),
            sidecars=sidecars))
        rows.append(dict(id=trial["id"], family=trial["family"], split=trial["split"],
            case_fingerprint=case, source_fingerprint=original_sha,
            pose_fingerprint=data.artifact_identity(dict(source=original_sha)),
            run_fingerprint=data.artifact_identity(dict(terminal=trial["sha256"], attempt=trial["attempt_id"])),
            features=measured, targets=targets, evidence_valid=True,
            status=terminal["status"], failure_class=None if full else "unaccepted_or_unknown",
            unknowns=unknowns, feature_reasons=feature_reasons,
            source=dict(path=str(original), sha256=original_sha),
            rules_revision=receipt["rules_revision"],
            label_scope="Selected engine attempt, entire owned run budget; other attempts retain unknown labels."))
    evidence.file(__file__)
    from pcb_ml_adapters import _code_inputs
    for name, digest in _code_inputs(observer=True).items():
        evidence.file(name, digest)
    for name, digest in contract["implementation_sha256"].items():
        evidence.file(Path(root) / name, digest)
    result = data.finalize_dataset(root, dataset_id=dataset_id or manifest.get("dataset_id"),
        task="routing_outcome", feature_names=[name for name, _ in features.ROUTING_FEATURES],
        target_specs=TARGETS, rows=rows, inputs=evidence.inputs,
        metadata=dict(adapter="engine", feature_contract=contract,
                      acceptance_contract="iot-lab.engine-selected-owned-acceptance.v1",
                      qualification="advisory, no automatic model promotion"))
    for name, digest in evidence.inputs.items():
        evidence.file(name, digest)
    return result
