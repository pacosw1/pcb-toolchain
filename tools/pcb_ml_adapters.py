"""Produce advisory ML artifacts from native inputs and owned sealed CLI runs.

No authored numeric rows or inferred success labels enter these adapters.
Unavailable/corrupt historical attempts remain explicitly ineligible. Feature
packets carry their original sources so inference can re-extract their values.
"""
import hashlib
import json
import math
from pathlib import Path
import re
import sys

import pcb_ml_data as data
import pcb_ml_features as features
import placement_outcomes as outcomes


CORPUS = "iot-lab.pcb-ml-corpus.v1"
REQUEST = "iot-lab.pcb-ml-features-request.v1"
PACKET = "iot-lab.pcb-ml-features.v1"
_OBSERVER_CODE = ("placement_outcomes.py", "pcb_workflow.py", "pcb_timing.py",
                  "lean_workflow.py", "lean_owned.py", "pcb_operations.py",
                  "pcb_search/block_bindings.py", "pcb_search/contracts.py",
                  "pcb_search/native_srj.py", "pcb_search/native_placement.py",
                  "pcb_search/native_eco.py", "pcb_search/native_candidate.py", "pcb_search/__init__.py",
                  "placer/placement_audit.py", "block_reuse.py", "block_extract.py", "blocks.py")
_BASE_CODE = ("pcb_ml_adapters.py", "pcb_ml_features.py", "pcb_ml_data.py",
              "placer/dru.py", "placer/__init__.py")
ROUTING_TARGETS = {
    "accepted_within_budget": {"type": "binary", "direction": "max"},
    "owned_elapsed_s": {"type": "regression", "direction": "min", "unit": "s"},
    "successful_completion_elapsed_s": {"type": "regression", "direction": "min", "unit": "s"},
    "routed_track_length_mm": {"type": "regression", "direction": "min", "unit": "mm"},
    "added_route_track_length_mm": {"type": "regression", "direction": "min", "unit": "mm"},
    "routed_via_count": {"type": "regression", "direction": "min", "unit": "count"},
    "native_errors": {"type": "regression", "direction": "min", "unit": "count"},
    "native_opens": {"type": "regression", "direction": "min", "unit": "count"},
    "native_parity": {"type": "regression", "direction": "min", "unit": "count"},
}
WORKFLOW_TARGETS = {"run_passed": {"type": "binary", "direction": "max"},
                    "owned_elapsed_s": {"type": "regression", "direction": "min", "unit": "s"}}
ADDED_LENGTH_DEFINITION = features.ADDED_LENGTH_DEFINITION


def _sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _resolve(root, name):
    return (Path(root).resolve() / name).resolve()


def _json(path):
    try:
        value = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise ValueError("cannot read source JSON: " + str(path)) from exc
    if not isinstance(value, dict):
        raise ValueError("source JSON must be an object: " + str(path))
    return value


def _manifest(root, manifest, schema=None):
    path = _resolve(root, manifest)
    value = _json(path)
    if value.get("schema") not in (CORPUS, REQUEST) or (schema and value["schema"] != schema):
        raise ValueError("unsupported ML manifest schema")
    if value.get("adapter") not in ("routing", "workflow"):
        raise ValueError("unsupported ML adapter")
    if value["schema"] == CORPUS:
        if not isinstance(value.get("trials"), list):
            raise ValueError("corpus trials must be a list")
        for trial in value["trials"]:
            if (not isinstance(trial, dict)
                    or any(not isinstance(trial.get(name), str) or not trial[name].strip() for name in ("id", "family", "path"))
                    or trial.get("split") not in data.SPLITS
                    or not isinstance(trial.get("sha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", trial["sha256"])):
                raise ValueError("corpus trials require IDs, family, split, run folder and terminal SHA256")
    return path, value


def _code_inputs(observer=False):
    tools = Path(__file__).resolve().parent
    names = _BASE_CODE + (_OBSERVER_CODE if observer else ())
    return {str(path): _sha(path) for path in [*(tools / name for name in names), Path(sys.executable).resolve()]}


def manifest_dependencies(root, manifest):
    """Static closure for admission; missing declared artifacts have value None.

    This inventories declared historical artifacts without accepting their
    seals. The actual producer separately verifies recorded expected hashes.
    """
    path, value = _manifest(root, manifest)
    result = _code_inputs(value["schema"] == CORPUS)

    def add(name):
        target = _resolve(root, name)
        result[str(target)] = _sha(target) if target.is_file() else None
        return target

    add(path)
    if value["schema"] == REQUEST:
        if not isinstance(value.get("samples"), list):
            raise ValueError("feature request samples must be a list")
        for sample in value["samples"]:
            if not isinstance(sample, dict) or not isinstance(sample.get("source"), dict) or not isinstance(sample["source"].get("path"), str):
                raise ValueError("feature request requires explicit sources")
            add(sample["source"]["path"])
        return result
    if not isinstance(value.get("trials"), list):
        raise ValueError("corpus trials must be a list")
    for trial in value["trials"]:
        if not isinstance(trial, dict) or not isinstance(trial.get("path"), str):
            raise ValueError("corpus trials require run folders")
        folders = [(trial["path"], trial.get("sha256"))]
        parent = trial.get("parent_run")
        if isinstance(parent, dict) and isinstance(parent.get("path"), str):
            folders.append((parent["path"], parent.get("sha256")))
        for name, _ in folders:
            folder = _resolve(root, name)
            terminal_path = add(folder / "result.json")
            add(folder / "run.json")
            # Inventory unsealed additions too: corruption cannot disappear
            # between admission, a failed observation and terminal sealing.
            for directory in ("operation", "gate"):
                for artifact in (folder / directory).rglob("*"):
                    if artifact.is_file():
                        add(artifact)
            if terminal_path.is_file():
                try:
                    terminal = _json(terminal_path)
                except ValueError:
                    terminal = {}
                inventory = terminal.get("evidence_sha256", {})
                if isinstance(inventory, dict):
                    for relative in inventory:
                        if not isinstance(relative, str):
                            raise ValueError("malformed sealed run inventory")
                        artifact = (folder / relative).resolve()
                        if not artifact.is_relative_to(folder):
                            raise ValueError("sealed run path escapes its folder")
                        add(artifact)
        original = trial.get("placement_input")
        if isinstance(original, dict) and isinstance(original.get("path"), str):
            add(original["path"])
    return dict(sorted(result.items()))


def _check_closure(root, closure):
    existing = {name: digest for name, digest in closure.items() if digest is not None}
    data.assert_unchanged(root, existing)
    for name, digest in closure.items():
        if digest is None and (Path(name).exists() or Path(name).is_symlink()):
            raise ValueError("missing input appeared during observation: " + name)
    return existing


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except OverflowError:
        return False


def _extract(adapter, path):
    if adapter == "routing":
        try:
            return features.routing_features(Path(path).read_text())
        except (OSError, ValueError, IndexError, TypeError, ArithmeticError) as exc:
            return {name: None for name, _ in features.ROUTING_FEATURES}, [dict(code="native_input_invalid", cause=str(exc))]
    return features.workflow_features(_json(path))


def _task(adapter):
    return "routing_outcome" if adapter == "routing" else "workflow_outcome"


def _raw_manifest(folder):
    try:
        return _json(folder / "run.json")
    except ValueError:
        return {}


def _workflow_source_context(evidence, folder, manifest):
    """Bind pre-decision CAD/rules without using native findings as features.

    Candidate operations seal their original source inventory. A check is
    read-only, so its unchanged gate's input provenance is its pre-check source.
    Historical host prefixes are not case identities.
    """
    entries = []
    source = folder / "operation/source.json"
    if source.is_file():
        inventory = evidence.read(source).get("files", {})
        if isinstance(inventory, dict):
            entries = list(inventory.items())
    if not entries and manifest.get("operation") == "check" and (folder / "gate/result.json").is_file():
        gate = evidence.read(folder / "gate/result.json")
        if gate.get("changedDuringRun") is False:
            entries = [(row.get("path"), row.get("sha256")) for row in gate.get("provenance", {}).get("inputs", []) if isinstance(row, dict)]
    result = set()
    for name, digest in entries:
        if not isinstance(name, str) or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            continue
        path = Path(name)
        if path.suffix not in (".kicad_pcb", ".kicad_sch", ".kicad_pro", ".kicad_dru", ".kicad_sym", ".kicad_mod"):
            continue
        normalized = name[name.index("hardware-design/"):] if "hardware-design/" in name else path.name
        result.add((normalized, digest))
    return [dict(path=name, sha256=digest) for name, digest in sorted(result)]


def _added_track_length(evidence, source, source_sha256, quality):
    """Derive a new label from immutable native inputs, never a router statistic."""
    result = dict(definition=ADDED_LENGTH_DEFINITION["id"], added_route_track_length_mm=None,
        retained_track_length_mm=None, final_track_length_mm=None, retained_copper_preserved=None,
        missing_source_items=None, source=None, candidate=None, unknowns={})
    source = evidence.file(source, source_sha256)
    descriptor = quality.get("candidate", {})
    candidate = evidence.file(descriptor["path"], descriptor["sha256"])
    result.update(source=dict(path=str(source), sha256=source_sha256), candidate=descriptor)
    try:
        before = features.native_copper_metrics(source.read_text())
        after = features.native_copper_metrics(candidate.read_text())
        result.update(retained_track_length_mm=before["track_length_mm"], final_track_length_mm=after["track_length_mm"])
        if before["copper"] is None or after["copper"] is None:
            raise ValueError("retained copper proof unavailable: " + str(before["unknowns"] or after["unknowns"]))
        missing = before["copper"] - after["copper"]
        result.update(retained_copper_preserved=not missing, missing_source_items=sum(missing.values()))
        if missing:
            raise ValueError("source track/via geometry missing or changed; net subtraction is not proven added copper")
        if not _finite(before["track_length_mm"]) or not _finite(after["track_length_mm"]):
            raise ValueError("source/final straight length unknown: " + str(before["unknowns"] or after["unknowns"]))
        if after["track_length_mm"] != quality.get("routed_track_length_mm"):
            raise ValueError("final native measurement disagrees with accepted whole-board quality")
        delta = math.fsum([after["track_length_mm"], -before["track_length_mm"]])
        if not _finite(delta) or delta < 0:
            raise ValueError("negative or nonfinite added length; no zero clamp or assumed tolerance")
        result["added_route_track_length_mm"] = delta
    except (ValueError, TypeError, IndexError, OverflowError) as error:
        result["unknowns"]["added_route_track_length_mm"] = str(error)
    # An input mutation is an evidence failure, not merely an unknown metric.
    evidence.file(source, source_sha256)
    evidence.file(candidate, descriptor["sha256"])
    return result


def _row(root, trial, adapter, evidence):
    folder = _resolve(root, trial["path"])
    original = trial.get("placement_input") if adapter == "routing" else {"path": str(folder / "run.json"), "sha256": None}
    source_path = _resolve(root, original["path"]) if isinstance(original, dict) and isinstance(original.get("path"), str) else None
    source_sha = _sha(source_path) if source_path and source_path.is_file() else None
    raw = _raw_manifest(folder)
    source_id = data.artifact_identity(dict(adapter=adapter, source_sha256=source_sha,
                                           declared_sha256=original.get("sha256") if isinstance(original, dict) else None,
                                           unavailable_run_sha256=trial.get("sha256") if source_sha is None else None))
    run_path = folder / "run.json"
    run_id = _sha(run_path) if run_path.is_file() else data.artifact_identity(dict(missing_run_manifest=True, terminal_sha256=trial.get("sha256")))
    contract = features.feature_contract(adapter)
    values = {column["name"]: None for column in contract["features"]}
    feature_reasons = []
    reasons = []
    if source_path:
        try:
            evidence.file(source_path, original.get("sha256"))
            values, feature_reasons = _extract(adapter, source_path)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            reasons.append("pre-decision source invalid: " + str(exc))
    else:
        reasons.append("original pre-decision input is absent")
    observation = None
    terminal = {}
    manifest = raw
    valid = True
    try:
        if adapter == "routing":
            observation = outcomes.cli_observation(evidence, trial)
            reasons.extend(observation["unknowns"])
            manifest = evidence.read(folder / "run.json")
            terminal = evidence.read(folder / "result.json", trial["sha256"])
        else:
            _, terminal, manifest, _, _ = outcomes.sealed_run(evidence, trial["path"], trial["sha256"])
    except (OSError, ValueError, KeyError, TypeError, IndexError, ArithmeticError) as exc:
        valid = False
        reasons.append("sealed observation invalid: " + str(exc))
    valid = valid and source_sha is not None and not any(reason.startswith("pre-decision source invalid") for reason in reasons)
    elapsed = terminal.get("elapsed_s") if _finite(terminal.get("elapsed_s")) else None
    if adapter == "routing":
        known_controls = bool(observation and observation.get("policy_fingerprint"))
        policy = evidence.read(folder / trial["execution_policy"]) if known_controls else {}
        solver_budget = policy.get("effort", {}).get("router_timeout_s")
        budget = manifest.get("timeout_s")
        budget = budget if _finite(budget) and budget > 0 else None
        full = observation.get("full_gate_success") if observation else False
        native = observation.get("native") if observation else None
        accepted = bool(known_controls and full and elapsed is not None and budget is not None and elapsed <= budget)
        quality = observation.get("routed_quality", {}) if observation else {}
        targets = dict(accepted_within_budget=int(bool(full and elapsed <= budget)) if known_controls and elapsed is not None and budget is not None else None,
                       owned_elapsed_s=elapsed,
                       successful_completion_elapsed_s=elapsed if full else None,
                       native_errors=native["errors"] if native else None,
                       native_opens=native["opens"] if native else None,
                       native_parity=native["parity"] if native else None)
        targets.update({name: quality.get(name) if accepted else None
                        for name in ("routed_track_length_mm", "routed_via_count")})
        added = (_added_track_length(evidence, source_path, source_sha, quality) if accepted and valid else
                 dict(definition=ADDED_LENGTH_DEFINITION["id"], added_route_track_length_mm=None,
                      unknowns={"added_route_track_length_mm": "complete within-budget acceptance and known effective controls required"}))
        targets["added_route_track_length_mm"] = added["added_route_track_length_mm"]
        case = observation.get("case_fingerprint") if observation else None
        pose = observation.get("placement_pose_fingerprint") if observation else None
        details = dict(observation=observation or {}, added_route_quality=added,
                       controls_known=known_controls, owned_run_budget_s=budget,
                       solver_timeout_s=solver_budget, acceptance_budget_source="run.json:timeout_s",
                       completion_censoring=dict(observed=bool(full and elapsed is not None),
                           elapsed_to_terminal_s=elapsed, terminal_status=terminal.get("status"),
                           cause=None if full else "successful completion was not observed"))
    else:
        targets = dict(run_passed=int(terminal["status"] == "passed") if valid else None, owned_elapsed_s=elapsed)
        source_context = _workflow_source_context(evidence, folder, manifest) if valid else []
        case = data.artifact_identity(dict(manifest=features.workflow_case(manifest), native_sources=source_context))
        pose = None
        details = dict(status=terminal.get("status"), cause=terminal.get("cause"),
                       predecision_native_sources=source_context, timing=terminal.get("timing"),
                       timing_scope="owned supervised operation to terminal outcome; no physical qualification")
    row = dict(id=trial["id"], family=trial["family"], split=trial["split"],
               source_fingerprint=source_id, run_fingerprint=run_id,
               case_fingerprint=case or data.artifact_identity(dict(unverified_case=source_id, manifest=features.workflow_case(raw))),
               evidence_valid=valid, features=values, targets=targets,
               ineligible_reasons=sorted(set(reasons)), feature_unknowns=feature_reasons,
               source=dict(path=str(source_path) if source_path else None, sha256=source_sha),
               run=dict(path=str(folder), result_sha256=trial.get("sha256")), **details)
    if pose:
        row["pose_fingerprint"] = pose
    return row


def build_dataset(root, manifest, dataset_id=None):
    path, value = _manifest(root, manifest, CORPUS)
    closure = manifest_dependencies(root, path)
    _check_closure(root, closure)
    evidence = outcomes.Evidence(root)
    evidence.file(path)
    adapter = value["adapter"]
    rows = [_row(root, trial, adapter, evidence) for trial in value["trials"]]
    inputs = _check_closure(root, closure)
    for name, digest in evidence.inputs.items():
        if name in inputs and inputs[name] != digest:
            raise ValueError("source changed during observation: " + name)
        inputs[name] = digest
    contract = features.feature_contract(adapter)
    metadata = dict(adapter=adapter, feature_contract=contract,
                    source_manifest=dict(path=str(path), sha256=inputs[str(path)]),
                    absent_inputs=[name for name, digest in closure.items() if digest is None],
                    qualification="advisory observations only; no CAD or physical qualification")
    if adapter == "routing":
        metadata["derived_targets"] = {"added_route_track_length_mm": ADDED_LENGTH_DEFINITION}
    result = data.finalize_dataset(root, dataset_id=dataset_id or value.get("dataset_id"), task=_task(adapter),
                                   feature_names=[column["name"] for column in contract["features"]],
                                   target_specs=ROUTING_TARGETS if adapter == "routing" else WORKFLOW_TARGETS,
                                   rows=rows, inputs=inputs, metadata=metadata)
    _check_closure(root, closure)
    return result


def make_feature_packet(root, manifest, packet_id=None):
    path, value = _manifest(root, manifest, REQUEST)
    closure = manifest_dependencies(root, path)
    inputs = _check_closure(root, closure)
    adapter = value["adapter"]
    contract = features.feature_contract(adapter)
    rows = []
    seen = set()
    for sample in value["samples"]:
        if not isinstance(sample.get("id"), str) or not sample["id"] or sample["id"] in seen:
            raise ValueError("feature samples require unique nonempty IDs")
        seen.add(sample["id"])
        descriptor = sample["source"]
        source = _resolve(root, descriptor["path"])
        if not isinstance(descriptor.get("sha256"), str) or inputs.get(str(source)) != descriptor["sha256"]:
            raise ValueError("feature source changed or lacks its expected hash")
        measured, reasons = _extract(adapter, source)
        rows.append(dict(id=sample["id"], source=dict(path=str(source), sha256=descriptor["sha256"]),
                         features=measured, eligibility=dict(features=all(value is not None for value in measured.values()), reasons=reasons)))
    identity = packet_id or value.get("id")
    if not isinstance(identity, str) or not identity:
        raise ValueError("feature packet requires an ID")
    result = dict(schema=PACKET, id=identity, task=_task(adapter),
                  feature_names=[column["name"] for column in contract["features"]],
                  feature_contract=contract, rows=sorted(rows, key=lambda row: row["id"]), inputs=inputs)
    result["content_sha256"] = data.artifact_identity(result)
    _check_closure(root, closure)
    return result


def load_feature_packet(root, path):
    """Verify sources/current extractor and re-extract every prediction feature."""
    value = _json(_resolve(root, path))
    if set(value) != {"schema", "id", "task", "feature_names", "feature_contract", "rows", "inputs", "content_sha256"} or value.get("schema") != PACKET:
        raise ValueError("unsupported feature packet schema")
    payload = {key: item for key, item in value.items() if key != "content_sha256"}
    if data.artifact_identity(payload) != value["content_sha256"]:
        raise ValueError("feature packet content identity mismatch")
    data.assert_unchanged(root, value["inputs"])
    adapter = value.get("feature_contract", {}).get("adapter")
    contract = features.feature_contract(adapter)
    if (value["feature_contract"] != contract or value["task"] != _task(adapter)
            or value["feature_names"] != [column["name"] for column in contract["features"]]):
        raise ValueError("feature packet extractor contract changed")
    required = _code_inputs()
    if any(value["inputs"].get(name) != digest for name, digest in required.items()):
        raise ValueError("feature packet omits current extractor source bindings")
    if not isinstance(value["rows"], list):
        raise ValueError("feature packet rows must be a list")
    seen = set()
    for row in value["rows"]:
        if not isinstance(row, dict) or set(row) != {"id", "source", "features", "eligibility"}:
            raise ValueError("feature packet rows cannot carry outcomes or undeclared fields")
        if not isinstance(row["id"], str) or not row["id"] or row["id"] in seen:
            raise ValueError("feature packet sample IDs must be unique")
        seen.add(row["id"])
        descriptor = row["source"]
        if not isinstance(descriptor, dict) or set(descriptor) != {"path", "sha256"}:
            raise ValueError("feature packet source binding is malformed")
        source = _resolve(root, descriptor["path"])
        if value["inputs"].get(str(source)) != descriptor["sha256"]:
            raise ValueError("feature packet source is not in its bound inventory")
        measured, reasons = _extract(adapter, source)
        expected = dict(features=all(item is not None for item in measured.values()), reasons=reasons)
        if data.artifact_identity(row["features"]) != data.artifact_identity(measured) or data.artifact_identity(row["eligibility"]) != data.artifact_identity(expected):
            raise ValueError("feature packet values differ from original source extraction")
        row["features"] = {name: measured[name] for name in value["feature_names"]}
    data.assert_unchanged(root, value["inputs"])
    return value
