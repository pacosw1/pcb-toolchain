"""Frozen, advisory search ranking. No model may establish CAD acceptance.

Training consumes the existing sealed PCB-ML dataset, including its source,
family split, feature producer and label eligibility checks. Optional torch and
coremltools dependencies belong in an isolated Python 3.12 environment.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path

import pcb_ml_models as base

SCHEMA = "iot-lab.pcb-engine-ranker.v1"


def _seal(value):
    value = copy.deepcopy(value)
    value.pop("artifact_sha256", None)
    value["artifact_sha256"] = base._identity(value)
    return value


def _load(root, path):
    model = json.loads((Path(root) / path).read_text(), object_pairs_hook=base._unique_object)
    if model.get("schema") != SCHEMA or _seal(model) != model:
        raise ValueError("invalid engine model schema or checksum")
    if model.get("architecture") != [len(model["feature_names"]), 64, 32, 1]:
        raise ValueError("unsupported ranker architecture")
    base._contract_inputs(root, model["feature_contract"], model["feature_names"])
    if base._identity(model["feature_contract"]) != model["feature_contract_sha256"]:
        raise ValueError("feature contract checksum mismatch")
    if model["implementation_sha256"] != base._sha(__file__):
        raise ValueError("ranker implementation changed; rebuild model")
    widths = model["architecture"]
    for index, incoming, outgoing in zip((0, 2, 4), widths, widths[1:]):
        weight, bias = model["state"][f"{index}.weight"], model["state"][f"{index}.bias"]
        if len(weight) != outgoing or len(bias) != outgoing or any(len(row) != incoming for row in weight):
            raise ValueError("ranker parameter dimensions mismatch")
        for value in bias + [v for row in weight for v in row]:
            base._number(value, "ranker parameter")
    for name in model["feature_names"]:
        bounds = model["ranges"][name]
        if len(bounds) != 2 or any(not base._finite(v) for v in bounds) or bounds[0] > bounds[1]:
            raise ValueError("invalid training feature range")
    if (not base._finite(model["target_transform"]["center"])
            or not base._finite(model["target_transform"]["scale"])
            or model["target_transform"]["scale"] <= 0):
        raise ValueError("invalid target normalization")
    return model


def _network(torch, width):
    return torch.nn.Sequential(torch.nn.Linear(width, 64), torch.nn.ReLU(),
                               torch.nn.Linear(64, 32), torch.nn.ReLU(),
                               torch.nn.Linear(32, 1))


def train(root, dataset_path, *, model_id, target, output=None, epochs=200,
          seed=0, device="auto", learning_rate=0.001):
    """Fit TRAIN only. Unknown/ineligible outcomes are retained but never labels."""
    if not isinstance(epochs, int) or isinstance(epochs, bool) or epochs < 1:
        raise ValueError("epochs must be positive")
    if not math.isfinite(learning_rate) or learning_rate <= 0:
        raise ValueError("learning rate must be finite and positive")
    # Reuse all existing input checks, normalization, weighting and lineage.
    ridge = base.train_model(root, dataset_path, model_id=model_id, target=target)
    data = base._dataset(root, dataset_path)
    if ridge["feature_contract"] is None:
        raise ValueError("a versioned feature extractor contract is required")
    import torch
    if device not in ("auto", "cpu", "mps"):
        raise ValueError("device must be auto, cpu or mps")
    available = torch.backends.mps.is_available()
    selected = "mps" if device == "auto" and available else ("cpu" if device == "auto" else device)
    if selected == "mps" and not available:
        raise ValueError("MPS requested but unavailable")
    torch.manual_seed(seed)
    rows = [r for r in data["rows"] if r["split"] == "train" and base._usable(r, target)]
    normalization = ridge["normalization"]["columns"]
    x = torch.tensor([base._transform(r["features"], normalization) for r in rows],
                     dtype=torch.float32, device=selected)
    labels = [r["targets"][target] for r in rows]
    center = base._average(labels, base._weights(rows))
    scale = max(max(abs(v - center) for v in labels), 1.0)
    y = torch.tensor([(v - center) / scale for v in labels], dtype=torch.float32, device=selected)
    w = torch.tensor(base._weights(rows), dtype=torch.float32, device=selected)
    network = _network(torch, len(data["feature_names"])).to(selected)
    optimizer = torch.optim.Adam(network.parameters(), lr=learning_rate)
    for _ in range(epochs):
        optimizer.zero_grad()
        loss = ((network(x).flatten() - y).square() * w).sum() / w.sum()
        loss.backward()
        optimizer.step()
    if selected == "mps":
        torch.mps.synchronize()
    network.cpu().eval()
    result = copy.deepcopy(ridge)
    result.update(schema=SCHEMA, architecture=[len(data["feature_names"]), 64, 32, 1],
                  implementation_sha256=base._sha(__file__),
                  algorithm=dict(name="mlp-64-32-relu", epochs=epochs, seed=seed,
                                 learning_rate=learning_rate),
                  state={k: v.detach().tolist() for k, v in network.state_dict().items()},
                  target_transform=dict(center=center, scale=scale),
                  training_device=selected, torch_version=torch.__version__,
                  production_enabled=False, promotion=False,
                  ranges={name: [min(r["features"][name] for r in rows),
                                 max(r["features"][name] for r in rows)]
                          for name in data["feature_names"]},
                  ridge_reference=ridge)
    result.pop("parameters")
    result = _seal(result)
    base._check_inputs(ridge["training"]["inputs"])
    base._write(root, output, result, protected=list(ridge["training"]["inputs"]))
    return result


def _predict(model, features):
    values = base._transform(features, model["normalization"]["columns"])
    for index in (0, 2, 4):
        weight, bias = model["state"][f"{index}.weight"], model["state"][f"{index}.bias"]
        values = [math.fsum(a * b for a, b in zip(row, values)) + offset
                  for row, offset in zip(weight, bias)]
        if index != 4:
            values = [max(0.0, v) for v in values]
    score = values[0] * model["target_transform"]["scale"] + model["target_transform"]["center"]
    if model["target_spec"]["type"] == "binary":
        score = max(0.0, min(1.0, score))
    return base._number(score, "MLP score")


class FrozenRanker:
    """Loads weights once. File replacements cannot change an active run."""
    def __init__(self, model_path, root=".", allow_experimental=False):
        self._model = _load(root, model_path)
        self.model_sha256 = self._model["artifact_sha256"]
        self.enabled = allow_experimental or self._model.get("production_enabled") is True

    def score(self, features, feature_contract):
        model = self._model
        if not self.enabled:
            return None, "model_not_promoted"
        if base._identity(feature_contract) != model["feature_contract_sha256"]:
            return None, "feature_contract_mismatch"
        if list(features) != model["feature_names"]:
            return None, "feature_columns_mismatch"
        for name, value in features.items():
            if not base._finite(value):
                return None, "unknown_or_nonfinite_feature"
            low, high = model["ranges"][name]
            if value < low or value > high:
                return None, "outside_training_range"
        return _predict(model, features), None

    def rank(self, candidates, feature_contract, budget=None):
        """Reserve ceil(25% of budget) slots for deterministic production order."""
        if len({c["id"] for c in candidates}) != len(candidates):
            raise ValueError("candidate ids must be unique")
        for c in candidates:
            base._number(c["production_score"], "production score")
        if budget is not None and (isinstance(budget, bool) or not isinstance(budget, int) or budget < 0):
            raise ValueError("candidate budget must be a nonnegative integer")
        limit = len(candidates) if budget is None else min(len(candidates), budget)
        deterministic = sorted(candidates, key=lambda c: (c["production_score"], c["id"]))
        explore_count = math.ceil(limit / 4)
        explore = deterministic[:explore_count]
        used = {c["id"] for c in explore}
        scored, fallback = [], []
        sign = 1 if self._model["target_spec"]["direction"] == "min" else -1
        for candidate in deterministic:
            if candidate["id"] in used:
                continue
            score, reason = self.score(candidate["features"], feature_contract)
            if score is None:
                fallback.append(dict(id=candidate["id"], reason=reason))
            else:
                scored.append((sign * score, candidate["id"], candidate))
        selected = [c for _, _, c in sorted(scored)[:limit - explore_count]]
        used.update(c["id"] for c in selected)
        selected += [c for c in deterministic if c["id"] not in used][:limit - explore_count - len(selected)]
        return dict(candidates=explore + selected, model_sha256=self.model_sha256,
                    deterministic_exploration_ids=[c["id"] for c in explore],
                    fallback=fallback, advisory=True)


class CoreMLRanker(FrozenRanker):
    """Same frozen admission and OOD policy, with native persistent inference."""
    def __init__(self, model_path, package_path, worker, root=".",
                 compute_units="cpuOnly", allow_experimental=False):
        super().__init__(model_path, root, allow_experimental)
        package = Path(package_path).resolve()
        registry = json.loads(package.with_suffix(".registry.json").read_text())
        files = {str(p.relative_to(package)): base._sha(p) for p in sorted(package.rglob("*")) if p.is_file()}
        if (registry.get("model_sha256") != self.model_sha256
                or registry.get("files") != files
                or registry.get("package_identity") != base._identity(files)
                or registry.get("feature_names") != self._model["feature_names"]
                or registry.get("feature_contract_sha256") != self._model["feature_contract_sha256"]
                or registry.get("normalization") != self._model["normalization"]
                or registry.get("target_transform") != self._model["target_transform"]
                or registry.get("precision") not in ("float16", "float32")):
            raise ValueError("Core ML package registry mismatch")
        self.worker = worker
        self.precision = registry.get("precision", "float32")
        response = worker.request("coreml.load", model_path=str(package), compute_units=compute_units)
        if not response.get("ok"):
            raise ValueError(response.get("error", "Core ML load failed"))
        self.native_id = response["result"]["model_id"]
        self.last_metrics = {}

    def score(self, features, feature_contract):
        reference, reason = super().score(features, feature_contract)
        if reference is None:
            return None, reason
        try:
            response = self.worker.request("coreml.predict", model_id=self.native_id,
                inputs={"features": base._transform(features, self._model["normalization"]["columns"])})
            if not response.get("ok"):
                return None, "coreml_prediction_failed"
            outputs = list(response["result"]["outputs"].values())
            if len(outputs) != 1 or len(outputs[0]) != 1:
                return None, "coreml_output_shape_mismatch"
            raw = base._number(outputs[0][0], "Core ML output")
            score = raw * self._model["target_transform"]["scale"] + self._model["target_transform"]["center"]
            if self._model["target_spec"]["type"] == "binary":
                score = max(0.0, min(1.0, score))
            self.last_metrics = response.get("metrics", {})
            tolerance = 2e-3 if self.precision == "float16" else 1e-4
            if not math.isclose(score, reference, rel_tol=tolerance,
                                abs_tol=tolerance * self._model["target_transform"]["scale"]):
                return None, "coreml_reference_mismatch"
            return score, None
        except (ValueError, KeyError, OSError, RuntimeError):
            return None, "coreml_unavailable"

    def profile(self):
        return self.worker.request("coreml.profile", model_id=self.native_id)

    def close(self):
        if self.native_id:
            self.worker.request("coreml.unload", model_id=self.native_id)
            self.native_id = None


def evaluate(root, model_path, dataset_path, output=None):
    model, data = _load(root, model_path), base._dataset(root, dataset_path)
    if (data["task"] != model["task"] or data["feature_names"] != model["feature_names"]
            or base._identity(data["metadata"].get("feature_contract")) != model["feature_contract_sha256"]
            or data["target_specs"].get(model["target"]) != model["target_spec"]):
        raise ValueError("evaluation contract mismatch")
    for split, groups in model["training"]["split_groups"].items():
        for field, values in groups.items():
            if any(r[field] in values and r["split"] != split for r in data["rows"]):
                raise ValueError("evaluation relabels a previously bound split")
    target, folds = model["target"], {}
    predictions = {r["id"]: _predict(model, r["features"]) if base._usable(r) else None for r in data["rows"]}
    ridge = {r["id"]: base._prediction(model["ridge_reference"], r["features"])[0] if base._usable(r) else None for r in data["rows"]}
    proxy = data["metadata"].get("proxy_baseline")
    for split in base.SPLITS:
        rows = [r for r in data["rows"] if r["split"] == split]
        folds[split] = dict(counts=base._counts(rows, target), outcomes=base._outcomes(rows),
            mlp=base._metrics(rows, predictions, target, model["target_spec"]["type"]),
            ridge=base._metrics(rows, ridge, target, model["target_spec"]["type"]),
            within_case=base._ranking(rows, predictions, target, model["target_spec"]["direction"]))
        if proxy:
            if proxy["feature"] not in model["feature_names"] or proxy["direction"] not in ("min", "max"):
                raise ValueError("invalid production proxy declaration")
            scores = {r["id"]: r["features"][proxy["feature"]] if base._usable(r) else None for r in rows}
            folds[split]["production_proxy"] = base._ranking(rows, scores, target, proxy["direction"], model["target_spec"]["direction"])
        else:
            folds[split]["production_proxy"] = dict(status="unknown", reason="not declared")
    result = dict(schema="iot-lab.pcb-engine-ranker-evaluation.v1", folds=folds,
                  model_sha256=model["artifact_sha256"], dataset_sha256=data["content_sha256"],
                  promotion=False, production_enabled=False,
                  reason="Offline metrics do not establish improved accepted engine outcomes.")
    base._write(root, output, result, protected=[model_path, dataset_path])
    return result


def export_coreml(root, model_path, output, precision="float16"):
    """Export fixed [1,features] normalized input; registry binds package bytes."""
    model = _load(root, model_path)
    if precision not in ("float16", "float32"):
        raise ValueError("precision must be float16 or float32")
    destination = Path(output).resolve()
    registry_path = destination.with_suffix(".registry.json")
    if destination.exists() or registry_path.exists():
        raise ValueError("export destination or registry already exists")
    import torch
    import coremltools as ct
    network = _network(torch, len(model["feature_names"]))
    network.load_state_dict({k: torch.tensor(v, dtype=torch.float32) for k, v in model["state"].items()})
    network.eval()
    traced = torch.jit.trace(network, torch.zeros(1, len(model["feature_names"])))
    converted = ct.convert(traced, convert_to="mlprogram",
                           inputs=[ct.TensorType(name="features", shape=(1, len(model["feature_names"])))],
                           minimum_deployment_target=ct.target.macOS13,
                           compute_precision=ct.precision.FLOAT16 if precision == "float16" else ct.precision.FLOAT32)
    converted.save(str(destination))
    files = {str(p.relative_to(destination)): base._sha(p) for p in sorted(destination.rglob("*")) if p.is_file()}
    registry = dict(schema="iot-lab.pcb-engine-coreml-registry.v1",
                    model_sha256=model["artifact_sha256"], files=files,
                    feature_names=model["feature_names"], feature_contract_sha256=model["feature_contract_sha256"],
                    normalization=model["normalization"], target_transform=model["target_transform"],
                    package_identity=base._identity(files), precision=precision, promotion=False,
                    output_semantics="normalized raw score; inverse target transform and binary clamp required")
    base._write(root, registry_path, registry, protected=[model_path])
    return registry


def verify_public_corpus(manifest):
    """Verify attributable public source files before normal sealed observation."""
    allowed = {"CC0-1.0", "CC-BY-4.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"}
    if manifest.get("schema") != "iot-lab.pcb-engine-public-corpus.v1":
        raise ValueError("unknown public corpus schema")
    for source in manifest["sources"]:
        if source.get("license") not in allowed or not source.get("url") or not source.get("attribution"):
            raise ValueError("public corpus requires compatible license, URL and attribution")
        if base._sha(source["path"]) != source["sha256"]:
            raise ValueError("public corpus source checksum mismatch")
    return dict(status="source_verified", sources=copy.deepcopy(manifest["sources"]),
                labels_eligible=False, next="Collect sealed routing observations through PCB-ML adapters.")
