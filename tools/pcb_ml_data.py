"""Source-bound advisory ML tables; no CAD qualification or inferred labels.

Adapters own the semantic attribution of pre-decision features, targets and row
fingerprints. This module verifies their JSON contract and source bytes. A hash
is an integrity check, not proof that an authored feature describes its source.
Independent repetitions may share source/case/pose within one split. Aliases of
one sealed run remain visible but cannot become independent training samples.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re


SCHEMA = "iot-lab.pcb-ml-dataset.v1"
SPLITS = ("train", "validation", "test")
TARGET_TYPES = ("binary", "regression")
DIRECTIONS = ("min", "max")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_FIELDS = {"schema", "dataset_id", "task", "feature_names", "target_specs",
           "rows", "inputs", "metadata", "content_sha256"}


def _json_copy(value):
    """Reject ambiguous/non-JSON data before canonical hashing or copying."""
    if value is None or type(value) in (str, bool, int):
        return value
    if type(value) is float:
        if not math.isfinite(value):
            raise ValueError("nonfinite JSON number")
        return value
    if isinstance(value, list):
        return [_json_copy(item) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings")
        return {key: _json_copy(item) for key, item in value.items()}
    raise ValueError("unsupported JSON value: " + type(value).__name__)


def artifact_identity(value):
    """SHA256 of canonical finite JSON, independent of object key order."""
    try:
        encoded = json.dumps(_json_copy(value), sort_keys=True, ensure_ascii=False,
                             separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, OverflowError, UnicodeError, RecursionError) as exc:
        raise ValueError("artifact is not canonical JSON") from exc
    return hashlib.sha256(encoded).hexdigest()


def _hash(path):
    digest = hashlib.sha256()
    try:
        if not path.is_file():
            raise ValueError("source artifact is missing or not a regular file: " + str(path))
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        raise ValueError("cannot read source artifact: " + str(path)) from exc
    return digest.hexdigest()


def _fingerprint(value, label):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise ValueError(label + " must be a lowercase SHA256")
    return value


def _text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(label + " must be a nonempty string")
    return value


def _inputs(root, inputs):
    if not isinstance(inputs, dict) or not inputs:
        raise ValueError("dataset inputs must contain source artifacts")
    root = Path(root).resolve()
    result = {}
    for name, expected in inputs.items():
        _text(name, "input path")
        _fingerprint(expected, "input hash")
        try:
            path = Path(name)
            path = (path if path.is_absolute() else root / path).resolve()
        except (OSError, RuntimeError, ValueError) as exc:
            raise ValueError("invalid source artifact path: " + name) from exc
        key = str(path)
        if key in result and result[key] != expected:
            raise ValueError("conflicting hashes for aliased source artifact: " + key)
        result[key] = expected
    return dict(sorted(result.items()))


def assert_unchanged(root, inputs):
    """Verify every supplied artifact; accepts relative or external absolute paths."""
    normalized = _inputs(root, inputs)
    for name, expected in normalized.items():
        if _hash(Path(name)) != expected:
            raise ValueError("source artifact changed: " + name)
    return normalized


def _names(values, label):
    if not isinstance(values, list) or not values:
        raise ValueError(label + " must be a nonempty ordered list")
    for name in values:
        _text(name, label + " name")
    if len(values) != len(set(values)):
        raise ValueError(label + " contains duplicate names")
    return list(values)


def _target_specs(specs, feature_names):
    if not isinstance(specs, dict) or not specs:
        raise ValueError("target_specs must be a nonempty object")
    result = {}
    for name, spec in specs.items():
        _text(name, "target name")
        if name in feature_names:
            raise ValueError("feature name also names a target: " + name)
        if not isinstance(spec, dict) or set(spec) - {"type", "direction", "unit"}:
            raise ValueError("unsupported target specification: " + name)
        if spec.get("type") not in TARGET_TYPES or spec.get("direction") not in DIRECTIONS:
            raise ValueError("target requires type and direction: " + name)
        if "unit" in spec:
            _text(spec["unit"], "target unit")
        result[name] = _json_copy(spec)
    return result


def _numeric(value, label):
    if type(value) not in (int, float):
        raise ValueError(label + " must be a finite number, not a boolean")
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise ValueError(label + " must be finite")
    return value


def _rows(rows, features, specs):
    if not isinstance(rows, list):
        raise ValueError("rows must be a list")
    result = []
    ids = set()
    split_owners = {name: {} for name in ("family", "case_fingerprint", "source_fingerprint", "run_fingerprint", "pose")}
    run_owners = {}
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError("each row must be an object")
        row = _json_copy(raw)
        row_id = _text(row.get("id"), "row id")
        if row_id in ids:
            raise ValueError("duplicate row id: " + row_id)
        ids.add(row_id)
        _text(row.get("family"), "row family")
        for name in ("case_fingerprint", "source_fingerprint", "run_fingerprint"):
            _fingerprint(row.get(name), "row " + name)
        if row.get("pose_fingerprint") is not None:
            _fingerprint(row["pose_fingerprint"], "row pose_fingerprint")
        split = row.get("split")
        if split not in SPLITS:
            raise ValueError("invalid row split: " + str(split))
        if type(row.get("evidence_valid")) is not bool:
            raise ValueError("row evidence_valid must be a boolean: " + row_id)
        adapter_reasons = row.get("ineligible_reasons", [])
        if not isinstance(adapter_reasons, list) or any(not isinstance(reason, str) or not reason.strip() for reason in adapter_reasons):
            raise ValueError("ineligible_reasons must contain nonempty strings: " + row_id)
        values = row.get("features")
        targets = row.get("targets")
        if not isinstance(values, dict) or set(values) - set(features):
            raise ValueError("row features differ from feature_names: " + row_id)
        if not isinstance(targets, dict) or set(targets) - set(specs):
            raise ValueError("row targets differ from target_specs: " + row_id)
        row["features"] = {name: None if values.get(name) is None else _numeric(values[name], "feature " + name) for name in features}
        row["targets"] = {}
        for name, spec in specs.items():
            value = targets.get(name)
            if value is not None:
                _numeric(value, "target " + name)
                if spec["type"] == "binary" and (type(value) is not int or value not in (0, 1)):
                    raise ValueError("binary target must be integer 0 or 1: " + name)
            row["targets"][name] = value
        # Partition all observations, including failed/ineligible ones. Relabeling
        # an unusable row must not provide a route around held-out case isolation.
        for name, owners in split_owners.items():
            if name == "pose":
                key = (row["case_fingerprint"], row["pose_fingerprint"]) if row.get("pose_fingerprint") is not None else None
            else:
                key = row[name]
            if key is None:
                continue
            if key in owners and owners[key] != split:
                raise ValueError("cross-split " + name + " leakage: " + row_id)
            owners[key] = split
        # Duplicate run aliases must agree on their attributed sample and label.
        attribution = {key: row.get(key) for key in (
            "family", "case_fingerprint", "source_fingerprint", "pose_fingerprint",
            "features", "targets", "evidence_valid")}
        attribution["ineligible_reasons"] = adapter_reasons
        signature = artifact_identity(attribution)
        run = row["run_fingerprint"]
        if run in run_owners and run_owners[run][0] != signature:
            raise ValueError("conflicting observations for one sealed run: " + row_id)
        owner = min(row_id, run_owners[run][1]) if run in run_owners else row_id
        run_owners[run] = (signature, owner)
        result.append(row)
    for row in result:
        reasons = []
        valid = row["evidence_valid"] and not row.get("ineligible_reasons")
        if not row["evidence_valid"]:
            reasons.append({"code": "evidence_invalid"})
        for reason in row.get("ineligible_reasons", []):
            reasons.append({"code": "adapter_ineligible", "cause": reason})
        owner = run_owners[row["run_fingerprint"]][1]
        if row["id"] != owner:
            valid = False
            reasons.append({"code": "duplicate_run", "duplicate_of": owner})
        feature_ok = valid
        for name, value in row["features"].items():
            if value is None:
                feature_ok = False
                reasons.append({"code": "feature_unknown", "feature": name})
        target_ok = {}
        for name, value in row["targets"].items():
            target_ok[name] = valid and value is not None
            if value is None:
                reasons.append({"code": "target_unknown", "target": name})
        row["eligibility"] = {"features": feature_ok, "targets": target_ok, "reasons": reasons}
    return sorted(result, key=lambda row: row["id"])


def _payload(root, *, dataset_id, task, feature_names, target_specs, rows, inputs, metadata=None):
    features = _names(feature_names, "feature_names")
    specs = _target_specs(target_specs, features)
    if metadata is not None and not isinstance(metadata, dict):
        raise ValueError("metadata must be an object")
    result = {"schema": SCHEMA, "dataset_id": _text(dataset_id, "dataset_id"),
              "task": _text(task, "task"), "feature_names": features,
              "target_specs": specs, "rows": _rows(rows, features, specs),
              "inputs": _inputs(root, inputs), "metadata": _json_copy(metadata or {})}
    result["content_sha256"] = artifact_identity(result)
    return result


def finalize_dataset(root, *, dataset_id, task, feature_names, target_specs, rows, inputs, metadata=None):
    """Validate and seal a table; caller persists the returned JSON unchanged."""
    source_inputs = assert_unchanged(root, inputs)
    result = _payload(root, dataset_id=dataset_id, task=task, feature_names=feature_names,
                      target_specs=target_specs, rows=rows, inputs=source_inputs, metadata=metadata)
    assert_unchanged(root, source_inputs)
    return result


def _validate(root, value):
    if not isinstance(value, dict) or set(value) != _FIELDS or value.get("schema") != SCHEMA:
        raise ValueError("unsupported or malformed dataset schema")
    expected = _fingerprint(value["content_sha256"], "dataset content_sha256")
    if artifact_identity({key: item for key, item in value.items() if key != "content_sha256"}) != expected:
        raise ValueError("dataset content identity mismatch")
    args = {key: value[key] for key in _FIELDS - {"schema", "content_sha256"}}
    normalized = _payload(root, **args)
    if normalized != value:
        raise ValueError("dataset eligibility or normalized contract mismatch")
    return normalized


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key: " + key)
        result[key] = value
    return result


def _constant(value):
    raise ValueError("nonfinite JSON number: " + value)


def load_dataset(root, path):
    """Load a sealed table and verify its current source artifacts twice."""
    path = Path(path)
    if not path.is_absolute():
        path = Path(root) / path
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_object, parse_constant=_constant)
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("cannot read dataset: " + str(path)) from exc
    if not isinstance(value, dict):
        raise ValueError("dataset must be an object")
    source_inputs = assert_unchanged(root, value.get("inputs"))
    result = _validate(root, value)
    assert_unchanged(root, source_inputs)
    return result


def split_rows(dataset, split, target=None):
    """Return eligible rows, without filling unknowns or changing trial weights.

    Call load_dataset first to verify sources. This pure selector revalidates
    the table's seal/eligibility and does not re-read source artifacts.
    """
    if split not in SPLITS:
        raise ValueError("invalid dataset split: " + str(split))
    validated = _validate(Path("/"), dataset)
    if target is not None and target not in validated["target_specs"]:
        raise ValueError("unknown target: " + str(target))
    return [row for row in validated["rows"] if row["split"] == split and row["eligibility"]["features"]
            and (target is None or row["eligibility"]["targets"][target])]
