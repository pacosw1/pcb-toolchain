"""Persistent Apple compute service; mathematical results never certify board legality."""
from __future__ import annotations

import hashlib
import fcntl
import json
import math
import os
from pathlib import Path
import platform
import select
import statistics
import subprocess
import threading
import time
import uuid
import lean_resources

INF = 1_000_000_000
MAX_CELLS = 1_048_576
MAX_VALUES = 4_194_304


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    allow_nan=False).encode()).hexdigest()


def _materialize(data):
    if "candidate_deltas" not in data:
        return data
    base = data["candidates"][0]
    candidates = []
    for deltas in data["candidate_deltas"]:
        candidate = [list(pair) for pair in base]
        for pin, dx, dy in deltas:
            candidate[pin][0] += dx
            candidate[pin][1] += dy
        candidates.append(candidate)
    return dict(data, candidates=candidates)


def _default_sweeps(cells):
    """Largest default that every admitted grid accepts under the 1e8 work budget."""
    return min(cells, 4096, 100_000_000 // cells)


def _integer(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in [{low}, {high}]")
    return value


def validate_request(op, data):
    """Validate before allocation, including requests that use the Python fallback."""
    if op == "placement_hpwl":
        candidates, nets = data["candidates"], data["nets"]
        if not candidates or not candidates[0]:
            raise ValueError("candidates must contain positions")
        pins = len(candidates[0])
        if len(candidates) * pins * 2 > MAX_VALUES:
            raise ValueError("candidate allocation exceeds budget")
        net_pins = sum(map(len, nets))
        if len(nets) > MAX_VALUES or net_pins > MAX_VALUES:
            raise ValueError("net allocation exceeds budget")
        candidate_count = len(data.get("candidate_deltas", candidates))
        if candidate_count * (net_pins + len(nets)) > 100_000_000:
            raise ValueError("placement work exceeds budget")
        for candidate in candidates:
            if len(candidate) != pins:
                raise ValueError("candidate pin counts differ")
            for pair in candidate:
                if len(pair) != 2 or any(
                    isinstance(v, bool) or not isinstance(v, (int, float))
                    or not math.isfinite(v) or abs(v) > 1e9 or not float(2 * v).is_integer() for v in pair
                ):
                    raise ValueError("positions must be bounded XY pairs on the 0.5 grid")
        for net in nets:
            for pin in net:
                _integer(pin, 0, pins - 1, "pin")
        if "candidate_deltas" in data:
            deltas = data["candidate_deltas"]
            if len(candidates) != 1 or not deltas or len(deltas) * pins * 2 > MAX_VALUES:
                raise ValueError("sparse proposals require one base candidate and bounded output")
            for candidate in deltas:
                seen = set()
                for entry in candidate:
                    if len(entry) != 3:
                        raise ValueError("delta must contain pin index and XY displacement")
                    pin = _integer(entry[0], 0, pins - 1, "delta pin")
                    if pin in seen:
                        raise ValueError("duplicate delta pin")
                    seen.add(pin)
                    for axis, value in enumerate(entry[1:]):
                        if (isinstance(value, bool) or not isinstance(value, (int, float))
                                or not math.isfinite(value) or abs(value) > 1e9
                                or not float(2 * value).is_integer()
                                or abs(candidates[0][pin][axis] + value) > 1e9):
                            raise ValueError("delta must be bounded and on the 0.5 grid")
    elif op in ("congestion", "cost_field"):
        width = _integer(data["width"], 1, MAX_CELLS, "width")
        height = _integer(data["height"], 1, MAX_CELLS, "height")
        layers = _integer(data.get("layers", 1), 1, 64, "layers")
        cells = width * height * layers
        if cells > MAX_CELLS:
            raise ValueError("grid allocation exceeds budget")
        if op == "congestion":
            if layers != 1 or len(data["segments"]) > MAX_CELLS:
                raise ValueError("congestion supports one bounded layer per request")
            for segment in data["segments"]:
                if len(segment) != 4:
                    raise ValueError("segment requires four grid coordinates")
                for i, value in enumerate(segment):
                    _integer(value, 0, (width if i % 2 == 0 else height) - 1, "coordinate")
            if cells * len(data["segments"]) > 100_000_000:
                raise ValueError("congestion work exceeds budget")
        else:
            sweeps = _integer(data.get("max_sweeps", _default_sweeps(cells)), 1, 4096, "max_sweeps")
            if cells * sweeps > 100_000_000:
                raise ValueError("field work exceeds budget")
            for name in ("blocked", "targets"):
                if len(data[name]) > cells:
                    raise ValueError(f"too many {name}")
                for index in data[name]:
                    _integer(index, 0, cells - 1, name)
    elif op == "snapshot.put":
        if data["snapshot_op"] not in ("placement_hpwl", "congestion", "cost_field"):
            raise ValueError("unsupported snapshot operation")
        validate_request(data["snapshot_op"], data["snapshot_data"])
    elif not (op == "capabilities" or op.startswith("coreml.")):
        raise ValueError(f"unknown compute operation {op}")


def cpu_reference(op, data):
    validate_request(op, data)
    if op == "placement_hpwl":
        data = _materialize(data)
        scores = []
        for candidate in data["candidates"]:
            half = [(int(2 * x), int(2 * y)) for x, y in candidate]  # exact half-unit integers
            total = sum(max(half[i][a] for i in net) - min(half[i][a] for i in net)
                        for net in data["nets"] if net for a in (0, 1))
            scores.append(total // 2 if total % 2 == 0 else total / 2)
        return {"scores": scores, "primitive": "hpwl", "complete_objective": False}
    if op == "congestion":
        width, height = data["width"], data["height"]
        counts = [0] * (width * height)
        for x0, y0, x1, y1 in data["segments"]:
            for y in range(min(y0, y1), max(y0, y1) + 1):
                for x in range(min(x0, x1), max(x0, x1) + 1):
                    counts[y * width + x] += 1
        return {"counts": counts, "primitive": "bounding_box_demand"}
    if op == "cost_field":
        w, h, layers = data["width"], data["height"], data.get("layers", 1)
        size, plane = w * h * layers, w * h
        blocked = set(data["blocked"])
        values = [INF] * size
        for target in data["targets"]:
            if target not in blocked:
                values[target] = 0
        sweeps = data.get("max_sweeps", _default_sweeps(size))
        queue = list(dict.fromkeys(t for t in data["targets"] if t not in blocked))
        head, maximum = 0, 0
        while head < len(queue):
            i = queue[head]
            head += 1
            if values[i] >= sweeps:
                continue
            x, y = i % w, i // w % h
            neighbors = []
            if x: neighbors.append(i - 1)
            if x + 1 < w: neighbors.append(i + 1)
            if y: neighbors.append(i - w)
            if y + 1 < h: neighbors.append(i + w)
            if i >= plane: neighbors.append(i - plane)
            if i + plane < size: neighbors.append(i + plane)
            for j in neighbors:
                if j not in blocked and values[j] == INF:
                    values[j] = values[i] + 1
                    maximum = values[j]
                    queue.append(j)
        return {"distances": values, "converged": maximum < sweeps,
                "sweeps": min(maximum + 1, sweeps),
                "guidance_only": True, "unreachable_value": INF}
    if op == "capabilities":
        return {"metal_available": False, "coreml_available": False, "cpu_available": True}
    if op == "snapshot.put":
        return {"snapshot_id": data["snapshot_id"]}
    raise RuntimeError("Core ML requires the native Apple worker")


def build_worker():
    """Content-addressed local build; never installs into application Python."""
    source = Path(__file__).parent / "native"
    files = [Path(__file__), source / "worker.mm", source / "kernels.metal"]
    coreml = source / "coreml.mm"
    if coreml.exists():
        files.extend((coreml, source / "coreml.hpp"))
    compiler = subprocess.check_output(["xcrun", "clang++", "--version"], text=True, timeout=10)
    sdk = subprocess.check_output(["xcrun", "--show-sdk-version"], text=True, timeout=10).strip()
    build_identity = dict(source_sha256={p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
                          compiler=compiler, sdk=sdk, platform=platform.platform(), machine=platform.machine())
    digest = _digest(build_identity)
    root = Path(os.environ.get("PCB_ENGINE_BUILD_DIR", str(Path.home() / ".cache" / "iot-lab" / "pcb-engine")))
    output = root / digest[:20] / "pcb-compute"
    receipt = output.with_name("build.json")
    try:
        existing = json.loads(receipt.read_text())
        if (existing.get("build_identity") == build_identity and output.is_file()
                and os.access(output, os.X_OK)
                and existing.get("binary_sha256") == hashlib.sha256(output.read_bytes()).hexdigest()):
            return output
    except (OSError, ValueError, AttributeError):
        pass
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"build-{os.getpid()}-{uuid.uuid4().hex}")
    command = ["xcrun", "clang++", "-std=c++20", "-O2", "-fobjc-arc", "-fblocks",
               "-framework", "Foundation", "-framework", "Metal",
               str(source / "worker.mm"), "-o", str(temporary)]
    if coreml.exists():
        command.extend(["-DPCB_COREML=1", str(coreml), "-framework", "CoreML"])
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"native compute build failed: {result.stderr[-4000:]}")
    temporary.replace(output)
    receipt_tmp = receipt.with_name(f"receipt-{os.getpid()}-{uuid.uuid4().hex}.tmp")
    receipt_tmp.write_text(json.dumps(dict(build_identity=build_identity, command=command,
                                          binary_sha256=hashlib.sha256(output.read_bytes()).hexdigest()), indent=2) + "\n")
    receipt_tmp.replace(receipt)
    return output


class ComputeWorker:
    """Single bounded synchronous queue; persistent native resources across requests."""
    def __init__(self, *, native=True, timeout_s=60, memory_gib=0.5, calibration_path=None):
        self.timeout_s = timeout_s
        self.process = None
        self._closed = False
        self.lock = threading.Lock()
        self.fallback_reason = None
        self._snapshots = {}
        self._capabilities = None
        self.binary_receipt = None
        self.calibration_path = Path(calibration_path or os.environ.get(
            "PCB_ENGINE_CALIBRATION", str(Path.home() / ".cache/iot-lab/pcb-engine/calibration.json")))
        try:
            self.calibrations = json.loads(self.calibration_path.read_text())["profiles"]
            if not isinstance(self.calibrations, dict) or any(
                    not isinstance(key, str) or not isinstance(value, dict)
                    for key, value in self.calibrations.items()):
                self.calibrations = {}
        except (OSError, ValueError, KeyError, TypeError):
            self.calibrations = {}
        self._reservation = lean_resources.reserve(
            1, memory_gib, wait_s=min(timeout_s, 30), label="pcb-engine-compute"
        )
        self._environment = self._reservation.__enter__()
        try:
            if native and platform.system() == "Darwin":
                try:
                    binary = build_worker()
                    self.binary_receipt = json.loads(binary.with_name("build.json").read_text())
                    self.process = subprocess.Popen(
                        [str(binary), str(Path(__file__).parent / "native" / "kernels.metal")],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        text=True, bufsize=1, env=self._environment,
                    )
                except (OSError, RuntimeError, subprocess.SubprocessError) as error:
                    self.fallback_reason = str(error)
            else:
                self.fallback_reason = "native worker disabled" if not native else "Metal requires macOS"
        except BaseException:
            self.close()
            raise

    def request(self, op, *, revision="", backend="auto", **data):
        if self._closed:
            raise RuntimeError("compute worker is closed")
        if backend not in ("auto", "cpu", "metal"):
            raise ValueError("backend must be auto, cpu or metal")
        wire_data = data
        if "snapshot_id" in data and op != "snapshot.put":
            snapshot = self._snapshots.get(data["snapshot_id"])
            if not snapshot or snapshot["op"] != op or snapshot["revision"] != str(revision):
                raise ValueError("snapshot operation or revision mismatch")
            data = dict(snapshot["data"], **data)
        validate_request(op, data)
        requested_backend = backend
        calibration_id = None
        if backend == "auto" and op in ("placement_hpwl", "congestion", "cost_field"):
            calibration_id = self._calibration_key(op, str(revision), data)
            profile = self.calibrations.get(calibration_id, {})
            backend = "metal" if profile.get("promoted") else "cpu"
        request_id = uuid.uuid4().hex
        payload = dict(wire_data, id=request_id, revision=str(revision), op=op, backend=backend)
        start = time.monotonic()
        with self.lock:
            if self.process:
                try:
                    line = self._exchange(json.dumps(payload, allow_nan=False) + "\n", start + self.timeout_s)
                    result = json.loads(line)
                    if result.get("id") != request_id or result.get("revision") != str(revision):
                        raise RuntimeError("native compute response identity mismatch")
                    result.setdefault("metrics", {})["round_trip_ms"] = (time.monotonic() - start) * 1000
                    if op == "capabilities" and result.get("ok"):
                        result["result"]["worker_build"] = self.binary_receipt
                    result["metrics"].update(requested_backend=requested_backend,
                                             calibration_id=calibration_id)
                    if requested_backend == "auto" and backend == "cpu":
                        result["metrics"]["fallback_reason"] = "no matching promoted workload calibration"
                    return result
                except (OSError, ValueError, RuntimeError) as error:  # includes TimeoutError
                    self.fallback_reason = str(error)
                    self._stop_process()
            result = cpu_reference(op, data)
            return {"ok": True, "id": request_id, "revision": str(revision), "result": result,
                    "metrics": {"backend": "cpu", "dispatches": 0,
                                "fallback_reason": self.fallback_reason,
                                "round_trip_ms": (time.monotonic() - start) * 1000}}

    def _exchange(self, text, deadline):
        """Write one request and read one response line under a single deadline."""
        pending, response = memoryview(text.encode()), bytearray()
        stdin, stdout = self.process.stdin.fileno(), self.process.stdout.fileno()
        os.set_blocking(stdin, False)
        try:
            while not response.endswith(b"\n"):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("native compute request timed out")
                readable, writable, _ = select.select([stdout], [stdin] if pending else [], [], remaining)
                if writable:
                    try:
                        pending = pending[os.write(stdin, pending):]
                    except BlockingIOError:
                        pass
                if readable:
                    chunk = os.read(stdout, 1 << 20)
                    if not chunk:
                        raise RuntimeError("native compute worker exited")
                    response += chunk
        finally:
            os.set_blocking(stdin, True)
        if pending or response.count(b"\n") != 1:
            raise RuntimeError("native compute protocol error")
        return response.decode()

    def prepare(self, op, *, revision, **data):
        """Register one immutable revision-bound input; later requests send overrides."""
        validate_request(op, data)
        frozen = json.loads(json.dumps(data, allow_nan=False))
        snapshot_id = _digest(dict(op=op, revision=str(revision), data=frozen))
        if snapshot_id in self._snapshots:
            return snapshot_id
        if len(self._snapshots) >= 8:
            raise ValueError("snapshot cache limit reached; start a new worker")
        if sum(len(json.dumps(s["data"])) for s in self._snapshots.values()) + len(json.dumps(frozen)) > 16*1024*1024:
            raise ValueError("snapshot cache exceeds 16 MiB budget")
        reply = self.request("snapshot.put", backend="cpu", revision=str(revision),
                             snapshot_id=snapshot_id, snapshot_op=op, snapshot_data=frozen)
        if not reply["ok"]:
            raise RuntimeError(reply.get("error", "snapshot registration failed"))
        self._snapshots[snapshot_id] = dict(op=op, revision=str(revision), data=frozen)
        return snapshot_id

    def _calibration_binding(self, op, revision, data):
        if self._capabilities is None:
            self._capabilities = self.request("capabilities", backend="cpu")["result"]
        source = Path(__file__).parent
        files = [source / "compute.py", source / "native/worker.mm", source / "native/kernels.metal"]
        implementation = hashlib.sha256(b"".join(p.read_bytes() for p in files)).hexdigest()
        if op == "placement_hpwl":
            workload = dict(pins=len(data["candidates"][0]), nets=data["nets"],
                            candidates=len(data.get("candidate_deltas", data["candidates"])),
                            sparse="candidate_deltas" in data,
                            delta_counts=[len(d) for d in data.get("candidate_deltas", [])])
        else:
            workload = {k: v for k, v in data.items() if k not in ("snapshot_id", "custom_rules")}
        return dict(op=op, revision=revision, implementation=implementation,
                    hardware=dict(device=self._capabilities.get("device", "cpu-only"),
                                  platform=platform.platform(), machine=platform.machine(),
                                  worker_binary_sha256=(self._capabilities.get("worker_build") or {}).get("binary_sha256")),
                    workload=workload)

    def _calibration_key(self, op, revision, data):
        return _digest(self._calibration_binding(op, revision, data))

    def calibrate(self, op, *, revision, repetitions=7, save=True, **data):
        """Promote only matching, numerically equivalent measured round-trip work."""
        _integer(repetitions, 5, 31, "repetitions")
        if op not in ("placement_hpwl", "congestion", "cost_field"):
            raise ValueError("operation cannot be calibrated")
        resolved = data
        if "snapshot_id" in data:
            snapshot = self._snapshots.get(data["snapshot_id"])
            if not snapshot or snapshot["revision"] != str(revision) or snapshot["op"] != op:
                raise ValueError("snapshot operation or revision mismatch")
            resolved = dict(snapshot["data"], **data)
        validate_request(op, resolved)
        binding = self._calibration_binding(op, str(revision), resolved)
        key = _digest(binding)
        samples = {"cpu": [], "metal": []}
        results = {}
        actual_metal = True
        # Warm each path, then alternate order to reduce startup and ordering bias.
        for iteration in range(repetitions + 1):
            order = ("cpu", "metal") if iteration % 2 == 0 else ("metal", "cpu")
            for backend in order:
                begin = time.monotonic()
                reply = self.request(op, backend=backend, revision=revision, **data)
                elapsed = (time.monotonic() - begin) * 1000
                if not reply.get("ok"):
                    raise RuntimeError(reply.get("error", "calibration failed"))
                if backend == "metal":
                    actual_metal &= reply["metrics"]["backend"] == "metal" and reply["metrics"]["dispatches"] > 0
                if iteration:
                    samples[backend].append(elapsed)
                results[backend] = reply["result"]
        result_key = {"placement_hpwl": "scores", "congestion": "counts", "cost_field": "distances"}[op]
        a, b = results["cpu"][result_key], results["metal"][result_key]
        parity = len(a) == len(b) and all(
            x == y for x, y in zip(a, b))
        medians = {backend: statistics.median(values) for backend, values in samples.items()}
        p90 = {backend: sorted(values)[math.ceil(len(values)*0.9)-1] for backend, values in samples.items()}
        profile = dict(id=key, binding=binding, created_at=time.time(), op=op,
                       revision=str(revision), samples_ms=samples,
                       median_ms=medians, p90_ms=p90, parity=parity, actual_metal=actual_metal,
                       promoted=bool(parity and actual_metal and medians["metal"] <= medians["cpu"]*0.9
                                     and p90["metal"] <= p90["cpu"]),
                       scope="matching numerical workload round-trip; not board acceptance or completion")
        self.calibrations[key] = profile
        if save:
            self.calibration_path.parent.mkdir(parents=True, exist_ok=True)
            with self.calibration_path.with_suffix(".lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    current = json.loads(self.calibration_path.read_text())["profiles"]
                except (OSError, ValueError, KeyError, TypeError):
                    current = {}
                current.update(self.calibrations)
                current = dict(sorted(current.items(), key=lambda item: item[1].get("created_at", 0))[-256:])
                temporary = self.calibration_path.with_name(self.calibration_path.name + f".{uuid.uuid4().hex}.tmp")
                temporary.write_text(json.dumps({"version": 1, "profiles": current}, indent=2) + "\n")
                temporary.replace(self.calibration_path)
        return profile

    def _stop_process(self):
        if self.process:
            # EOF first: the worker unloads Core ML models and removes their compiled copies.
            try:
                self.process.stdin.close()
                self.process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream:
                    stream.close()
            self.process = None

    def close(self):
        self._stop_process()
        if self._reservation:
            self._reservation.__exit__(None, None, None)
            self._reservation = None
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
