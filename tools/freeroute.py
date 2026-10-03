"""Freerouting pass for a board: keep the existing copper, route only the open connections.

Run with the KiCad bundled Python:
  $PY tools/freeroute.py BOARD.kicad_pcb OUT.kicad_pcb [--layers F.Cu,B.Cu] [--passes 30] [--nets A,B]

1. All existing tracks and vias are locked, so Freerouting keeps them as fixed wiring.
2. Layers that are not in --layers become "power" layers in the DSN, so Freerouting
   does not route signals on them (the inner GND planes stay solid).
3. --nets limits the routing to these nets. The other open nets stay open.
4. The SES result is imported. The lock state of the old copper is restored. Zones are refilled.
5. Freerouting does not know the .kicad_dru rules or the SI gates. Check them after each run.
The result is a proposal. DRC with --schematic-parity and the board gates decide.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import route_preview

import pcbnew

# FREEROUTING_JAR and FREEROUTING_JAVA select the version (image iot-lab-route:10.0-fr241 sets both: 2.4.1, Java 25).
JAR = os.environ.get("FREEROUTING_JAR") or os.path.expanduser(
    "~/Documents/KiCad/9.0/3rdparty/plugins/app_freerouting_kicad-plugin/jar/freerouting-2.1.0.jar")
JAVA = os.environ.get("FREEROUTING_JAVA", "java")


def restrict_dsn(text, layers, nets):
    def layer_type(m):
        name = m.group(1)
        kind = "signal" if name in layers else "power"
        return f"(layer {name}\n      (type {kind})"
    text = re.sub(r"\(layer ([^\s()]+)\s*\(type \w+\)", layer_type, text)
    if nets:
        # Drop the pins of other nets from the network section, so they are not routed.
        def keep_net(m):
            name = m.group(1).strip('"')
            return m.group(0) if name in nets else f"(net {m.group(1)}\n      (pins))"
        text = re.sub(r"\(net (\"[^\"]*\"|[^\s()]+)\s*\(pins[^)]*\)\s*\)", keep_net, text)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board")
    ap.add_argument("out")
    ap.add_argument("--layers", default="F.Cu,B.Cu")
    ap.add_argument("--passes", type=int, default=30)
    ap.add_argument("--nets", default="")
    ap.add_argument("--timeout", default="00:02:00", help="Freerouting job timeout, HH:MM:SS")
    ap.add_argument("--nets-file", default="", help="file with one net name per line (in place of --nets)")
    ap.add_argument("--hard-timeout", type=int, default=900, help="seconds; the Python stop for the Freerouting process")
    ap.add_argument("--jar", default=JAR)
    ap.add_argument("--no-live", action="store_true", help="Disable optional visual-stage snapshots")
    a = ap.parse_args()
    if not os.path.isfile(a.jar):
        sys.exit(f"freeroute: jar not found: {a.jar}")

    board = pcbnew.LoadBoard(a.board)
    was_locked = {}
    for t in board.GetTracks():
        was_locked[t.m_Uuid.AsString()] = t.IsLocked()
        t.SetLocked(True)

    work = tempfile.mkdtemp(prefix="freeroute-")
    dsn, ses, log = (os.path.join(work, n) for n in ("board.dsn", "board.ses", "freerouting.log"))
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        sys.exit("freeroute: DSN export failed")
    layers = set(a.layers.split(","))
    nets = set(n for n in a.nets.split(",") if n)
    if a.nets_file:
        with open(a.nets_file) as f:
            nets |= set(line.strip() for line in f if line.strip())
    with open(dsn) as f:
        text = restrict_dsn(f.read(), layers, nets)
    with open(dsn, "w") as f:
        f.write(text)
    # Freeze the routing input for previews even if another agent later saves the source.
    pcbnew.SaveBoard(os.path.join(work, 'source.kicad_pcb'), board)

    # Freerouting 2.1.0 does not always stop at -mp, so give the pass limit in both forms
    # and a job timeout. The Python timeout is the last stop.
    cmd = [JAVA, "-jar", a.jar, "-de", dsn, "-do", ses, "-mp", str(a.passes),
           f"--router.max_passes={a.passes}", f"--router.job_timeout={a.timeout}",
           "--gui.enabled=false"]
    live = None
    if not a.no_live:
        try:
            prefix, status_path, status_data = route_preview.prepare(a.board, a.out, work, a.jar)
            cmd = prefix + cmd[3:]
            live = (status_path, status_data)
        except Exception as exc:
            print(f"freeroute: live preview unavailable ({type(exc).__name__}); routing normally", file=sys.stderr)
    with open(log, "w") as lf:
        try:
            rc = subprocess.run(cmd, stdout=lf, stderr=subprocess.STDOUT, timeout=a.hard_timeout).returncode
        except subprocess.TimeoutExpired:
            if live:
                route_preview.finish(*live, 'timed out')
            sys.exit(f"freeroute: Freerouting did not stop in the hard timeout, log: {log}")
    if rc != 0 or not os.path.isfile(ses):
        if live:
            route_preview.finish(*live, 'failed')
        sys.exit(f"freeroute: Freerouting failed (rc {rc}), log: {log}")

    if not pcbnew.ImportSpecctraSES(board, ses):
        if live:
            route_preview.finish(*live, 'import failed')
        sys.exit("freeroute: SES import failed")
    for t in board.GetTracks():
        t.SetLocked(was_locked.get(t.m_Uuid.AsString(), False))
    # The new tracks cut through the old zone fill. Refill, or DRC shows false clearance errors.
    pcbnew.ZONE_FILLER(board).Fill(board.Zones())
    pcbnew.SaveBoard(a.out, board)
    if live:
        route_preview.finish(*live, 'candidate saved')
    print(f"freeroute: wrote {a.out}; work files in {work}")


if __name__ == "__main__":
    main()
