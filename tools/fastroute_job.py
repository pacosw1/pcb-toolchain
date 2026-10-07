#!/usr/bin/env python3
"""One Fastroute job on this computer: route a board copy, import, verify, count with KiCad DRC.

  $PY tools/fastroute_job.py BOARD.kicad_pcb OUTDIR [--passes 40] [--layers F.Cu,B.Cu] [--skip-net '*GND*']
                             [--gnd-vias] [--plane-nets GND,+3V3] [--pairs-json diff-pairs.json] [--max-time S] [--threads N] [--set KEY=VALUE ...]

Fastroute (github.com/parisxmas/fastroute, GPL-3.0, a Rust port of Freerouting) routes on many cores, so this
job runs on the Mac (user rule 2026-10-03). Binary: $FASTROUTE_BIN, default ~/opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute.
Steps:
  1. --plane-nets (or --gnd-vias): tools/gnd_pad_vias.py first for each plane net (its pads reach the plane
     through vias, not tracks). GND_OPEN in the result counts the open connections of all skipped nets.
  2. Existing copper is locked and kept. The DSN gets only --layers as signal layers; nets that match
     --skip-net (comma list of fnmatch patterns) are not routed.
  3. fastroute -mp PASSES --router.min_trace_width_um=<board minimum>
     --router.copper_to_edge_clearance_um=<board setting> --report --diagnose.
  4. tools/import_ses.py rule: import with locked copper; via count must equal the router report.
  5. kicad-cli pcb drc on OUTDIR/routed.kicad_pcb (the .kicad_pro and .kicad_dru of BOARD are copied).
Prints "UNROUTED <signal> GND_OPEN <n> ERRORS <n> ROUTER_UNROUTED <n> CONGESTION <n> BLOCKED <n> TRACK_MM <n> VIAS <n> SECONDS <n>".
UNROUTED counts the open connections of the routed nets only; GND_OPEN counts those of the --skip-net nets.
Exit code 4: the result is not verified (do not use the board).
"""
import argparse
import fnmatch
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import freeroute  # noqa: E402  (restrict_dsn)

BIN = os.environ.get("FASTROUTE_BIN") or os.path.expanduser("~/opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute")
KICAD_CLI = os.environ.get("KICAD_CLI", "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")


def write_pairs(pairs_json, dru, nets, out):
    """fastroute pairs file from <board>/diff-pairs.json: one line "pair P N gap=G" for each pair whose two nets
    are routed. G = the diff_pair_gap opt value (mm) of the pair's .kicad_dru rule; no gap when the rule has none.
    Returns the file path, or None when there is no pair."""
    if not pairs_json or not os.path.isfile(pairs_json):
        return None
    rules = open(dru).read() if os.path.isfile(dru) else ""
    lines = []
    for p in json.load(open(pairs_json)).get("pairs", []):
        if p["p"] not in nets or p["n"] not in nets:
            continue
        gap = ""
        i = rules.find('(rule "%s"' % p.get("dru_rule", "\0"))
        if i >= 0:
            m = re.search(r"diff_pair_gap[^\n]*\(opt ([\d.]+)mm\)", rules[i:i + 600])
            gap = f" gap={m.group(1)}" if m else ""
        lines.append(f"pair {p['p']} {p['n']}{gap}")
    if not lines:
        return None
    with open(out, "w") as f:
        f.write("\n".join(lines) + "\n")
    return out


def big_signal_via(text, dia_mm, classes):
    """A second via padstack "Via[0-3]_RP_um" (circle dia_mm on every layer of the class via padstack) for the nets of
    the given DSN classes: (use_via ...) of those classes points to it."""
    m = re.search(r'\(padstack "(Via[^"]*)"\n(.*?)\n    \)', text, re.S)
    if not m:
        sys.exit("fastroute_job: no via padstack in the DSN")
    name, body = m.group(1), m.group(2)
    big = re.sub(r'\(circle (\S+) [\d.]+\)', lambda k: f'(circle {k.group(1)} {int(dia_mm * 1000)})', body)
    text = text.replace(m.group(0), m.group(0) + f'\n    (padstack "Via[0-3]_RP_um"\n{big}\n    )', 1)
    text = text.replace(f'(via "{name}")', f'(via "{name}" "Via[0-3]_RP_um")', 1)
    for c in classes:
        i = text.find(f"(class {c} ")
        if i < 0:
            continue
        j = text.find("(use_via", i)
        k = text.find(")", j)
        text = text[:j] + '(use_via "Via[0-3]_RP_um"' + text[k:]
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("board")
    ap.add_argument("outdir")
    ap.add_argument("--passes", type=int, default=40)
    ap.add_argument("--layers", default="F.Cu,B.Cu")
    ap.add_argument("--skip-net", default="*GND*", help="comma list of fnmatch patterns (exact name or with *)")
    ap.add_argument("--gnd-vias", action="store_true", help="same as --plane-nets GND")
    ap.add_argument("--plane-nets", default="", help="comma list of exact net names that have a plane: each pad gets a "
                    "via to the plane (gnd_pad_vias.py --net) and the net is not routed")
    ap.add_argument("--only-nets", default="", help="comma list of exact net names: route only these nets")
    ap.add_argument("--route-planes", action="store_true", help="the router also routes the plane nets (after the pad vias)")
    ap.add_argument("--neck-um", type=int, default=0, help="retry failed connections with tracks of this width (um), "
                    "for example a short power link at an IC pin; 0 = off")
    ap.add_argument("--via-args", default="", help="more arguments for tools/gnd_pad_vias.py, one string "
                    "(for example \"--via 0.5 0.3 --clearance 0.15 --in-pad\")")
    ap.add_argument("--pairs-json", default="", help="<board>/diff-pairs.json: its pairs go to fastroute --pairs with the "
                    "diff_pair_gap (opt) of their .kicad_dru rule")
    ap.add_argument("--max-time", type=int, default=0)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--render", action="store_true", help="write OUTDIR/routed.png (kicad-cli pcb render, top view)")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--signal-via", type=float, default=0.0, help="routing padstack diameter (mm) of the vias of the "
                    "--signal-via-classes nets: the router keeps other copper off a disc this wide round each signal "
                    "via (room for an RP-001 ground via); after the import the vias get their class size again")
    ap.add_argument("--signal-via-classes", default="FIELD,HOST")
    ap.add_argument("--unlock-nets", default="", help="comma list of routed nets whose existing copper the router may "
                    "rip up and route again (default: all existing copper is locked)")
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
    planes = [n for n in a.plane_nets.split(",") if n]
    if a.gnd_vias and "GND" not in planes:
        planes.insert(0, "GND")
    shutil.copy(a.board, base)
    tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gnd_pad_vias.py")
    for net in planes:
        tmp = os.path.join(a.outdir, "planevias.kicad_pcb")
        r = subprocess.run([sys.executable, tool, base, tmp, "--net", net] + shlex.split(a.via_args),
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        with open(os.path.join(a.outdir, "planevias.log"), "a") as f:
            f.write("".join(l + "\n" for l in r.stdout.splitlines() if "vias added" in l))
        if os.path.isfile(tmp):
            os.replace(tmp, base)

    b = pcbnew.LoadBoard(base)
    was = {}
    unlock = {n for n in a.unlock_nets.split(",") if n}
    for t in b.GetTracks():
        was[t.m_Uuid.AsString()] = t.IsLocked()
        # --unlock-nets: the copper of these nets goes to the router as normal wiring (a start it may rip up and
        # route again); a locked item stays locked
        t.SetLocked(t.IsLocked() or t.GetNetname() not in unlock)
    dsn, ses, rep = (os.path.join(a.outdir, n) for n in ("board.dsn", "board.ses", "report.json"))
    if not pcbnew.ExportSpecctraDSN(b, dsn):
        sys.exit("fastroute_job: DSN export failed")
    # --route-planes: the router also gets the plane nets. Fastroute connects a pad to its plane with a via of its
    # own where gnd_pad_vias.py found no free place (it accepts a connection that ends in a via into the plane).
    skip = [p for p in a.skip_net.split(",") if p] + ([] if a.route_planes else planes)
    plane_names = set(planes)
    if a.route_planes:
        skip = [p for p in skip if not any(fnmatch.fnmatchcase(n, p) for n in planes)]
    nets = set(str(n) for n in b.GetNetsByName().keys() if str(n) and not any(fnmatch.fnmatchcase(str(n), p) for p in skip))
    if a.only_nets:
        # Route only these nets (for example new test points on a finished board); the other nets stay as they are.
        want = {n for n in a.only_nets.split(",") if n}
        missing = want - set(str(n) for n in b.GetNetsByName().keys())
        if missing:
            sys.exit(f"fastroute_job: no such net: {sorted(missing)}")
        nets = want
    with open(dsn) as f:
        text = freeroute.restrict_dsn(f.read(), set(a.layers.split(",")), nets)
    if a.signal_via:
        text = big_signal_via(text, a.signal_via, [c for c in a.signal_via_classes.split(",") if c])
    with open(dsn, "w") as f:
        f.write(text)
    min_um = int(round(b.GetDesignSettings().m_TrackMinWidth / 1000))
    edge_um = int(round(b.GetDesignSettings().m_CopperEdgeClearance / 1000))
    cmd = [BIN, "-de", dsn, "-do", ses, "-mp", str(a.passes), f"--router.min_trace_width_um={min_um}",
           f"--router.copper_to_edge_clearance_um={edge_um}",
           f"--report={rep}", "--diagnose"] + [f"--{kv}" for kv in a.set]
    if a.neck_um:
        cmd.append(f"--router.neck_width_um={a.neck_um}")
    # A pair that has copper on the board already (kept block copper) is not given to the pair router.
    has_copper = {t.GetNetname() for t in b.GetTracks() if t.GetClass() != "PCB_VIA"}
    pairs_file = write_pairs(a.pairs_json, stem + ".kicad_dru", nets - has_copper, os.path.join(a.outdir, "pairs.txt"))
    if pairs_file:
        cmd.append(f"--pairs={pairs_file}")
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

    def key(t):
        e = t.GetEnd() if t.GetClass() == "PCB_TRACK" else t.GetStart()
        return (t.GetClass(), t.GetNetname(), t.GetLayer(), t.GetStart().x, t.GetStart().y, e.x, e.y)
    copper_before = {key(t) for t in b.GetTracks()}
    if not pcbnew.ImportSpecctraSES(b, ses):
        sys.exit("fastroute_job: SES import failed")
    for t in b.GetTracks():
        t.SetLocked(was.get(t.m_Uuid.AsString(), False))
    if a.signal_via:   # the routing padstack back to the class via size
        pro = json.load(open(stem + ".kicad_pro"))["net_settings"]["classes"]
        sizes = {c["name"]: (c["via_diameter"], c["via_drill"]) for c in pro}
        n_big = 0
        for t in b.GetTracks():
            if t.GetClass() == "PCB_VIA" and t.GetWidth(pcbnew.F_Cu) > pcbnew.FromMM(a.signal_via) - 1000:
                d, dr = sizes.get(str(t.GetNetClassName()), sizes["Default"])
                t.SetWidth(pcbnew.FromMM(d))
                t.SetDrill(pcbnew.FromMM(dr))
                n_big += 1
        print(f"fastroute_job: {n_big} signal vias routed with the {a.signal_via:g} mm padstack, set to the class size",
              flush=True)
    after = vias()
    imported_vias = after
    if a.only_nets:
        # Fastroute can add copper to a net that is not in --only-nets (RELAY-4 2026-10-04: a second route on /COIL1
        # and /LINK_SCL, both already connected). Remove new copper on the other nets: they keep their old copper.
        want = {n for n in a.only_nets.split(",") if n}
        extra = [t for t in b.GetTracks() if t.GetNetname() not in want and key(t) not in copper_before]
        names = sorted({t.GetNetname() for t in extra})
        for t in extra:
            b.Delete(t)
        if extra:
            print(f"fastroute_job: removed {len(extra)} new items on nets outside --only-nets: {', '.join(names)}")
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(out, b)
    drc = os.path.join(a.outdir, "drc.json")
    subprocess.run([KICAD_CLI, "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o", drc, out],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if a.render:
        # One top-view picture per job (user rule 2026-10-03: each shrink step has a board picture).
        subprocess.run([KICAD_CLI, "pcb", "render", "--side", "top", "--quality", "basic", "-w", "1600", "-h", "1200",
                        "-o", os.path.join(a.outdir, "routed.png"), out], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    d = json.load(open(drc))
    # Repair: a plane-net pad that is open after routing (no via, or the pour to its via is cut) gets its own
    # stub and via now, with the routed copper as the obstacle. Then DRC runs again.
    todo = {}
    for u in d.get("unconnected_items", []):
        for it in u.get("items", []):
            m = re.match(r"Pad (\S+) \[([^\]]*)\] of (\S+)", it["description"])
            if m and m.group(2) in plane_names:
                todo.setdefault(m.group(2), set()).add(f"{m.group(3)}.{m.group(1)}")
    # A pour piece on an outer layer with pads but no via or through-hole pad of its net is an island with parts on
    # it (DRC shows it as zone to zone, with no pad name): its pads go to the repair list too.
    if any("Zone" in u["items"][0]["description"] and "Zone" in u["items"][1]["description"] for u in d.get("unconnected_items", [])):
        rb = pcbnew.LoadBoard(out)
        for z in rb.Zones():
            net = z.GetNetname()
            if z.GetIsRuleArea() or net not in plane_names or z.GetLayer() not in (pcbnew.F_Cu, pcbnew.B_Cu):
                continue
            poly = z.GetFilledPolysList(z.GetLayer())
            anchors = [t.GetPosition() for t in rb.GetTracks() if t.GetClass() == "PCB_VIA" and t.GetNetname() == net]
            smd = []
            for fp in rb.GetFootprints():
                for p in fp.Pads():
                    if p.GetNetname() != net:
                        continue
                    if p.GetDrillSize().x:
                        anchors.append(p.GetPosition())
                    elif p.IsOnLayer(z.GetLayer()):
                        smd.append((f"{fp.GetReference()}.{p.GetNumber()}", p.GetPosition()))
            for i in range(poly.OutlineCount()):
                if any(poly.Contains(pt, i) for pt in anchors):
                    continue
                for name, pt in smd:
                    if poly.Contains(pt, i):
                        todo.setdefault(net, set()).add(name)
    if todo:
        for net, pads in todo.items():
            tmp = os.path.join(a.outdir, "repair.kicad_pcb")
            r = subprocess.run([sys.executable, tool, out, tmp, "--net", net, "--only", ",".join(sorted(pads))]
                               + shlex.split(a.via_args), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            with open(os.path.join(a.outdir, "planevias.log"), "a") as f:
                f.write("".join("repair " + l + "\n" for l in r.stdout.splitlines() if "vias added" in l))
            if os.path.isfile(tmp):
                os.replace(tmp, out)
        subprocess.run([KICAD_CLI, "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o", drc, out],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        d = json.load(open(drc))
        after = sum(1 for t in pcbnew.LoadBoard(out).GetTracks() if t.GetClass() == "PCB_VIA")
    errors = sum(1 for v in d.get("violations", []) if v.get("severity") == "error")
    diag = report.get("diagnosis", {})
    # Open connections of the skipped (ground) nets are a ground-via matter (gnd_pad_vias.py, a thermal pad via),
    # not a routing result: they are counted apart, so one ground pad cannot decide a placement step.
    gnd_open = 0
    for u in d.get("unconnected_items", []):
        m = re.search(r"\[([^\]]*)\]", u["items"][0]["description"]) if u.get("items") else None
        name = m.group(1) if m else ""
        if any(fnmatch.fnmatchcase(name, p) for p in skip) or name in plane_names:
            gnd_open += 1
    signal_open = len(d.get("unconnected_items", [])) - gnd_open
    print(f"UNROUTED {signal_open} GND_OPEN {gnd_open} ERRORS {errors} ROUTER_UNROUTED {report['stats']['unrouted']} "
          f"CONGESTION {diag.get('congestion', 0)} BLOCKED {diag.get('blocked', 0)} "
          f"TRACK_MM {report['stats']['trace_length_mm']:.0f} VIAS {after} SECONDS {secs}", flush=True)
    if imported_vias != report["stats"]["vias"]:
        print(f"fastroute_job: RESULT NOT VERIFIED: {imported_vias} vias on the board, {report['stats']['vias']} in the router report", flush=True)
        sys.exit(4)


if __name__ == "__main__":
    main()
