#!/usr/bin/env python3
"""model_fit: find 3D models that do not sit on their footprint pads.

  KPY=/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3
  $KPY tools/model_fit.py BOARD.kicad_pcb [--glb FILE] [--tol 0.3]

The tool exports the board models with `kicad-cli pcb export glb` (IOT_LAB is set to
the repository root). KiCad applies the footprint model offset, rotation and scale, so
the GLB shows the models where KiCad draws them. For each footprint the tool compares
the model box (board plane X/Y and height Z) with the box around its pads:
  missing   the footprint has a model, but the GLB has no body for it
            (wrong or missing model file, or a model that KiCad cannot load),
  file      a model path does not resolve to a file,
  cover     the model X/Y box does not cover the pad centers (more than --tol),
  pins      THT footprint: the model pin tails (model parts below mid board) are not
            on the drilled pads, PTH and NPTH (center off by more than --tol, or a
            drilled pad more than --tol outside the pin tail box); an SMD footprint
            with via holes is not checked,
  float     the model bottom is more than --tol above the board top,
  sink      the model bottom is more than --tol below the board top (no drilled pads),
  courtyard the model X/Y center is more than 0.5 mm from the courtyard center
            (the bridge courtyard is drawn around the body: a model that is shifted
            or turned 180 degrees on a symmetric pin row fails here).
Exit 1 on any finding.
"""
import argparse
import json
import math
import os
import re
import struct
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KICAD_3D = "/Applications/KiCad/KiCad.app/Contents/SharedSupport/3dmodels"
CENTER_TOL = 0.5


def _qmat(q):
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def _node_mat(node):
    """4x4 matrix of a glTF node (matrix or T*R*S)."""
    if "matrix" in node:
        m = node["matrix"]  # column major
        return [[m[c * 4 + r] for c in range(4)] for r in range(4)]
    t = node.get("translation", [0, 0, 0])
    r = _qmat(node.get("rotation", [0, 0, 0, 1]))
    s = node.get("scale", [1, 1, 1])
    return [[r[i][0] * s[0], r[i][1] * s[1], r[i][2] * s[2], t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def _mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def _apply(m, p):
    return [m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3] for i in range(3)]


def read_glb_json(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file: %s" % path)
    length, kind = struct.unpack("<II", data[12:20])
    if kind != 0x4E4F534A:
        raise ValueError("first GLB chunk is not JSON: %s" % path)
    return json.loads(data[20:20 + length])


def model_boxes(gltf):
    """{name: (xmin, ymin, zmin, xmax, ymax, zmax)} in KiCad mm (X right, Y down, Z up).

    A named node is one footprint (KiCad uses the reference). glTF is Y-up in metres;
    KiCad GLB export maps glTF (x, y, z) to board (x, z, height = y)."""
    nodes, meshes, acc = gltf["nodes"], gltf.get("meshes", []), gltf.get("accessors", [])
    out = {}

    def walk(idx, mat, owner):
        node = nodes[idx]
        mat = _mul(mat, _node_mat(node))
        name = node.get("name")
        if owner is None and name and not name.startswith("=>"):
            owner = name
        if "mesh" in node and owner is not None:
            for prim in meshes[node["mesh"]]["primitives"]:
                a = acc[prim["attributes"]["POSITION"]]
                lo, hi = a["min"], a["max"]
                for cx in (lo[0], hi[0]):
                    for cy in (lo[1], hi[1]):
                        for cz in (lo[2], hi[2]):
                            gx, gy, gz = _apply(mat, (cx, cy, cz))
                            p = (gx * 1000.0, gz * 1000.0, gy * 1000.0)
                            b = out.get(owner)
                            out[owner] = p + p if b is None else (
                                min(b[0], p[0]), min(b[1], p[1]), min(b[2], p[2]),
                                max(b[3], p[0]), max(b[4], p[1]), max(b[5], p[2]))
        for child in node.get("children", []):
            walk(child, mat, owner)

    ident = [[1 if i == j else 0 for j in range(4)] for i in range(4)]
    roots = gltf["scenes"][gltf.get("scene", 0)]["nodes"]
    for r in roots:
        walk(r, ident, None)
    return out



def _positions(gltf, blob, index):
    a = gltf["accessors"][index]
    if a.get("componentType") != 5126 or a.get("type") != "VEC3" or "sparse" in a:
        raise ValueError("POSITION accessor %d is not a plain float VEC3" % index)
    view = gltf["bufferViews"][a["bufferView"]]
    start = view.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = view.get("byteStride", 12)
    for i in range(a["count"]):
        yield struct.unpack_from("<3f", blob, start + i * stride)


def pin_boxes(gltf, blob, below=0.8):
    """{name: (xmin, ymin, xmax, ymax)} in KiCad mm of the model vertices lower than
    `below` mm (the pin tails of a THT part, the board is 0 to 1.6 mm)."""
    nodes, meshes = gltf["nodes"], gltf.get("meshes", [])
    out = {}

    def walk(idx, mat, owner):
        node = nodes[idx]
        mat = _mul(mat, _node_mat(node))
        name = node.get("name")
        if owner is None and name and not name.startswith("=>"):
            owner = name
        if "mesh" in node and owner is not None:
            for prim in meshes[node["mesh"]]["primitives"]:
                for v in _positions(gltf, blob, prim["attributes"]["POSITION"]):
                    gx, gy, gz = _apply(mat, v)
                    if gy * 1000.0 >= below:
                        continue
                    x, y = gx * 1000.0, gz * 1000.0
                    b = out.get(owner)
                    out[owner] = (x, y, x, y) if b is None else (
                        min(b[0], x), min(b[1], y), max(b[2], x), max(b[3], y))
        for child in node.get("children", []):
            walk(child, mat, owner)

    ident = [[1 if i == j else 0 for j in range(4)] for i in range(4)]
    for r in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        walk(r, ident, None)
    return out


def read_glb(path):
    """(json, binary chunk) of a GLB file."""
    with open(path, "rb") as f:
        data = f.read()
    gltf = read_glb_json(path)
    length = struct.unpack("<I", data[12:16])[0]
    off = 20 + length
    blob = b""
    if off + 8 <= len(data):
        blen = struct.unpack("<I", data[off:off + 4])[0]
        blob = data[off + 8:off + 8 + blen]
    return gltf, blob


def _center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def assess(model, pads, board_top, tol, has_model=True, files_ok=True, pins=None, holes=None,
           courtyard=None):
    """Return a list of (kind, text). model: 6-tuple or None; pads: box of the pad centers;
    pins: box of the model pin tails; holes: box of the THT pad centers; courtyard: box of the
    F.Courtyard lines (all 4-tuples)."""
    found = []
    if not files_ok:
        found.append(("file", "model path does not resolve to a file"))
    if not has_model:
        return found
    if model is None:
        found.append(("missing", "no model body in the export"))
        return found
    if pads is None:
        return found
    over = max(model[0] - pads[0], model[1] - pads[1], pads[2] - model[3], pads[3] - model[4])
    if over > tol:
        found.append(("cover", "pads extend %.2f mm past the model" % over))
    if holes is not None:
        if pins is None:
            found.append(("pins", "THT footprint, but no model pin goes into the board"))
        else:
            (px, py), (hx, hy) = _center(pins), _center(holes)
            out = max(pins[0] - holes[0], pins[1] - holes[1], holes[2] - pins[2], holes[3] - pins[3])
            if math.hypot(px - hx, py - hy) > tol or out > tol:
                found.append(("pins", "pin tails off the holes by dx %.2f dy %.2f mm, holes %.2f mm outside"
                              % (px - hx, py - hy, out)))
    if holes is None and model[2] < board_top - tol:
        found.append(("sink", "model bottom %.2f mm below the board top" % (board_top - model[2])))
    if model[2] > board_top + tol:
        found.append(("float", "model bottom %.2f mm above the board top" % (model[2] - board_top)))
    if courtyard is not None:
        (cx, cy) = _center(courtyard)
        dx, dy = (model[0] + model[3]) / 2 - cx, (model[1] + model[4]) / 2 - cy
        if math.hypot(dx, dy) > CENTER_TOL:
            found.append(("courtyard", "model center is off the courtyard center by dx %.2f dy %.2f mm"
                          % (dx, dy)))
    return found


def resolve(path, board_dir):
    """Expand ${IOT_LAB}, ${KIPRJMOD} and ${KICADn_3DMODEL_DIR}; leave other variables as they are."""
    path = path.replace("${IOT_LAB}", ROOT).replace("${KIPRJMOD}", board_dir)
    path = re.sub(r"\$\{KICAD\d*_3DMODEL_DIR\}", lambda m: KICAD_3D, path)
    if not os.path.isabs(path):
        path = os.path.join(board_dir, path)
    return path


def _box(points):
    if not points:
        return None
    xs, ys = [p.x / 1e6 for p in points], [p.y / 1e6 for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def board_data(pcb_path):
    """{ref: dict(lcsc, pads, models, files_ok)} and the board top height (mm)."""
    import pcbnew
    board = pcbnew.LoadBoard(pcb_path)
    board_dir = os.path.dirname(os.path.abspath(pcb_path))
    top = board.GetDesignSettings().GetBoardThickness() / 1e6
    out = {}
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        models = [m for m in fp.Models() if m.m_Show]
        pads = _box([p.GetPosition() for p in fp.Pads()])
        holes = None
        if not fp.GetAttributes() & pcbnew.FP_SMD:
            holes = _box([p.GetPosition() for p in fp.Pads()
                          if p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)])
        crt = [it.GetBoundingBox() for it in fp.GraphicalItems() if it.GetLayer() == pcbnew.F_CrtYd]
        courtyard = None
        if crt:
            courtyard = (min(b.GetLeft() for b in crt) / 1e6, min(b.GetTop() for b in crt) / 1e6,
                         max(b.GetRight() for b in crt) / 1e6, max(b.GetBottom() for b in crt) / 1e6)
        lcsc = ""
        for field in fp.GetFields():
            if field.GetName() == "LCSC":
                lcsc = field.GetText().strip()
        out[ref] = {"lcsc": lcsc or fp.GetFPIDAsString(), "pads": pads, "holes": holes, "courtyard": courtyard, "models": len(models),
                    "files_ok": all(os.path.exists(resolve(m.m_Filename, board_dir)) for m in models),
                    "back": fp.IsFlipped()}
    return out, top


def export_glb(pcb_path, out):
    cmd = ["kicad-cli", "pcb", "export", "glb", "-D", "IOT_LAB=" + ROOT, "--no-board-body",
           "--user-origin", "0x0mm", "-f", "-o", out, pcb_path]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(out):
        raise SystemExit("ERROR: GLB export failed\n" + res.stdout + res.stderr)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("pcb")
    ap.add_argument("--glb", help="use this GLB export; default: export a new one")
    ap.add_argument("--tol", type=float, default=0.3)
    args = ap.parse_args(argv)
    glb = args.glb
    if glb is None:
        glb = os.path.join(tempfile.mkdtemp(prefix="model_fit_"), "board.glb")
        export_glb(args.pcb, glb)
    gltf, blob = read_glb(glb)
    boxes, pins = model_boxes(gltf), pin_boxes(gltf, blob)
    fps, top = board_data(args.pcb)
    bad = 0
    for ref in sorted(fps):
        d = fps[ref]
        if d["back"]:
            continue  # parts are top side only; a back part is out of scope
        found = assess(boxes.get(ref), d["pads"], top, args.tol, d["models"] > 0, d["files_ok"],
                       pins.get(ref), d["holes"], d["courtyard"])
        for kind, text in found:
            print("ERROR %-6s %-10s %-9s %s" % (ref, d["lcsc"], kind, text))
        bad += bool(found)
    print("model_fit: %d footprints, %d with errors" % (len(fps), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
