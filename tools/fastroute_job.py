#!/usr/bin/env python3
"""One Fastroute job on this computer: route a board copy, import, verify, count with KiCad DRC.

  $PY tools/fastroute_job.py BOARD.kicad_pcb OUTDIR [--passes 40] [--layers F.Cu,B.Cu] [--skip-net GND]
                             [--gnd-vias] [--max-time S] [--threads N] [--set KEY=VALUE ...]

Fastroute (github.com/parisxmas/fastroute, GPL-3.0, a Rust port of Freerouting) routes on many cores, so this
job runs on the Mac (user rule 2026-10-03). Binary: $FASTROUTE_BIN, default ~/opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute.
Steps:
  1. --gnd-vias: tools/gnd_pad_vias.py first (ground pads reach the inner plane through vias, not tracks).
  2. Existing copper is locked and kept. The DSN gets only --layers as signal layers; nets that match
     --skip-net (comma list of fnmatch patterns) are not routed.
  3. fastroute -mp PASSES --router.min_trace_width_um=<board minimum> --report --diagnose.
  4. tools/import_ses.py rule: import with locked copper; via count must equal the router report.
  5. kicad-cli pcb drc on OUTDIR/routed.kicad_pcb (the .kicad_pro and .kicad_dru of BOARD are copied).
Prints "UNROUTED <n> ERRORS <n> ROUTER_UNROUTED <n> CONGESTION <n> BLOCKED <n> SECONDS <n>".
Exit code 4: the result is not verified (do not use the board).
"""
import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys
import time

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import freeroute  # noqa: E402  (restrict_dsn)

BIN = os.environ.get("FASTROUTE_BIN") or os.path.expanduser("~/opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute")
KICAD_CLI = os.environ.get("KICAD_CLI", "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board")
    ap.add_argument("outdir")
    ap.add_argument("--passes", type=int, default=40)
    ap.add_argument("--layers", default="F.Cu,B.Cu")
    ap.add_argument("--skip-net", default="GND")
    ap.add_argument("--gnd-vias", action="store_true")
    ap.add_argument("--max-time", type=int, default=0)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    a = ap.parse_args()
    if not os.path.isfile(BIN):
        sys.exit(f"fastroute_job: binary not found: {BIN} (set FASTROUTE_BIN)")
    os.makedirs(a.outdir, exist_ok=True)
    stem = os.path.splitext(a.board)[0]
    base = os.path.join(a.outdir, "base.kicad_pcb")
    out = os.path.join(a.outdir, "routed.kicad_pcb")
    for ext in (".kicad_pro", ".kicad_dru"):
        if os.path.isfile(stem + ext):
            shutil.copy(stem + ext, os.path.join(a.outdir, "base" + ext))
            shutil.copy(stem + ext, os.path.join(a.outdir, "routed" + ext))
    if a.gnd_vias:
        tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gnd_pad_vias.py")
        subprocess.run([sys.executable, tool, a.board, base, "--net", "GND"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not os.path.isfile(base):
        shutil.copy(a.board, base)

    b = pcbnew.LoadBoard(base)
    was = {}
    for t in b.GetTracks():
        was[t.m_Uuid.AsString()] = t.IsLocked()
        t.SetLocked(True)
    dsn, ses, rep = (os.path.join(a.outdir, n) for n in ("board.dsn", "board.ses", "report.json"))
    if not pcbnew.ExportSpecctraDSN(b, dsn):
        sys.exit("fastroute_job: DSN export failed")
    skip = [p for p in a.skip_net.split(",") if p]
    nets = set(str(n) for n in b.GetNetsByName().keys() if str(n) and not any(fnmatch.fnmatchcase(str(n), p) or p in str(n) for p in skip))
    with open(dsn) as f:
        text = freeroute.restrict_dsn(f.read(), set(a.layers.split(",")), nets)
    with open(dsn, "w") as f:
        f.write(text)
    min_um = int(round(b.GetDesignSettings().m_TrackMinWidth / 1000))
    cmd = [BIN, "-de", dsn, "-do", ses, "-mp", str(a.passes), f"--router.min_trace_width_um={min_um}",
           f"--report={rep}", "--diagnose"] + [f"--{kv}" for kv in a.set]
    if a.max_time:
        cmd.append(f"--max-time={a.max_time}")
    if a.threads:
        cmd.append(f"--router.autorouter.max_threads={a.threads}")
    t0 = time.time()
    with open(os.path.join(a.outdir, "run.log"), "w") as lf:
        rc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT).returncode
    secs = int(time.time() - t0)
    if rc != 0 or not os.path.isfile(ses) or not os.path.isfile(rep):
        sys.exit(f"fastroute_job: fastroute failed (rc {rc}), see {a.outdir}/run.log")
    report = json.load(open(rep))

    vias = lambda: sum(1 for t in b.GetTracks() if t.GetClass() == "PCB_VIA")
    if not pcbnew.ImportSpecctraSES(b, ses):
        sys.exit("fastroute_job: SES import failed")
    for t in b.GetTracks():
        t.SetLocked(was.get(t.m_Uuid.AsString(), False))
    after = vias()
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(out, b)
    drc = os.path.join(a.outdir, "drc.json")
    subprocess.run([KICAD_CLI, "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o", drc, out],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    d = json.load(open(drc))
    errors = sum(1 for v in d.get("violations", []) if v.get("severity") == "error")
    diag = report.get("diagnosis", {})
    print(f"UNROUTED {len(d.get('unconnected_items', []))} ERRORS {errors} ROUTER_UNROUTED {report['stats']['unrouted']} "
          f"CONGESTION {diag.get('congestion', 0)} BLOCKED {diag.get('blocked', 0)} SECONDS {secs}", flush=True)
    if after != report["stats"]["vias"]:
        print(f"fastroute_job: RESULT NOT VERIFIED: {after} vias on the board, {report['stats']['vias']} in the router report", flush=True)
        sys.exit(4)


if __name__ == "__main__":
    main()
