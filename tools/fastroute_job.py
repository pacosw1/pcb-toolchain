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

Route features (tools/route-features.json, a board override in <board>/gate.json "route_features", the environment
ROUTE_FEATURES="name=1,..." last; tools/route_features.py show BOARD prints them). Each one is off unless switched on:
  pin_escape_check   before routing: tools/route_grid.py escape -> OUTDIR/pin-escape.json, line "ESCAPE ..."
  via_off_small_pads before routing: a DSN via_keepout over each SMD pad smaller than max_pad_mm
  rule_compiler      before routing: .kicad_dru (+ extra rules) -> per-net use_layer masks, via bans, class_class
  via_halo           the --signal-via padstack (size_mm) for the selected nets, also with no --signal-via argument
  triage_opens       after routing: tools/route_grid.py triage -> OUTDIR/open-triage.json (+ <board>/.gate/), "TRIAGE ..."
The feature lines are printed before the UNROUTED line (callers read the last UNROUTED line).
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
import dsn_skip

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import freeroute  # noqa: E402  (restrict_dsn)
import route_features  # noqa: E402  (feature switches, tools/route-features.json)
import lean_workflow as lean
import thermal_repair
import import_pose_guard
import import_replay_guard
import backend_quality

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


def big_signal_via(text, dia_mm, classes, nets=()):
    """A second via padstack "Via[0-3]_RP_um" (circle dia_mm on every layer of the class via padstack) for the nets of
    the given DSN classes: (use_via ...) of those classes points to it."""
    m = re.search(r'\(padstack "(Via[^"]*)"\n(.*?)\n    \)', text, re.S)
    if not m:
        sys.exit("fastroute_job: no via padstack in the DSN")
    name, body = m.group(1), m.group(2)
    big = re.sub(r'\(circle (\S+) [\d.]+\)', lambda k: f'(circle {k.group(1)} {int(dia_mm * 1000)})', body)
    text = text.replace(m.group(0), m.group(0) + f'\n    (padstack "Via[0-3]_RP_um"\n{big}\n    )', 1)
    text = text.replace(f'(via "{name}")', f'(via "{name}" "Via[0-3]_RP_um")', 1)
    if nets:   # only these nets (fnmatch globs) get the big padstack: each class block loses them to a copy "<class>_RPV"
        add = []

        def split_class(m):
            head, names, tail = m.group(1), m.group(2), m.group(3)
            toks = re.findall(r'"[^"]*"|\S+', names)
            hit = [t for t in toks if any(fnmatch.fnmatchcase(t.strip('"'), g) for g in nets)]
            if not hit:
                return m.group(0)
            keep = [t for t in toks if t not in hit]
            big_tail = re.sub(r'\(use_via "[^"]*"\)', '(use_via "Via[0-3]_RP_um")', tail)
            add.append(f"    (class {head}_RPV " + " ".join(hit) + "\n      " + big_tail.lstrip())
            return f"(class {head} " + " ".join(keep) + "\n      " + tail.lstrip()
        text = re.sub(r'\(class (\S+) ((?:"[^"]*"|[^()"])*?)(\(circuit.*?\n    \))', split_class, text, flags=re.S)
        i = text.rfind("    (class ")
        j = text.find("\n    )", i) + len("\n    )")
        text = text[:j] + "\n" + "\n".join(add) + text[j:]
        return text
    for c in classes:
        i = text.find(f"(class {c} ")
        if i < 0:
            continue
        j = text.find("(use_via", i)
        k = text.find(")", j)
        text = text[:j] + '(use_via "Via[0-3]_RP_um"' + text[k:]
    return text


def _parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("board")
    ap.add_argument("outdir")
    ap.add_argument("--passes", type=int, default=40)
    ap.add_argument('--quality-backend-manifest', default=os.environ.get('FASTROUTE_QUALITY_MANIFEST'),
                    help='bind a verified patched backend; --quality-first is then mandatory')
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
    ap.add_argument("--optimizer", choices=['always', 'off', 'if-routed'], default='always',
                    help='if-routed screens without polishing, then optimizes the checkpoint only at zero router opens')
    ap.add_argument('--preflight', action='store_true',
                    help='stop on native DRC existing-copper shorts/clearance faults before routing')
    ap.add_argument("--render", action="store_true", help="write OUTDIR/routed.png (kicad-cli pcb render, top view)")
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--signal-via", type=float, default=0.0, help="routing padstack diameter (mm) of the vias of the "
                    "--signal-via-classes nets: the router keeps other copper off a disc this wide round each signal "
                    "via (room for an RP-001 ground via); after the import the vias get their class size again")
    ap.add_argument("--signal-via-classes", default="FIELD,HOST")
    ap.add_argument("--signal-via-nets", default="", help="comma list of net globs: only these nets get the --signal-via "
                    "padstack (the classes are not used), for example the fast nets for kicad-happy RP-001")
    ap.add_argument("--unlock-nets", default="", help="comma list of routed nets whose existing copper the router may "
                    "rip up and route again (default: all existing copper is locked)")
    a = ap.parse_args()
    if a.max_time < 0 or a.threads < 0 or a.passes <= 0:
        ap.error('passes must be positive; time and threads must be nonnegative')
    if any(k.split('=', 1)[0] in ('router.autorouter.max_threads', 'router.optimizer.max_threads') for k in a.set):
        ap.error('use --threads for admitted autorouter and optimizer caps')
    if a.optimizer != 'always' and any(k.split('=', 1)[0] == 'router.optimizer.enabled' for k in a.set):
        ap.error('--optimizer conflicts with --set router.optimizer.enabled')
    return a


def _main(a=None):
    a = _parse_args() if a is None else a
    import lean_resources as resources
    a.threads = a.threads or resources.default_cpu()
    if not os.path.isfile(BIN):
        sys.exit(f"fastroute_job: binary not found: {BIN} (set FASTROUTE_BIN)")
    if os.path.isdir(a.outdir) and os.listdir(a.outdir):
        sys.exit('router output directory is not empty; choose a fresh job directory')
    os.makedirs(a.outdir, exist_ok=True)
    phases = os.path.join(a.outdir, 'stages.jsonl')
    try:
        backend_policy = backend_quality.bind(BIN, a.quality_backend_manifest)
    except (ValueError, OSError) as exc:
        lean.atomic_json(os.path.join(a.outdir, 'backend-policy.json'),
                         dict(mode='rejected', reason=str(exc), qualified=False))
        sys.exit('fastroute_job: required quality backend rejected: ' + str(exc))
    lean.atomic_json(os.path.join(a.outdir, 'backend-policy.json'), backend_policy)
    stem = os.path.splitext(a.board)[0]
    feat = route_features.load(a.board)
    print("FEATURES " + route_features.summary(feat), flush=True)
    lean.atomic_json(os.path.join(a.outdir, 'input-manifest.json'),
                     dict(board=os.path.abspath(a.board), board_sha256=lean.digest(a.board),
                          router_sha256=lean.digest(BIN), configuration=vars(a), features=feat,
                          sidecars={ext: lean.digest(os.path.splitext(a.board)[0]+ext)
                                    for ext in ('.kicad_pro', '.kicad_dru')
                                    if os.path.isfile(os.path.splitext(a.board)[0]+ext)},
                          qualified=False))
    base = os.path.join(a.outdir, "base.kicad_pcb")
    if backend_policy['mode'] == 'quality-first':
        capability = lean.run_stage([BIN, '--help'], stage='quality-backend-capability',
            event_file=phases, deadline=lean.deadline_after(10),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            if capability.returncode:
                raise ValueError('quality backend capability probe failed')
            backend_quality.require_capability(capability.stdout)
        except ValueError as exc:
            lean.atomic_json(os.path.join(a.outdir, 'backend-policy.json'),
                             dict(mode='rejected', reason=str(exc), qualified=False))
            sys.exit('fastroute_job: required quality backend rejected: ' + str(exc))
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

    def routed_nets_file():
        f = os.path.join(a.outdir, "routed-nets.txt")
        open(f, "w").write("\n".join(sorted(nets)) + "\n")
        return f

    b = pcbnew.LoadBoard(base)
    if a.preflight:
        check = os.path.join(a.outdir, 'preflight.json')
        p = lean.run_stage([KICAD_CLI, 'pcb', 'drc', '--refill-zones', '--severity-all', '--format', 'json',
                            '--units', 'mm', '-o', check, base], stage='native-preflight',
                           event_file=os.path.join(a.outdir, 'stages.jsonl'),
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if p.returncode or not os.path.isfile(check):
            sys.exit('preflight failed to produce independent native evidence')
        d = lean.validate_drc(json.load(open(check)))
        d, thermal = thermal_repair.repair(base, a.board, d, planes, shlex.split(a.via_args),
                                          KICAD_CLI, os.path.join(a.outdir, 'stages.jsonl'), 'preflight-thermal')
        lean.atomic_json(check, d)
        lean.atomic_json(os.path.join(a.outdir, 'preflight-thermal.json'), thermal)
        b = pcbnew.LoadBoard(base)
        faults = lean.preflight_errors(d) + [v for v in d['violations']
                                             if v.get('severity') == 'error' and v.get('type') == 'starved_thermal']
        lean.atomic_json(os.path.join(a.outdir, 'preflight-summary.json'),
                         dict(board_sha256=lean.digest(base), blocking=faults,
                              note='opens and router-internal skipped-net findings are not preflight blockers'))
        if faults:
            sys.exit(f'preflight blocked: {len(faults)} native existing-copper faults; see {check}')
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
    if route_features.on(feat, "pin_escape_check"):
        # Read-only check on the job input (with the plane pad vias): pins of the routed nets that cannot leave their part.
        p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "route_grid.py"),
                            "escape", base, "--layers", a.layers, "--skip", "", "--nets", routed_nets_file(),
                            "--out", os.path.join(a.outdir, "pin-escape.json")], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        print(([l for l in p.stdout.splitlines() if l.startswith("ESCAPE")] or ["ESCAPE failed"])[-1], flush=True)
    with open(dsn) as f:
        # Keep electrical membership: exclusions are applied as dedicated router
        # classes after rule and padstack transformations below.
        text = freeroute.restrict_dsn(f.read(), set(a.layers.split(",")), None)
    net_class = route_features.dsn_classes(text)
    mandatory_masks = {}
    base_b_cfg = None
    if os.path.basename(stem) == 'BASE-PWR-B' or os.environ.get('ROUTE_BOARD') == 'BASE-PWR-B':
        import base_b_route_rules
        base_b_dir = os.path.join(route_features.ROOT, 'hardware-design', 'boards', 'BASE-PWR-B')
        base_b_cfg = base_b_route_rules.evidence(base_b_dir, stem + '.kicad_pro')
        layers = [l for l in a.layers.split(',') if l]
        for n in nets:
            allow = [l for l in layers if l != 'In1.Cu' and
                     (l != 'In2.Cu' or base_b_route_rules.eligible(n, *base_b_cfg))]
            if not allow:
                sys.exit(f'BASE-B no legal routing layer for {n}')
            if allow != layers:
                mandatory_masks[n] = allow
    if route_features.on(feat, "via_halo"):
        # The CELLULAR halo for every board: the selected nets get the larger via padstack (room for an RP-001 via).
        hn = route_features.halo_nets(feat, sorted(nets), net_class, feat["_board_dir"], a.board)
        if a.signal_via and a.signal_via_nets:
            hn = sorted(set(hn) | {n for n in a.signal_via_nets.split(",") if n})
        if hn:
            a.signal_via = a.signal_via or float(feat["via_halo"].get("size_mm", 1.8))
            a.signal_via_nets = ",".join(hn)
        print(f"VIA_HALO {len(hn)} nets, {a.signal_via:g} mm", flush=True)
    if a.signal_via:
        text = big_signal_via(text, a.signal_via, [c for c in a.signal_via_classes.split(",") if c],
                              [n for n in a.signal_via_nets.split(",") if n])
    if route_features.on(feat, "rule_compiler"):
        pad_layers = {}
        for fp in b.GetFootprints():
            for p in fp.Pads():
                pad_layers.setdefault(p.GetNetname(), set()).add("*" if p.GetDrillSize().x else p.GetLayerName())
        dru_text = open(stem + ".kicad_dru").read() if os.path.isfile(stem + ".kicad_dru") else ""
        rc_cfg = feat["rule_compiler"]
        masks, pairs, notes = route_features.compile_dru(dru_text, sorted(nets), net_class, pad_layers,
                                                         [l for l in a.layers.split(",") if l], rc_cfg.get("extra", []))
        for n, allowed in mandatory_masks.items():
            masks[n] = [l for l in masks.get(n, a.layers.split(',')) if l in allowed]
            if not masks[n]:
                sys.exit(f'BASE-B and compiled rules deny every layer for {n}')
        text = route_features.apply_layer_masks(text, masks)
        route_features.verify_layer_masks(text, masks)
        if rc_cfg.get("class_class", True):
            text = route_features.add_class_class(text, pairs)
        with open(os.path.join(a.outdir, "rules.log"), "w") as f:
            f.write("\n".join(notes) + "\n" + "".join(f"mask {n}: {' '.join(v)}\n" for n, v in sorted(masks.items())) +
                    "".join(f"class_class {x} {y}: {v:g} mm\n" for (x, y), v in sorted(pairs.items())))
        print(f"RULES masks {len(masks)} class_class {len(pairs) if rc_cfg.get('class_class', True) else 0} "
              f"notes {len(notes)} (see rules.log)", flush=True)
    elif mandatory_masks:
        text = route_features.apply_layer_masks(text, mandatory_masks)
        route_features.verify_layer_masks(text, mandatory_masks)
    if route_features.on(feat, "via_off_small_pads"):
        lim = pcbnew.FromMM(float(feat["via_off_small_pads"].get("max_pad_mm", 2.0)))
        polys = []
        job_layers = set(a.layers.split(","))
        for fp in b.GetFootprints():
            for p in fp.Pads():
                ln = p.GetLayerName()
                if p.GetDrillSize().x or ln not in job_layers:
                    continue
                bb = p.GetBoundingBox()
                if min(bb.GetWidth(), bb.GetHeight()) >= lim:
                    continue
                ps = pcbnew.SHAPE_POLY_SET()
                p.TransformShapeToPolygon(ps, p.GetLayer(), 0, 5000, pcbnew.ERROR_INSIDE)
                if ps.OutlineCount():
                    ol = ps.Outline(0)
                    polys.append((ln, [(ol.CPoint(i).x / 1e6, ol.CPoint(i).y / 1e6) for i in range(ol.PointCount())]))
        text = route_features.add_via_keepouts(text, polys)
        print(f"VIAKEEP {len(polys)} SMD pads below {pcbnew.ToMM(lim):g} mm", flush=True)
    if unlock - nets:
        sys.exit('fastroute_job: skipped nets cannot have unlocked copper')
    if any(k.split('=', 1)[0] == 'router.autorouter.ignore_net_classes' for k in a.set):
        sys.exit('fastroute_job: ignored classes are derived from selected nets')
    text, ignored_classes = dsn_skip.exclude(text, nets)
    if ignored_classes:
        help_result = subprocess.run([BIN, '--help'], capture_output=True, text=True, timeout=10)
        if help_result.returncode or 'router.autorouter.ignore_net_classes' not in help_result.stdout:
            sys.exit('fastroute_job: backend does not support safe net-class exclusion')
    with open(dsn, "w") as f:
        f.write(text)
    min_um = int(round(b.GetDesignSettings().m_TrackMinWidth / 1000))
    edge_um = int(round(b.GetDesignSettings().m_CopperEdgeClearance / 1000))
    cmd = [BIN, "-de", dsn, "-do", ses, "-mp", str(a.passes), f"--router.min_trace_width_um={min_um}",
           f"--router.copper_to_edge_clearance_um={edge_um}",
           f"--report={rep}", "--diagnose"] + [f"--{kv}" for kv in a.set]
    if ignored_classes:
        cmd.append('--router.autorouter.ignore_net_classes=' + ','.join(ignored_classes))
    if a.neck_um:
        cmd.append(f"--router.neck_width_um={a.neck_um}")
    if backend_policy['mode'] == 'quality-first':
        cmd.append('--quality-first')
    # A pair that has copper on the board already (kept block copper) is not given to the pair router.
    has_copper = {t.GetNetname() for t in b.GetTracks() if t.GetClass() != "PCB_VIA"}
    pairs_file = write_pairs(a.pairs_json, stem + ".kicad_dru", nets - has_copper, os.path.join(a.outdir, "pairs.txt"))
    if pairs_file:
        cmd.append(f"--pairs={pairs_file}")
    if a.max_time:
        cmd.append(f"--max-time={a.max_time}")
    # Bound both phases with the same remaining job budget, and cap both pools.
    if a.optimizer != 'always':
        cmd += lean.optimizer_options(a.optimizer)
    if a.threads:
        cmd += [f'--router.autorouter.max_threads={a.threads}', f'--router.optimizer.max_threads={a.threads}']
    sources = [os.environ.get('ROUTE_FEATURES_FILE') or route_features.DEFAULTS]
    if feat['_board_dir']:
        sources += [os.path.join(feat['_board_dir'], 'gate.json'),
                    os.path.join(feat['_board_dir'], feat['via_halo'].get('fast_nets_file', 'rp001-fast-nets.json'))]
    if base_b_cfg:
        sources += [os.path.join(base_b_dir, name) for name in
                    ('current-paths.json','reference-planes.json','rp001-fast-nets.json','diff-pairs.json')]
        sources += [base_b_route_rules.__file__]
    effective = dict(configuration=vars(a), features=feat, command=cmd, dsn_sha256=lean.digest(dsn),
                     backend_policy=backend_policy,
                     feature_sources={p: lean.digest(p) for p in sources if os.path.isfile(p)},
                     environment={k: os.environ.get(k) for k in ('ROUTE_FEATURES','ROUTE_BOARD','ROUTE_FEATURES_FILE')},
                     learned_halo=route_features.learned_halo(a.board, feat['_board_dir'])[1],
                     mandatory_layer_masks=mandatory_masks, ignored_classes=ignored_classes, qualified=False)
    import hashlib
    effective['effective_sha256'] = hashlib.sha256(json.dumps(effective, sort_keys=True).encode()).hexdigest()
    lean.atomic_json(os.path.join(a.outdir, 'effective-configuration.json'), effective)
    t0 = lean.now()
    deadline = lean.deadline_after(a.max_time) if a.max_time else lean.inherited_deadline()
    phases = os.path.join(a.outdir, 'stages.jsonl')
    with open(os.path.join(a.outdir, "run.log"), "w") as lf:
        rc = lean.run_stage(cmd, stage='router-screen' if a.optimizer != 'always' else 'router',
                            event_file=phases, deadline=deadline, stdout=lf, stderr=subprocess.STDOUT).returncode
    if rc == 0 and a.optimizer == 'if-routed' and os.path.isfile(rep) and os.path.isfile(ses):
        screen = json.load(open(rep))
        if dsn_skip.routable_open(screen) == 0:
            checkpoint = os.path.join(a.outdir, 'screen.ses')
            shutil.copy(ses, checkpoint)
            shutil.copy(rep, os.path.join(a.outdir, 'screen-report.json'))
            optimize = [x for x in cmd if not x.startswith('--router.optimizer.enabled=')
                        and not x.startswith('--max-time=')]
            optimize += ['--router.optimizer.enabled=true', f'--initial-session={checkpoint}']
            left = lean.remaining(deadline)
            if left is not None:
                optimize.append(f'--max-time={max(1, int(left))}')
            with open(os.path.join(a.outdir, 'optimize.log'), 'w') as lf:
                rc = lean.run_stage(optimize, stage='router-optimize', event_file=phases, deadline=deadline,
                                    stdout=lf, stderr=subprocess.STDOUT).returncode
        else:
            print('OPTIMIZER deferred: screening result still has open connections', flush=True)
    secs = int(lean.now() - t0)
    if rc != 0 or not os.path.isfile(ses) or not os.path.isfile(rep):
        sys.exit(f"fastroute_job: fastroute failed (rc {rc}), see {a.outdir}/run.log")
    report = json.load(open(rep))

    vias = lambda: sum(1 for t in b.GetTracks() if t.GetClass() == "PCB_VIA")

    def key(t):
        e = t.GetEnd() if t.GetClass() == "PCB_TRACK" else t.GetStart()
        return (t.GetClass(), t.GetNetname(), t.GetLayer(), t.GetStart().x, t.GetStart().y, e.x, e.y)
    copper_before = {key(t) for t in b.GetTracks()}
    def skipped_copper(original_locks=False):
        records = []
        for t in b.GetTracks():
            if t.GetNetname() in nets:
                continue
            via = t.GetClass() == 'PCB_VIA'
            mid = t.GetMid() if t.GetClass() == 'PCB_ARC' else t.GetStart()
            records.append((key(t), t.GetEnd().x, t.GetEnd().y, mid.x, mid.y,
                            tuple((layer, t.GetWidth(layer)) for layer in b.GetEnabledLayers().CuStack()) if via else t.GetWidth(),
                            t.GetDrillValue() if via else 0,
                            t.TopLayer() if via else t.GetLayer(),
                            t.BottomLayer() if via else t.GetLayer(),
                            was.get(t.m_Uuid.AsString(), False) if original_locks else t.IsLocked()))
        return sorted(records)
    skipped_before = skipped_copper(original_locks=True)
    try:
        poses_before = import_pose_guard.snapshot(b)
        pose_grid = import_pose_guard.grid_nm(dsn, ses)
        replay_path = os.path.join(a.outdir, 'import-copper-snapshot.kicad_pcb')
        preserved = {t.m_Uuid.AsString() for t in b.GetTracks() if t.IsLocked()}
        replay_before = import_replay_guard.snapshot(b, replay_path)
    except ValueError as exc:
        sys.exit('fastroute_job: SES pose integrity precondition failed; result is not verified: ' + str(exc))
    if not pcbnew.ImportSpecctraSES(b, ses):
        sys.exit("fastroute_job: SES import failed")
    try:
        restored = import_pose_guard.restore(b, poses_before, pose_grid)
        replays = import_replay_guard.restore(b, replay_before, preserved, dsn, ses, replay_path)
    except ValueError as exc:
        sys.exit('fastroute_job: SES pose integrity failed; result is not verified: ' + str(exc))
    with open(os.path.join(a.outdir, 'import-pose-audit.json'), 'w') as audit:
        json.dump(dict(grid_nm=pose_grid, restored=restored, exact_poses_and_pads=True,
                       guard_sha256=lean.digest(import_pose_guard.__file__),
                       dsn_sha256=lean.digest(dsn), ses_sha256=lean.digest(ses),
                       before_snapshot_sha256=hashlib.sha256(json.dumps(poses_before, sort_keys=True).encode()).hexdigest(),
                       qualified=False, independent_native_gate_required=True), audit, indent=2)
    with open(os.path.join(a.outdir, 'import-replay-audit.json'), 'w') as audit:
        json.dump(dict(removed=replays, preserved_uuids=sorted(preserved),
                       exact_preserved_source_policy=True, qualified=False,
                       independent_native_gate_required=True,
                       dsn_sha256=lean.digest(dsn), ses_sha256=lean.digest(ses)),audit,indent=2)
    for t in b.GetTracks():
        t.SetLocked(was.get(t.m_Uuid.AsString(), False))
    if skipped_copper() != skipped_before:
        sys.exit('fastroute_job: router changed excluded-net copper; result is not verified')
    if a.signal_via:   # the routing padstack back to the class via size
        pro = json.load(open(stem + ".kicad_pro"))["net_settings"]["classes"]
        sizes = {c["name"]: (c["via_diameter"], c["via_drill"]) for c in pro}
        n_big = 0
        for t in b.GetTracks():
            if (t.GetClass() == "PCB_VIA" and t.GetNetname() in nets and key(t) not in copper_before
                    and t.GetWidth(pcbnew.F_Cu) > pcbnew.FromMM(a.signal_via) - 1000):
                d, dr = sizes.get(str(t.GetNetClassName()), sizes["Default"])
                t.SetWidth(pcbnew.FromMM(d))
                t.SetDrill(pcbnew.FromMM(dr))
                n_big += 1
        print(f"fastroute_job: {n_big} signal vias routed with the {a.signal_via:g} mm padstack, set to the class size",
              flush=True)
    if skipped_copper() != skipped_before:
        sys.exit('fastroute_job: via normalization changed excluded-net copper; result is not verified')
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
    p = lean.run_stage([KICAD_CLI, "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o", drc, out],
                       stage='native-drc', event_file=phases, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if p.returncode:
        sys.exit('native DRC failed; result is not verified')
    d = lean.validate_drc(json.load(open(drc)))
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
        p = lean.run_stage([KICAD_CLI, "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o", drc, out],
                           stage='repair-drc', event_file=phases, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if p.returncode:
            sys.exit('native repair DRC failed; result is not verified')
        d = lean.validate_drc(json.load(open(drc)))
        after = sum(1 for t in pcbnew.LoadBoard(out).GetTracks() if t.GetClass() == "PCB_VIA")
    d, thermal = thermal_repair.repair(out, a.board, d, planes, shlex.split(a.via_args),
                                      KICAD_CLI, phases, 'postroute-thermal')
    lean.atomic_json(drc, d)
    lean.atomic_json(os.path.join(a.outdir, 'thermal-repair.json'), thermal)
    after = sum(1 for t in pcbnew.LoadBoard(out).GetTracks() if t.GetClass() == 'PCB_VIA')
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
    if route_features.on(feat, "triage_opens"):
        tri = os.path.join(a.outdir, "open-triage.json")
        if signal_open:
            p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "route_grid.py"),
                                "triage", out, "--drc", drc, "--layers", a.layers, "--skip", ",".join(skip + planes), "--nets", routed_nets_file(),
                                "--out", tri], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            print(([l for l in p.stdout.splitlines() if l.startswith("TRIAGE")] or ["TRIAGE failed"])[-1], flush=True)
        else:
            json.dump({"open": 0, "enclosed": 0, "router_miss": 0, "connections": []}, open(tri, "w"))
            print("TRIAGE open 0", flush=True)
        if feat["_board_dir"] and os.path.isfile(tri):
            os.makedirs(os.path.join(feat["_board_dir"], ".gate"), exist_ok=True)
            shutil.copy(tri, os.path.join(feat["_board_dir"], ".gate", "open-triage.json"))
    print(f"UNROUTED {signal_open} GND_OPEN {gnd_open} ERRORS {errors} ROUTER_UNROUTED {report['stats']['unrouted']} "
          f"CONGESTION {diag.get('congestion', 0)} BLOCKED {diag.get('blocked', 0)} "
          f"TRACK_MM {report['stats']['trace_length_mm']:.0f} VIAS {after} SECONDS {secs}", flush=True)
    if imported_vias != report["stats"]["vias"]:
        print(f"fastroute_job: RESULT NOT VERIFIED: {imported_vias} vias on the board, {report['stats']['vias']} in the router report", flush=True)
        sys.exit(4)
    if base_b_cfg:
        rb = pcbnew.LoadBoard(out)
        faults = base_b_route_rules.layer_faults([(t.GetNetname(), t.GetLayerName()) for t in rb.GetTracks()
                                                if t.GetClass() != 'PCB_VIA'], *base_b_cfg)
        counts = {}
        for t in rb.GetTracks():
            if t.GetClass() == 'PCB_VIA':
                counts[t.GetNetname()] = counts.get(t.GetNetname(), 0) + 1
        faults += base_b_route_rules.pair_via_faults(counts, json.load(open(os.path.join(base_b_dir, 'diff-pairs.json')))['pairs'])
        lean.atomic_json(os.path.join(a.outdir, 'mandatory-rules.json'), dict(faults=faults, qualified=False))
        if faults:
            sys.exit('BASE-B mandatory imported-board rule check failed; see mandatory-rules.json')
    # Required image reflects the final repaired board, not the earlier import.
    if a.render:
        p = lean.run_stage([KICAD_CLI, "pcb", "render", "--side", "top", "--quality", "basic", "-w", "1600", "-h", "1200",
                            "-o", os.path.join(a.outdir, "routed.png"), out], stage='render', event_file=phases,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if p.returncode or not os.path.isfile(os.path.join(a.outdir, 'routed.png')):
            sys.exit('required per-step rendering failed')
    lean.atomic_json(os.path.join(a.outdir, 'outcome.json'),
                     dict(status='complete', qualified=False, optimizer=a.optimizer, signal_open=signal_open,
                          ground_open=gnd_open, errors=errors, board_sha256=lean.digest(out),
                          note='import verified; full final board gate remains required'))


def main():
    import lean_resources as resources
    a = _parse_args()
    cpu = a.threads or resources.default_cpu()
    outdir = a.outdir
    events = outdir + '.admission.jsonl' if outdir else None
    try:
        budget_env = dict(os.environ)
        if a.max_time:
            budget_env['IOT_LEAN_DEADLINE'] = lean.encode_deadline(lean.deadline_after(a.max_time))
        with resources.environment(budget_env), resources.reserve(cpu, events=events, label='routing') as env:
            with resources.environment(env):
                return _main(a)
    except (TimeoutError, subprocess.TimeoutExpired) as error:
        if outdir and os.path.isdir(outdir):
            lean.router_timeout(outdir, error)
        print('fastroute_job: deadline reached; retained checkpoints are unqualified', file=sys.stderr)
        return 124
    except KeyboardInterrupt as error:
        code = 128 + (getattr(error, 'signum', None) or 2)
        if outdir and os.path.isdir(outdir):
            lean.atomic_json(os.path.join(outdir, 'outcome.json'), dict(status='cancelled',
                             returncode=code, qualified=False, signal=getattr(error, 'signum', None),
                             cleanup=getattr(error, 'cleanup', None)))
        return code


if __name__ == "__main__":
    sys.exit(main())
