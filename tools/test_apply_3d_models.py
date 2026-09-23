#!/usr/bin/env python3
"""Test for tools/apply-3d-models.py.

Run with the KiCad bundled Python:
  /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3 \
      tools/test_apply_3d_models.py

The test copies each board to a temporary folder. It never writes the real boards.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

import pcbnew

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOL = os.path.join(ROOT, "tools", "apply-3d-models.py")
REG = os.path.join(ROOT, "hardware-design", "registry", "cad-assets")
BOARDS = ["INPUT-4D2A", "BASE-PWR", "POE-ETHERNET"]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def copy_board(name, tmp):
    src = os.path.join(ROOT, "hardware-design", "boards", name, "cad", name)
    dst = os.path.join(tmp, name)
    shutil.copytree(src, dst)
    return os.path.join(dst, name + ".kicad_pcb")


def main():
    failures = []
    checked = 0
    with tempfile.TemporaryDirectory() as tmp:
        for name in BOARDS:
            pcb = copy_board(name, tmp)
            res = subprocess.run([sys.executable, TOOL, pcb], capture_output=True, text=True)
            if res.returncode != 0:
                failures.append(f"{name}: tool exit {res.returncode}: {res.stderr.strip()[-300:]}")
                continue
            board = pcbnew.LoadBoard(pcb)
            for fp in board.GetFootprints():
                lcsc = "".join(f.GetText().strip() for f in fp.GetFields() if f.GetName() == "LCSC")
                mf = os.path.join(REG, lcsc, "MANIFEST.json")
                if not lcsc or not os.path.exists(mf):
                    continue
                m = json.load(open(mf)).get("model_3d")
                if not m:
                    continue
                ref = f"{name} {fp.GetReference()}"
                models = list(fp.Models())
                if len(models) != 1:
                    failures.append(f"{ref}: {len(models)} models, expected 1")
                    continue
                md = models[0]
                if not md.m_Filename.startswith("${KIPRJMOD}/") or not md.m_Filename.endswith(m["file"]):
                    failures.append(f"{ref}: path {md.m_Filename}")
                off = [md.m_Offset.x, md.m_Offset.y, md.m_Offset.z]
                rot = [md.m_Rotation.x, md.m_Rotation.y, md.m_Rotation.z]
                if any(abs(a - b) > 1e-6 for a, b in zip(off, m["offset"])):
                    failures.append(f"{ref}: offset {off} != {m['offset']}")
                if any(abs(a - b) > 1e-6 for a, b in zip(rot, m["rotate"])):
                    failures.append(f"{ref}: rotate {rot} != {m['rotate']}")
                local = os.path.join(os.path.dirname(pcb), md.m_Filename[len("${KIPRJMOD}/"):])
                if not os.path.exists(local) or sha(local) != m["sha256"]:
                    failures.append(f"{ref}: model file missing or sha256 differs: {local}")
                checked += 1
    if checked == 0:
        failures.append("no footprint was checked")
    for f in failures:
        print("FAIL", f)
    print(f"checked {checked} footprints, {len(failures)} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
