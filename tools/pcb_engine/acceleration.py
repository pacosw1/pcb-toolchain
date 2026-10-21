"""Sealed CLI observations for compute capabilities and measured workload selection."""
from pathlib import Path
import json
import math

import lean_workflow as lean
from pcb_workflow import board_config, sha
from .compute import ComputeWorker, validate_request

SCHEMA = "iot-lab.compute-observation.v1"
REQUEST_SCHEMA = "iot-lab.compute-request.v1"


def observe(root, board, output, *, request_path=None, timeout=60):
    root, output = Path(root).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError("compute observation output already exists")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("finite positive compute timeout required")
    folder, _, stem = board_config(root, board)
    native = stem.with_suffix(".kicad_pcb")
    inputs = {str(path): sha(path) for path in
              [folder / "gate.json"] + [stem.with_suffix(ext) for ext in
               (".kicad_pcb", ".kicad_pro", ".kicad_dru", ".kicad_sch")]
              if path.is_file()}
    if str(native) not in inputs:
        raise ValueError("native board input missing")
    source = Path(__file__).parent
    tools = [Path(__file__).resolve(), source / "compute.py",
             source / "native/worker.mm", source / "native/kernels.metal",
             source / "native/coreml.mm", source / "native/coreml.hpp",
             root / "tools/lean_resources.py", root / "tools/lean_workflow.py",
             root / "tools/pcb_workflow.py", root / "tools/route_decision.py"]
    tool_inputs = {str(p): sha(p) for p in tools if p.is_file()}
    request = None
    if request_path is not None:
        request_path = Path(request_path).resolve()
        if request_path.stat().st_size > 64 * 1024 * 1024:
            raise ValueError("compute request exceeds 64 MiB")
        inputs[str(request_path)] = sha(request_path)
        request = json.loads(request_path.read_text())
        if (not isinstance(request, dict)
                or set(request) - {"schema", "revision", "op", "data", "repetitions"}
                or request.get("schema") != REQUEST_SCHEMA):
            raise ValueError("expected bounded iot-lab.compute-request.v1 object")
        if request.get("revision") != inputs[str(native)]:
            raise ValueError("compute request revision does not match native board SHA256")
        if request.get("op") not in ("placement_hpwl", "congestion", "cost_field"):
            raise ValueError("compute request operation is not a supported mathematical primitive")
        if not isinstance(request.get("data"), dict):
            raise ValueError("compute request data must be an object")
        allowed = {
            "placement_hpwl": {"candidates", "nets", "candidate_deltas", "custom_rules"},
            "congestion": {"width", "height", "layers", "segments", "custom_rules"},
            "cost_field": {"width", "height", "layers", "blocked", "targets", "max_sweeps", "custom_rules"},
        }[request["op"]]
        if set(request["data"]) - allowed:
            raise ValueError("compute request contains unsupported fields")
        validate_request(request["op"], request["data"])
    artifacts = output.parent / (output.stem + "-artifacts")
    artifacts.mkdir(parents=True, exist_ok=False)
    profile_path = artifacts / "calibration.json"
    with ComputeWorker(timeout_s=timeout, calibration_path=profile_path) as worker:
        capabilities = worker.request("capabilities", backend="cpu", revision=inputs[str(native)])
        lean.atomic_json(artifacts / "capabilities.json", capabilities)
        result = dict(schema=SCHEMA, status="passed", qualified=False, board=board,
                      action="compute-calibrate" if request else "compute-status",
                      revision=inputs[str(native)], inputs=inputs, tool_inputs=tool_inputs,
                      capabilities=capabilities["result"],
                      scope="numerical workload observation; no board, backend or model adoption",
                      production_settings_changed=False)
        if request:
            if not capabilities["result"].get("metal_available"):
                result.update(status="blocked", cause="Metal is unavailable; GPU calibration cannot be established")
            else:
                profile = worker.calibrate(request["op"], revision=request["revision"],
                                           repetitions=request.get("repetitions", 9), **request["data"])
                lean.atomic_json(artifacts / "measurement.json", profile)
                result.update(calibration=profile, profile_path=str(profile_path),
                              automatic_backend_for_matching_workload="metal" if profile["promoted"] else "cpu",
                              explicit_profile_required=True)
        if any(not Path(name).is_file() or sha(name) != digest
               for name, digest in {**inputs, **tool_inputs}.items()):
            raise ValueError("compute observation input or implementation changed during measurement")
        result["artifacts"] = {str(p.relative_to(output.parent)): sha(p)
                               for p in artifacts.iterdir() if p.is_file() and p.suffix != ".lock"}
        lean.atomic_json(output, result)
        return result
