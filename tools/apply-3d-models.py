#!/usr/bin/env python3
"""Set registry 3D models on the footprints of a KiCad board.

Run with the KiCad bundled Python (pcbnew):
  /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 \
      tools/apply-3d-models.py <board>.kicad_pcb [<board>.kicad_pcb ...] [--dry-run]

For each footprint with an LCSC field, the tool reads
hardware-design/registry/cad-assets/<LCSC>/MANIFEST.json. If the manifest has a
"model_3d" entry, the tool:
  1. checks that the footprint lib id is the manifest "footprint_lib_id",
  2. checks the sha256 of the registry model file,
  3. copies the model into the board 3D folder (the one existing *.3dshapes
     folder next to the board, else <board>.3dshapes),
  4. replaces the footprint models with one model:
     ${KIPRJMOD}/<folder>/<file>, with the manifest offset, rotate and scale.
The tool writes the board in place. It stops with exit code 1 and writes nothing
when a check fails.
"""
import glob
import hashlib
import json
import os
import shutil
import sys

import pcbnew

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGISTRY = os.path.join(ROOT, "hardware-design", "registry", "cad-assets")


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def load_entry(lcsc):
    path = os.path.join(REGISTRY, lcsc, "MANIFEST.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        entry = json.load(f).get("model_3d")
    if entry is None:
        return None
    src = os.path.join(REGISTRY, lcsc, entry["file"])
    if not os.path.exists(src):
        raise SystemExit("ERROR %s: model file is missing: %s" % (lcsc, src))
    if sha256(src) != entry["sha256"]:
        raise SystemExit("ERROR %s: sha256 of %s does not agree with MANIFEST.json" % (lcsc, src))
    entry = dict(entry)
    entry["src"] = src
    return entry


def shapes_dir(pcb_path):
    base = os.path.dirname(os.path.abspath(pcb_path))
    found = sorted(glob.glob(os.path.join(base, "*.3dshapes")))
    if len(found) > 1:
        raise SystemExit("ERROR %s: more than one *.3dshapes folder: %s" % (pcb_path, found))
    if found:
        return found[0]
    return os.path.join(base, os.path.splitext(os.path.basename(pcb_path))[0] + ".3dshapes")


def lcsc_of(fp):
    for field in fp.GetFields():
        if field.GetName() == "LCSC":
            return field.GetText().strip()
    return ""


def plan(board, pcb_path):
    """Return a list of (footprint, entry). Raise SystemExit on a mismatch."""
    todo = []
    errors = []
    cache = {}
    for fp in board.GetFootprints():
        lcsc = lcsc_of(fp)
        if not lcsc:
            continue
        if lcsc not in cache:
            cache[lcsc] = load_entry(lcsc)
        entry = cache[lcsc]
        if entry is None:
            continue
        fpid = fp.GetFPIDAsString()
        if fpid != entry["footprint_lib_id"]:
            errors.append("%s %s: footprint %s, but the model placement is for %s"
                          % (pcb_path, fp.GetReference(), fpid, entry["footprint_lib_id"]))
            continue
        todo.append((fp, entry))
    if errors:
        raise SystemExit("ERROR\n" + "\n".join(errors))
    return todo


def apply(pcb_path, dry_run=False):
    board = pcbnew.LoadBoard(pcb_path)
    todo = plan(board, pcb_path)
    folder = shapes_dir(pcb_path)
    rel = os.path.basename(folder)
    for fp, e in todo:
        model = pcbnew.FP_3DMODEL()
        model.m_Filename = "${KIPRJMOD}/%s/%s" % (rel, e["file"])
        model.m_Offset = pcbnew.VECTOR3D(*[float(v) for v in e["offset"]])
        model.m_Rotation = pcbnew.VECTOR3D(*[float(v) for v in e["rotate"]])
        model.m_Scale = pcbnew.VECTOR3D(*[float(v) for v in e.get("scale", [1, 1, 1])])
        model.m_Show = True
        print("%s %s %s -> %s offset %s rotate %s" % (os.path.basename(pcb_path), fp.GetReference(),
              lcsc_of(fp), model.m_Filename, e["offset"], e["rotate"]))
        if dry_run:
            continue
        fp.Models().clear()
        fp.Models().push_back(model)
    if dry_run or not todo:
        return len(todo)
    os.makedirs(folder, exist_ok=True)
    for src in sorted({e["src"] for _, e in todo}):
        dst = os.path.join(folder, os.path.basename(src))
        if not os.path.exists(dst) or sha256(dst) != sha256(src):
            shutil.copyfile(src, dst)
    board.Save(pcb_path)
    return len(todo)


def main(argv):
    dry = "--dry-run" in argv
    paths = [a for a in argv if a != "--dry-run"]
    if not paths:
        print(__doc__)
        return 2
    total = 0
    for p in paths:
        total += apply(p, dry)
    print("%d footprints %s" % (total, "planned (dry run)" if dry else "updated"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
