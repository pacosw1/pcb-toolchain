"""Small pre-decision measurements, not engineering scores or feasibility tests.

Pad-center HPWL is a new all-net geometric measurement. It is neither routed
length nor the production placer's weighted proxy. No rule limits are inferred.
Pairwise distance sums each unordered pair of pad centers within each named
net, in millimeters; interior motion can change it while HPWL stays constant.
"""
from itertools import combinations
import math
from pathlib import Path

from pcb_ml_data import artifact_identity
from placer.dru import _tokens, _tree


ROUTING_FEATURES = (
    ("footprint_count", "count"), ("pad_count", "count"),
    ("declared_net_count", "count"), ("copper_layer_count", "count"),
    ("retained_track_count", "count"), ("retained_via_count", "count"),
    ("retained_zone_count", "count"), ("all_net_pad_hpwl_mm", "mm"),
    ("all_net_pairwise_distance_sum_mm", "mm"),
    ("two_pad_net_count", "count"), ("two_pad_distance_sum_mm", "mm"),
    ("two_pad_distance_max_mm", "mm"), ("edge_bbox_area_mm2", "mm2"),
)
OPERATIONS = ("check", "build", "edit", "route", "repair", "release", "parts",
              "placement", "routing", "schematic", "design", "outcomes", "blocks",
              "readiness", "ml")
WORKFLOW_FEATURES = (("budget_s", "s"), ("has_project", "indicator"),
                     ("has_engineering_manifest", "indicator"),
                     ("has_design_contract", "indicator"), ("has_from_run", "indicator")) + tuple(
                         ("operation_" + name, "indicator") for name in OPERATIONS)
IMPLEMENTATIONS = ("pcb_ml_features.py", "placer/dru.py", "placer/__init__.py")


def feature_contract(adapter):
    if adapter not in ("routing", "workflow"):
        raise ValueError("unsupported feature adapter: " + str(adapter))
    import hashlib
    tools = Path(__file__).resolve().parent
    columns = ROUTING_FEATURES if adapter == "routing" else WORKFLOW_FEATURES
    return dict(id="iot-lab.pcb-ml-predecision." + adapter,
                version=2 if adapter == "routing" else 1, adapter=adapter,
                features=[dict(name=name, unit=unit) for name, unit in columns],
                implementation_sha256={"tools/" + name: hashlib.sha256((tools / name).read_bytes()).hexdigest()
                                       for name in IMPLEMENTATIONS})


def _forms(form, name):
    return [item for item in form[1:] if isinstance(item, list) and item and item[0] == name]


def _child(form, name):
    values = _forms(form, name)
    if len(values) > 1:
        raise ValueError("ambiguous native field: " + name)
    return values[0][1:] if values else None


def _number(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("nonfinite native coordinate")
    return value


def native_tree(text):
    tokens = _tokens(text)
    depth = 0
    for token in tokens:
        depth += (token == "(") - (token == ")")
        if depth < 0:
            raise ValueError("unbalanced native PCB")
    if depth:
        raise ValueError("unbalanced native PCB")
    roots = _tree(tokens)
    if len(roots) != 1 or not roots[0] or roots[0][0] != "kicad_pcb":
        raise ValueError("expected one native PCB")
    return roots[0]


def routing_features(text):
    board = native_tree(text)
    fps = _forms(board, "footprint")
    pads = [(fp, pad) for fp in fps for pad in _forms(fp, "pad")]
    nets = {}
    for net in _forms(board, "net"):
        if len(net) != 3 or net[1] in nets:
            raise ValueError("unsupported or ambiguous native net table")
        nets[net[1]] = net[2]
    pad_nets = [(fp, pad, _child(pad, "net")) for fp, pad in pads]
    declared_names = {name for name in nets.values() if name}
    # KiCad 10 can omit the legacy table and name nets on individual pads.
    # Resolve all explicit declarations before numeric references, regardless
    # of footprint order, while retaining unused legacy net declarations.
    for _, _, net in pad_nets:
        if not net:
            continue
        if len(net) == 2:
            code, name = net
            if code in nets and nets[code] != name:
                raise ValueError("pad net differs from native table or another pad declaration")
            nets[code] = name
            if name:
                declared_names.add(name)
        elif len(net) == 1:
            if net[0] and not net[0].isdecimal():
                declared_names.add(net[0])
        else:
            raise ValueError("unsupported pad net")
    layers = _child(board, "layers")
    values = dict(footprint_count=len(fps), pad_count=len(pads),
                  declared_net_count=len(declared_names),
                  copper_layer_count=sum(isinstance(row, list) and len(row) > 1 and row[1].endswith(".Cu") for row in layers) if layers is not None else None,
                  retained_track_count=len(_forms(board, "segment")) + len(_forms(board, "arc")),
                  retained_via_count=len(_forms(board, "via")), retained_zone_count=len(_forms(board, "zone")))
    reasons = []
    points = {}
    geometry_known = True
    for fp, pad, net in pad_nets:
        if not net:
            continue
        if len(net) == 2:
            name = net[1]
        elif len(net) == 1:
            name = nets.get(net[0], net[0] if not net[0].isdecimal() else None)
        else:
            raise ValueError("unsupported pad net")
        if name is None:
            values["declared_net_count"] = None
            geometry_known = False
            reasons.append(dict(code="native_net_unknown", cause="numeric pad net lacks a native net name"))
            continue
        if not name:
            continue
        points.setdefault(name, [])
        try:
            pose, at = _child(fp, "at"), _child(pad, "at")
            if not pose or len(pose) not in (2, 3) or not at or len(at) not in (2, 3):
                raise ValueError("missing footprint or pad center")
            x, y = _number(pose[0]), _number(pose[1])
            angle = math.radians(_number(pose[2]) if len(pose) == 3 else 0)
            px, py = _number(at[0]), _number(at[1])
            # Native KiCad positive rotation is CCW in a Y-down board frame.
            points[name].append((x + px * math.cos(angle) + py * math.sin(angle),
                                 y - px * math.sin(angle) + py * math.cos(angle)))
        except (ValueError, TypeError, IndexError) as exc:
            geometry_known = False
            reasons.append(dict(code="pad_center_unknown", cause=str(exc)))
    distances = [math.dist(*group) for group in points.values() if len(group) == 2]
    values.update(all_net_pad_hpwl_mm=sum(max(x for x, _ in group) - min(x for x, _ in group) +
                                        max(y for _, y in group) - min(y for _, y in group)
                                        for group in points.values() if group) if geometry_known else None,
                  all_net_pairwise_distance_sum_mm=sum(math.dist(a, b) for group in points.values()
                                                       for a, b in combinations(group, 2)) if geometry_known else None,
                  two_pad_net_count=sum(len(group) == 2 for group in points.values()) if geometry_known else None,
                  two_pad_distance_sum_mm=sum(distances) if geometry_known else None,
                  two_pad_distance_max_mm=max(distances, default=0) if geometry_known else None)
    outline = []
    unsupported = False
    for form in board[1:]:
        if not isinstance(form, list) or not form or not form[0].startswith("gr_"):
            continue
        if _child(form, "layer") != ["Edge.Cuts"]:
            continue
        try:
            if form[0] in ("gr_line", "gr_rect"):
                outline.extend(tuple(map(_number, _child(form, name))) for name in ("start", "end"))
            elif form[0] == "gr_poly":
                pts = _child(form, "pts")
                if not pts or any(not isinstance(p, list) or p[0] != "xy" or len(p) != 3 for p in pts):
                    raise ValueError("unsupported outline polygon")
                outline.extend(tuple(map(_number, p[1:])) for p in pts)
            else:
                unsupported = True
        except (ValueError, TypeError):
            unsupported = True
    # Footprint-owned outlines and curved native outlines are deliberately not
    # approximated by a guessed rectangle. This is a bbox, never polygon area.
    if any(_child(form, "layer") == ["Edge.Cuts"] for fp in fps for form in fp[1:]
           if isinstance(form, list) and form and form[0].startswith("fp_")):
        unsupported = True
    values["edge_bbox_area_mm2"] = ((max(p[0] for p in outline) - min(p[0] for p in outline)) *
                                      (max(p[1] for p in outline) - min(p[1] for p in outline))) if outline and not unsupported and all(len(p) == 2 for p in outline) else None
    for name, _ in ROUTING_FEATURES:
        if values[name] is None:
            reasons.append(dict(code="feature_unknown", feature=name,
                                cause="native geometry or field is missing or unsupported"))
    return {name: values[name] for name, _ in ROUTING_FEATURES}, reasons


def workflow_features(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("workflow source must be a run manifest")
    budget = manifest.get("timeout_s")
    budget = budget if type(budget) in (int, float) and math.isfinite(budget) and budget > 0 else None
    operation = manifest.get("operation")
    known = operation in OPERATIONS
    values = dict(budget_s=budget, has_project=int(bool(manifest.get("project"))),
                  has_engineering_manifest=int(bool(manifest.get("engineering_manifest"))),
                  has_design_contract=int(bool(manifest.get("design_contract"))),
                  has_from_run=int(bool(manifest.get("from_run"))))
    values.update({"operation_" + name: int(operation == name) if known else None for name in OPERATIONS})
    reasons = [dict(code="feature_unknown", feature=name, cause="pre-run field is missing or unsupported")
               for name, value in values.items() if value is None]
    return {name: values[name] for name, _ in WORKFLOW_FEATURES}, reasons


def workflow_case(manifest):
    """Exclude run paths/timestamps and outcome data from semantic case identity."""
    value = {name: manifest.get(name) for name in ("operation", "board", "project", "kind", "router", "spec", "arguments")}
    for name in ("engineering_manifest", "design_contract", "plan"):
        descriptor = manifest.get(name)
        value[name] = {key: descriptor.get(key) for key in ("sha256", "content")} if isinstance(descriptor, dict) else descriptor
    value["from_run"] = manifest.get("from_run", {}).get("result_sha256") if isinstance(manifest.get("from_run"), dict) else None
    return artifact_identity(value)
