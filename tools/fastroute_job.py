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
     --router.copper_to_edge_clearance_um=<board setting> --report.
  4. tools/import_ses.py rule: import with locked copper; via count must equal the router report.
  5. kicad-cli pcb drc on OUTDIR/routed.kicad_pcb (the .kicad_pro and .kicad_dru of BOARD are copied).
Prints "UNROUTED <signal> GND_OPEN <n> ERRORS <n> ROUTER_UNROUTED <n> CONGESTION <n> BLOCKED <n> TRACK_MM <n> VIAS <n> SECONDS <n>".
CONGESTION and BLOCKED are "unknown" when the optional backend diagnosis was not measured.
UNROUTED counts the open connections of the routed nets only; GND_OPEN counts those of the --skip-net nets.
Exit code 4: the result is not verified (do not use the board).

Route features (tools/route-features.json, a board override in <board>/gate.json "route_features", the environment
ROUTE_FEATURES="name=1,..." last; tools/route_features.py show BOARD prints them). Each one is off unless switched on:
  pin_escape_check   before routing: tools/route_grid.py escape -> OUTDIR/pin-escape.json, line "ESCAPE ..."
  via_off_small_pads before routing: a DSN via_keepout over each SMD pad smaller than max_pad_mm
  rule_compiler      before routing: .kicad_dru (+ extra rules) -> per-net use_layer masks, via bans, class_class
  via_halo           the --signal-via padstack (size_mm) for the selected nets, also with no --signal-via argument
  triage_opens       after routing: tools/route_grid.py triage -> OUTDIR/open-triage.json (+ <board>/.gate/), "TRIAGE ..."
  routing_rules      D-125 (tools/routing_rules.py): the router runs once per stage (pairs/clocks, fast, escape (W10: Fastroute
                     SMD fanout of the fine-pitch pads inside a belt keepout), wide_hot (W10: switch nodes in a corridor, one
                     layer, raised via cost, max length), wide, rest; then a
                     last pass for the plane nets and the nets a stage left open, their stage copper ripped up; then at most
                     repair_iterations rip-up-and-repair passes over the nets still open and their immediate blockers),
                     each stage's copper locked for the next; via cost via_costs; DSN wire
                     keepouts over the missing reference plane for the signal stages. OUTDIR/stage-plan.json,
                     OUTDIR/via-report.json; lines "STAGES ...", "STAGE ...", "VIAS_BY_STAGE ...". Per-stage files have the
                     stage in the name (board-fast.dsn, report-fast.json); the last pass keeps the plain names.
  fail_fast          D-126: --optimizer always becomes if-routed (the optimizer runs only on a routed board); the router is
                     stopped after stall_passes autorouter passes with no lower open count (line "STALL ...", OUTDIR/stall.json);
                     with open signal connections the job prints "STUCK ..." after the UNROUTED line and exits with code 3.
The feature lines are printed before the UNROUTED line (callers read the last UNROUTED line).
"""
import argparse
import contextlib
import fnmatch
import json
import os
from pathlib import Path
import re
import resource
import shlex
import shutil
import subprocess
import sys
import threading
import time
import dsn_skip

import pcbnew

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import freeroute  # noqa: E402  (restrict_dsn)
import route_features  # noqa: E402  (feature switches, tools/route-features.json)
import route_rule_coverage  # mandatory actual-DSN admission, independent of feature flags
import route_native_thermals
import run_record  # noqa: E402  (W5 run record: OUTDIR/run.jsonl, one action per line; tools/run_record.py OUTDIR)
import route_snapshots  # noqa: E402  (W12 checkpoint snapshots: OUTDIR/snapshots/NNNN.ses + .json + .png)
import lean_workflow as lean
import thermal_repair
import import_pose_guard
import import_replay_guard
import board_uuids
import backend_quality
import routing_rules  # noqa: E402  (D-125 staged order, via cost, reference-plane keepouts)
import route_progress  # noqa: E402  (D-126 live progress: OUTDIR/progress.jsonl, tools/route_status.py)

STUCK_RC = 3   # fail_fast: routed with open signal connections (the result is imported and triaged, not qualified)
BIN = os.environ.get("FASTROUTE_BIN") or os.path.expanduser("~/opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute")
KICAD_CLI = os.environ.get("KICAD_CLI", "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli")


@contextlib.contextmanager
def _native_phase(stage, event_file):
    """Measure blocking native work; deadline checks cannot preempt a C++ call."""
    started = lean.now()
    before_self = resource.getrusage(resource.RUSAGE_SELF)
    before_child = resource.getrusage(resource.RUSAGE_CHILDREN)
    status = 'failed'
    try:
        if lean.remaining() == 0:
            raise subprocess.TimeoutExpired([stage], 0)
        yield
        if lean.remaining() == 0:
            raise subprocess.TimeoutExpired([stage], 0)
        status = 'complete'
    except subprocess.TimeoutExpired:
        status = 'timeout'
        raise
    except KeyboardInterrupt:
        status = 'cancelled'
        raise
    finally:
        after_self = resource.getrusage(resource.RUSAGE_SELF)
        after_child = resource.getrusage(resource.RUSAGE_CHILDREN)
        with open(event_file, 'a') as events:
            events.write(json.dumps(dict(stage=stage, kind='inprocess', status=status,
                wall_s=lean.now()-started,
                self_cpu_s=(after_self.ru_utime+after_self.ru_stime)-(before_self.ru_utime+before_self.ru_stime),
                child_cpu_s=(after_child.ru_utime+after_child.ru_stime)-(before_child.ru_utime+before_child.ru_stime),
                accounting='process deltas; nested/whole-job intervals are non-additive',
                blocking_native=True))+'\n')


def _thermal_inputs(board):
    paths = [Path(board).resolve(), Path(board).with_suffix('.kicad_pro').resolve(),
             Path(board).with_suffix('.kicad_dru').resolve(), Path(__file__).resolve(),
             Path(route_native_thermals.__file__).resolve()]
    return {str(path): lean.digest(path) if path.is_file() else None for path in paths}


def _capture_thermal_source(source, directory):
    """Promotion replaces the workspace input; keep its exact original files."""
    source = Path(source).resolve()
    folder = Path(directory).resolve()/'native-thermal-source'
    folder.mkdir()
    captured = folder/source.name
    inputs, originals = {}, {}
    for suffix in ('.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch'):
        original, target = source.with_suffix(suffix), captured.with_suffix(suffix)
        before = lean.digest(original) if original.is_file() else None
        if before is not None:
            shutil.copyfile(original, target)
        after = lean.digest(original) if original.is_file() else None
        actual = lean.digest(target) if target.is_file() else None
        if before != after or actual != before:
            raise ValueError('native thermal source changed during capture')
        inputs[str(target)] = actual
        originals[str(original)] = before
    receipt = dict(schema='iot-lab.native-thermal-source.v1', qualified=False,
        original=dict(path=str(source), sha256=originals[str(source)]),
        captured=dict(path=str(captured), sha256=inputs[str(captured)]),
        original_files=originals, inputs=inputs)
    lean.atomic_json(Path(directory)/'native-thermal-source.json', receipt)
    return str(captured)


def _checked_thermal_fill(board, path, receipt_path, phases, stage):
    """KiCad's CLI ignores FillAllZones' result; retain the actual checked save."""
    path = str(Path(path).resolve())
    before = _thermal_inputs(path)
    executable = str(Path(sys.executable).resolve())
    receipt = dict(schema='iot-lab.native-thermal-fill.v1', qualified=False,
                   candidate=dict(path=path, sha256=before[path]), inputs=before,
                   fill_result=None, tool=dict(path=executable, sha256=lean.digest(executable)),
                   pcbnew_version=pcbnew.Version(), invocation=dict(operation='ZONE_FILLER.Fill', saved=False))
    try:
        with _native_phase(stage, phases):
            filled = pcbnew.ZONE_FILLER(board).Fill(board.Zones())
            receipt['fill_result'] = filled if type(filled) is bool else None
            if filled is not True:
                raise ValueError('native thermal zone fill did not return True')
            # SaveProjectAs would normalize the copied .pro under a new board
            # basename. Keep the authored project exact while saving the PCB.
            if pcbnew.SaveBoard(path, board, True) is not True:
                raise ValueError('native thermal board save did not return True')
        for name, expected in before.items():
            if name != path and (lean.digest(name) if os.path.isfile(name) else None) != expected:
                raise ValueError('native thermal fill policy or implementation changed')
        receipt['candidate']['sha256'] = lean.digest(path)
        receipt['inputs'][path] = receipt['candidate']['sha256']
        receipt['invocation']['saved'] = True
    except BaseException as error:
        receipt['cause'] = str(error)
        raise
    finally:
        lean.atomic_json(receipt_path, receipt)
    return receipt


def _thermal_drc(path, directory, phases, label):
    """Validate the explicitly filled saved board, without a second hidden fill."""
    path = str(Path(path).resolve())
    report = os.path.join(directory, label + '-report.json')
    receipt_path = os.path.join(directory, label + '-drc.json')
    executable = shutil.which(KICAD_CLI)
    if executable is None:
        raise ValueError('native thermal DRC executable is unavailable')
    executable = str(Path(executable).resolve())
    command = [executable, 'pcb', 'drc', '--severity-all', '--format', 'json', '--units', 'mm', '-o', report, path]
    receipt = dict(schema='iot-lab.native-thermal-drc.v1', qualified=False,
        candidate=dict(path=path, sha256=lean.digest(path)), inputs=_thermal_inputs(path),
        command=command, returncode=None, tool=dict(path=executable, sha256=lean.digest(executable)),
        report=dict(path=os.path.abspath(report), sha256=None))
    try:
        run = lean.run_stage(command, stage=label+'-drc', event_file=phases,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        receipt['returncode'] = run.returncode
        Path(os.path.join(directory, label+'.log')).write_text(run.stdout+run.stderr)
        if os.path.isfile(report):
            receipt['report']['sha256'] = lean.digest(report)
        if run.returncode or not receipt['report']['sha256']:
            raise ValueError('native thermal DRC did not produce successful independent evidence')
        for name, expected in receipt['inputs'].items():
            if (lean.digest(name) if os.path.isfile(name) else None) != expected:
                raise ValueError('native thermal DRC input changed during execution')
        return lean.validate_drc(json.loads(Path(report).read_text())), receipt_path
    except BaseException as error:
        receipt['cause'] = str(error)
        raise
    finally:
        lean.atomic_json(receipt_path, receipt)


@contextlib.contextmanager
def _router_observers(watcher, stop, result, snapshot, stall_path, stall_passes, tag):
    """Settle observers and retain an actual stall even when the solver raises."""
    try:
        watcher.start()
        snapshot.start()
        yield
    finally:
        original = sys.exc_info()[1]
        errors = []
        for name, cleanup in (('watcher stop', stop.set),
                              ('watcher join', lambda: watcher.join(5) if watcher.ident is not None else None),
                              ('snapshot stop', snapshot.stop)):
            try:
                cleanup()
            except BaseException as error:
                errors.append(dict(operation=name, type=type(error).__name__, error=str(error)))
        if watcher.is_alive():
            errors.append(dict(operation='watcher join', error='observer did not settle'))
        thread = getattr(snapshot, 'thread', None)
        if thread is not None and thread.is_alive():
            errors.append(dict(operation='snapshot stop', error='observer did not settle'))
        if result:
            try:
                lean.atomic_json(stall_path, dict(result, stall_passes=stall_passes, stage=tag,
                    observer_cleanup=dict(complete=not errors, errors=errors)))
                print(f"STALL interrupt attempt at pass {result['pass_no']} "
                      f"(acknowledged={result['interrupt_acknowledged']}): {stall_passes} passes "
                      f"without a lower open count (best {result['best']}, last {result['unrouted']}); "
                      f"see {stall_path}", flush=True)
            except BaseException as error:
                errors.append(dict(operation='stall evidence', type=type(error).__name__, error=str(error)))
        if errors:
            # A secondary observer/evidence error must never replace the actual
            # timeout/cancellation and its owned child-cleanup receipt.
            if original is not None:
                print('fastroute_job: observer cleanup/evidence failed: '+str(errors), file=sys.stderr, flush=True)
            else:
                raise RuntimeError('router observer cleanup/evidence failed: '+str(errors))


def _diagnosis_count(report, name):
    diagnosis = report.get('diagnosis')
    value = diagnosis.get(name) if isinstance(diagnosis, dict) else None
    return value if type(value) is int and value >= 0 else 'unknown'


def _strengthen_clearance_model(text, project, before_path, model_path, receipt_path, **scope):
    """Retain exact pre/post model lineage; never write the native project."""
    project = os.path.abspath(project)
    report = dict(schema='iot-lab.dsn-clearance-strengthening.v1', status='blocked',
                  cause='clearance strengthening incomplete', qualified=False, inputs={})
    with open(before_path, 'xb') as stream:
        stream.write(text.encode())
    report['inputs'][os.path.abspath(before_path)] = lean.digest(before_path)
    report['inputs'][project] = lean.digest(project) if os.path.isfile(project) else None
    try:
        with open(project, 'rb') as stream:
            project_text = stream.read().decode('utf-8')
        strengthened, derived = route_features.strengthen_project_clearance(text, project_text,
            source=project, **scope)
        if report['inputs'][project] != derived['project']['sha256'] or lean.digest(project) != derived['project']['sha256']:
            raise ValueError('authored project changed during clearance strengthening')
        if (report['inputs'][os.path.abspath(before_path)] != derived['before_sha256']
                or lean.digest(before_path) != derived['before_sha256']):
            raise ValueError('pre-strengthening DSN changed during clearance strengthening')
        report.update(derived, before=dict(path=os.path.abspath(before_path), sha256=derived['before_sha256']),
                      after=dict(path=os.path.abspath(model_path), sha256=derived['after_sha256']))
        for module in (route_features, route_rule_coverage, route_rule_coverage.route_project_coverage):
            report['inputs'][os.path.abspath(module.__file__)] = lean.digest(module.__file__)
        lean.atomic_json(receipt_path, report)
        return strengthened, report
    except (ValueError, OSError, UnicodeError) as error:
        report.update(status='blocked', cause=str(error))
        lean.atomic_json(receipt_path, report)
        raise


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
    """Add a halo via with an attributable numeric diameter/drill and layer span.

    The importer and replay guard require KiCad's numeric naming convention;
    the former RP alias discarded the drill identity and failed after routing.
    """
    m = re.search(r'\(padstack "(Via[^"]*)"\n(.*?)\n    \)', text, re.S)
    if not m:
        sys.exit("fastroute_job: no via padstack in the DSN")
    name, body = m.group(1), m.group(2)
    source = re.fullmatch(r'Via\[0-(\d+)\]_(\d+):(\d+)_um', name)
    diameter = float(dia_mm) * 1000
    if not source or not diameter.is_integer() or diameter <= int(source[3]):
        raise ValueError('halo requires a supported via and integral micrometre diameter above drill')
    halo = f'Via[0-{source[1]}]_{int(diameter)}:{source[3]}_um'
    if f'(padstack "{halo}"' in text:
        raise ValueError('halo padstack already exists; ambiguous export')
    big = re.sub(r'\(circle (\S+) [\d.]+\)', lambda k: f'(circle {k.group(1)} {int(dia_mm * 1000)})', body)
    text = text.replace(m.group(0), m.group(0) + f'\n    (padstack "{halo}"\n{big}\n    )', 1)
    text = text.replace(f'(via "{name}")', f'(via "{name}" "{halo}")', 1)
    if nets:   # only these nets (fnmatch globs) get the big padstack: each class block loses them to a copy "<class>_RPV"
        add = []

        def split_class(m):
            head, names, tail = m.group(1), m.group(2), m.group(3)
            toks = re.findall(r'"[^"]*"|\S+', names)
            hit = [t for t in toks if any(fnmatch.fnmatchcase(t.strip('"'), g) for g in nets)]
            if not hit:
                return m.group(0)
            keep = [t for t in toks if t not in hit]
            big_tail = re.sub(r'\(use_via "[^"]*"\)', f'(use_via "{halo}")', tail)
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
        text = text[:j] + f'(use_via "{halo}"' + text[k:]
    return text


def copper_key(t):
    """Geometry identity of a track or via (class, net, layer, ends): the same item in the input and the routed board."""
    e = t.GetEnd() if t.GetClass() == "PCB_TRACK" else t.GetStart()
    return (t.GetClass(), t.GetNetname(), t.GetLayer(), t.GetStart().x, t.GetStart().y, e.x, e.y)


def source_copper(path):
    """The keys of every track and via of the job's input board: copper this job must never delete."""
    return {copper_key(t) for t in pcbnew.LoadBoard(path).GetTracks()}


def missing_source_copper(path, keys):
    """Source items (copper_key) that are no longer on the board at path; empty when all are preserved."""
    have = {copper_key(t) for t in pcbnew.LoadBoard(path).GetTracks()}
    return sorted(k for k in keys if k not in have)


def plane_via_clearance_repair(path, drc, plane_names, preserve=frozenset()):
    """Delete each plane-net via (and its stub from the pad) that the DRC lists in a clearance violation against
    copper of another net, and return {net: {"REF.PIN", ...}} of the pads to connect again. The board at path is
    saved without those items. A via with no stub to a pad of its net is left alone (it is not a pad via).
    Audit #815 (CIP 830, 2026-10-11): only copper this job created is repaired. A locked via or stub, or one whose
    copper_key is in preserve (the input board's copper, source_copper), is source copper and is never deleted."""
    hits = []
    for v in drc.get("violations", []):
        if v.get("severity") != "error" or v.get("type") != "clearance":
            continue
        for it in v.get("items", []):
            m = re.match(r"Via \[([^\]]*)\]", it.get("description", ""))
            if m and m.group(1) in plane_names and it.get("pos"):
                hits.append((m.group(1), it["pos"]["x"], it["pos"]["y"]))
    if not hits:
        return {}
    b = pcbnew.LoadBoard(path)
    todo, gone = {}, []
    for net, x, y in hits:
        via = next((t for t in b.GetTracks() if t.GetClass() == "PCB_VIA" and t.GetNetname() == net
                    and abs(t.GetPosition().x / 1e6 - x) < 1e-3 and abs(t.GetPosition().y / 1e6 - y) < 1e-3), None)
        if via is None or via in gone:
            continue
        stub = [t for t in b.GetTracks() if t.GetClass() == "PCB_TRACK" and t.GetNetname() == net
                and (t.GetStart() == via.GetPosition() or t.GetEnd() == via.GetPosition())]
        if len(stub) != 1:
            continue
        if via.IsLocked() or stub[0].IsLocked() or copper_key(via) in preserve or copper_key(stub[0]) in preserve:
            continue
        far = stub[0].GetEnd() if stub[0].GetStart() == via.GetPosition() else stub[0].GetStart()
        pad = next((f"{fp.GetReference()}.{p.GetNumber()}" for fp in b.GetFootprints() for p in fp.Pads()
                    if p.GetNetname() == net and p.GetPosition() == far), None)
        if pad is None:
            continue
        todo.setdefault(net, set()).add(pad)
        gone += [via, stub[0]]
    for t in gone:
        b.Delete(t)
    if gone:
        pcbnew.SaveBoard(path, b)
    return todo


def _parse_args(argv=None):
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
    ap.add_argument('--native-thermal-checkback', action='store_true',
                    help='explicit pending thermal obligation; checked native fill/DRC before and after routing')
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
    ap.add_argument("--snapshot-interval-s", type=float, default=5.0, help="W12: copy the router's checkpoint SES to "
                    "OUTDIR/snapshots/NNNN.ses (+ .json sidecar, .png frame) every N seconds while it routes; 0 = off")
    a = ap.parse_args(argv)
    if a.max_time < 0 or a.threads < 0 or a.passes <= 0:
        ap.error('passes must be positive; time and threads must be nonnegative')
    if any(k.split('=', 1)[0] in ('router.autorouter.max_threads', 'router.optimizer.max_threads') for k in a.set):
        ap.error('use --threads for admitted autorouter and optimizer caps')
    if a.optimizer != 'always' and any(k.split('=', 1)[0] == 'router.optimizer.enabled' for k in a.set):
        ap.error('--optimizer conflicts with --set router.optimizer.enabled')
    if a.native_thermal_checkback and (not a.preflight or not a.only_nets or a.plane_nets or a.gnd_vias
            or a.route_planes or a.unlock_nets or a.neck_um):
        ap.error('native thermal checkback needs preflight, exact selected nets and no plane/unlock/repair operation')
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
    progress = route_progress.Progress(os.path.join(a.outdir, 'progress.jsonl'))
    progress.write('job start')
    try:
        backend_policy = backend_quality.bind(BIN, a.quality_backend_manifest)
    except (ValueError, OSError) as exc:
        lean.atomic_json(os.path.join(a.outdir, 'backend-policy.json'),
                         dict(mode='rejected', reason=str(exc), qualified=False))
        sys.exit('fastroute_job: required quality backend rejected: ' + str(exc))
    lean.atomic_json(os.path.join(a.outdir, 'backend-policy.json'), backend_policy)
    stem = os.path.splitext(a.board)[0]
    feat = route_features.load(a.board)
    if a.native_thermal_checkback and route_features.on(feat, 'routing_rules'):
        sys.exit('native thermal checkback prohibits internal routing/repair stages')
    thermal_source = _capture_thermal_source(a.board, a.outdir) if a.native_thermal_checkback else None
    print("FEATURES " + route_features.summary(feat), flush=True)
    run_record.start(a.outdir)
    run_record.append(a.outdir, 'job', 'configure', inputs=vars(a), evidence='input-manifest.json',
                      result={'features_on': sorted(k for k, v in feat.items() if isinstance(v, dict) and v.get('on'))},
                      why='the inputs and feature flags bound at the job start')
    # W16: off means off; the .get(..., True) defaults below apply only when the feature is on.
    fail_fast = (feat.get('fail_fast') or {'on': True}) if route_features.on(feat, 'fail_fast') else \
        {'optimizer_if_routed': False, 'stuck_exit': False, 'stall_passes': 0}
    if fail_fast.get('optimizer_if_routed', True) and a.optimizer == 'always':
        a.optimizer = 'if-routed'
        print('FAIL_FAST optimizer if-routed: the optimizer runs only when the router leaves 0 open connections', flush=True)
    lean.atomic_json(os.path.join(a.outdir, 'input-manifest.json'),
                     dict(board=os.path.abspath(a.board), board_sha256=lean.digest(a.board),
                          router_sha256=lean.digest(BIN), configuration=vars(a), features=feat,
                          sidecars={ext: lean.digest(os.path.splitext(a.board)[0]+ext)
                                    for ext in ('.kicad_pro', '.kicad_dru')
                                    if os.path.isfile(os.path.splitext(a.board)[0]+ext)},
                          qualified=False))
    base = os.path.join(a.outdir, "base.kicad_pcb")
    base_b_cfg = None
    if os.path.basename(stem) == 'BASE-PWR-B' or os.environ.get('ROUTE_BOARD') == 'BASE-PWR-B':
        import mandatory_preflight
        import base_b_route_rules
        base_b_dir = os.path.join(route_features.ROOT, 'hardware-design', 'boards', 'BASE-PWR-B')
        try:
            base_b_cfg, receipt = mandatory_preflight.inspect(
                a, base_b_dir, os.environ.get('ROUTE_BOARD', ''), pcbnew.LoadBoard, lean.digest, route_features.ROOT)
        except mandatory_preflight.SelectionError as exc:
            sys.exit('BASE-B mandatory preflight rejected: ' + str(exc))
        with open(os.path.join(base_b_dir, 'diff-pairs.json')) as pair_file:
            mandatory_pairs = json.load(pair_file)['pairs']
        pair_profile = receipt['preserved_pair_profile']
        policy_sources = list(receipt['policy_sources'])
        lean.atomic_json(os.path.join(a.outdir, 'mandatory-preflight.json'), receipt)
        if receipt['faults']:
            sys.exit('BASE-B immutable mandatory-rule faults block routing; see mandatory-preflight.json')
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
    # Duplicate item UUIDs (zones copied with their UUID by a generator script) stop the import replay guard
    # ("duplicate native immutable item identity"): the job copy gets deterministic new UUIDs (tools/board_uuids.py).
    uuid_fix = board_uuids.repair_file(base)
    lean.atomic_json(os.path.join(a.outdir, 'uuid-repair.json'), uuid_fix)
    if uuid_fix['replaced']:
        print(f"UUIDS {uuid_fix['replaced']} duplicate item UUIDs on the job copy replaced (deterministic; "
              f"no copper change): " + ", ".join(f"{r['kind']} {r['uuid']}" for r in uuid_fix['rows']), flush=True)
    tool = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gnd_pad_vias.py")
    # <board>/gate.json "plane_via_skip": {net: [REF.PAD, ...]}: pads that get no plane via (D-126: the U22 /CAN_GND pads
    # in the F.Cu island pour whose vias filled the CAN escape band). Merged with a --via-args --skip list.
    via_skip = {}
    if feat.get("_board_dir") and os.path.isfile(os.path.join(feat["_board_dir"], "gate.json")):
        via_skip = json.load(open(os.path.join(feat["_board_dir"], "gate.json"))).get("plane_via_skip", {})
    progress.write('plane-vias start')
    for net in planes:
        tmp = os.path.join(a.outdir, "planevias.kicad_pcb")
        via_args = shlex.split(a.via_args)
        pads = [p for p in via_skip.get(net, []) if isinstance(p, str)]
        if pads:
            if "--skip" in via_args:
                i = via_args.index("--skip")
                pads = via_args[i + 1].split(",") + pads
                del via_args[i:i + 2]
            via_args += ["--skip", ",".join(pads)]
            print(f"PLANE_VIA_SKIP {net}: {' '.join(pads)} (gate.json plane_via_skip)", flush=True)
        r = lean.run_stage([sys.executable, tool, base, tmp, "--net", net] + via_args,
                           stage=f"initial-plane-vias:{net}", event_file=phases, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        with open(os.path.join(a.outdir, "planevias.log"), "a") as f:
            f.write("".join(l + "\n" for l in r.stdout.splitlines() if "vias added" in l))
        if os.path.isfile(tmp):
            os.replace(tmp, base)
    progress.write('plane-vias end')

    def routed_nets_file():
        f = os.path.join(a.outdir, "routed-nets.txt")
        open(f, "w").write("\n".join(sorted(nets)) + "\n")
        return f

    b = pcbnew.LoadBoard(base)
    native_thermal_capability = None
    if a.preflight:
        progress.write('preflight start')
        check = os.path.join(a.outdir, 'preflight.json')
        if a.native_thermal_checkback:
            fill = os.path.join(a.outdir, 'native-thermal-initial-fill.json')
            _checked_thermal_fill(b, base, fill, phases, 'native-thermal-initial-fill')
            d, drc_receipt = _thermal_drc(base, a.outdir, phases, 'native-thermal-initial')
            native_thermal_capability = route_native_thermals.admit(thermal_source, base,
                enabled=True,
                selected_nets=[name for name in a.only_nets.split(',') if name],
                initial_fill_receipt=fill, initial_drc_receipt=drc_receipt)
            lean.atomic_json(os.path.join(a.outdir, 'native-thermal-initial.json'), native_thermal_capability)
            thermal = dict(accepted=False, reason='explicit native checkback never performs thermal repairs')
        else:
            p = lean.run_stage([KICAD_CLI, 'pcb', 'drc', '--refill-zones', '--severity-all', '--format', 'json',
                                '--units', 'mm', '-o', check, base], stage='native-preflight',
                               event_file=os.path.join(a.outdir, 'stages.jsonl'),
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            if p.returncode or not os.path.isfile(check):
                sys.exit('preflight failed to produce independent native evidence')
            d = lean.validate_drc(json.load(open(check)))
            d, thermal = thermal_repair.repair(base, a.board, d, planes, shlex.split(a.via_args),
                                              KICAD_CLI, os.path.join(a.outdir, 'stages.jsonl'), 'preflight-thermal')
        progress.write('preflight end')
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
        p = lean.run_stage([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "route_grid.py"),
                            "escape", base, "--layers", a.layers, "--skip", "", "--nets", routed_nets_file(),
                            "--out", os.path.join(a.outdir, "pin-escape.json")], stage="pin-escape", event_file=phases, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        print(([l for l in p.stdout.splitlines() if l.startswith("ESCAPE")] or ["ESCAPE failed"])[-1], flush=True)
    mandatory_masks = {}
    if base_b_cfg:
        layers = [l for l in a.layers.split(',') if l]
        for n in nets:
            allow = [l for l in layers if l != 'In1.Cu' and
                     (l != 'In2.Cu' or base_b_route_rules.eligible(n, *base_b_cfg))]
            if not allow:
                sys.exit(f'BASE-B no legal routing layer for {n}')
            if allow != layers:
                mandatory_masks[n] = allow
    if unlock - nets:
        sys.exit('fastroute_job: skipped nets cannot have unlocked copper')
    if any(k.split('=', 1)[0] == 'router.autorouter.ignore_net_classes' for k in a.set):
        sys.exit('fastroute_job: ignored classes are derived from selected nets')
    # Routing rules (D-125, feature routing_rules): critical nets first in stages, each stage's copper locked for the
    # next; a high via cost; keepouts over the missing reference plane for the signal nets. Without the feature the
    # job is one pass over all nets, as before.
    # W10 (2026-10-10): the feature runs on BASE-PWR-B too; its mandatory layer masks apply in every pass (route_pass).
    rules = route_features.on(feat, "routing_rules")
    passes = [("all", set(nets), False, None)]
    rr_info, rr_plan, rr_spec, rr_cls = None, [], {}, {}
    escape_info, hot_info = {}, {}
    if rules:
        rr_cfg = feat["routing_rules"]
        rr_info = routing_rules.board_info(feat["_board_dir"], rr_cfg)
        rr_spec = rr_info["spec"]
        try:
            pro = json.load(open(stem + ".kicad_pro"))["net_settings"]["classes"]
        except (OSError, KeyError, ValueError):
            pro = []
        dflt = next((c.get("track_width", 0) for c in pro if c["name"] == "Default"), 0)
        wide = {c["name"] for c in pro if c.get("track_width", 0) > dflt}
        rr_cls = {str(k): str(v.GetNetClassName()) for k, v in b.GetNetsByName().items() if str(k)}
        job_layers = [l for l in a.layers.split(",") if l]
        dflt_cls = next((c for c in pro if c["name"] == "Default"), {})
        d_w, d_c, d_v = (float(dflt_cls.get(k, v)) for k, v in (("track_width", 0.2), ("clearance", 0.2), ("via_diameter", 0.6)))
        bb = b.GetBoardEdgesBoundingBox()
        board_box = (bb.GetLeft() / 1e6, bb.GetTop() / 1e6, bb.GetRight() / 1e6, bb.GetBottom() / 1e6)
        # Fan-out (escape) stage, W10: the SMD pads of the fine-pitch footprints (IPC-7351B: pitch <= fine_pitch_mm)
        # are fanned out by Fastroute's own SMD fanout stage before any wide copper, bounded by a keepout (wires and
        # vias) outside a belt round each such courtyard: belt = one clearance + a via + a track with its clearance
        # (the Default class). Fastroute cannot be told "only escapes": every other job net is an ignored class, and
        # the far connections of the escape nets fail inside the belt (expected; the nets are routed again in their
        # own stage from the locked escapes).
        pads_by_ref, pad_rows, crt = {}, [], {}
        lid = {L: b.GetLayerID(L) for L in job_layers}
        for fp in b.GetFootprints():
            ref = fp.GetReference()
            for p in fp.Pads():
                c = p.GetPosition()
                pads_by_ref.setdefault(ref, []).append((c.x / 1e6, c.y / 1e6))
                pad_rows.append((ref, p.GetNetname(), p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD
                                 and any(p.IsOnLayer(lid[L]) for L in job_layers)))
            cy = fp.GetCourtyard(pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd)
            box = cy.BBox() if cy.OutlineCount() else fp.GetBoundingBox()
            crt[ref] = (box.GetLeft() / 1e6, box.GetTop() / 1e6, box.GetRight() / 1e6, box.GetBottom() / 1e6)
        fine = routing_rules.fine_pitch_refs(pads_by_ref, float(rr_cfg.get("fine_pitch_mm", routing_rules.FINE_PITCH_MM)))
        before_escape = {n for n in nets if routing_rules.stage_of(n, rr_info, rr_cls, wide) in ("pairs_clocks", "fast")}
        esc_nets = routing_rules.escape_nets(pad_rows, fine, nets, exclude=before_escape | plane_names)
        belt = routing_rules.belt_margin(d_w, d_c, d_v)
        belts = [routing_rules.grow(crt[r], belt) for r in sorted(fine)]
        escape_extra = dict(name="iot_belt", flags=["--router.fanout.enabled=true"],
                            max_time=int(rr_cfg.get("escape_max_time_s", 120)),
                            keepouts={L: routing_rules.outside_rects(board_box, belts) for L in job_layers})
        escape_info = dict(fine_pitch_mm=float(rr_cfg.get("fine_pitch_mm", routing_rules.FINE_PITCH_MM)),
                           refs={r: dict(pitch_mm=fine[r], courtyard=crt[r], belt=routing_rules.grow(crt[r], belt)) for r in sorted(fine)},
                           belt_mm=belt, pads=sum(1 for r, n, smd in pad_rows if smd and r in fine and n in esc_nets),
                           nets=esc_nets)
        # Hot loops, W10: each switch node (current-paths.json "switch_node", config switch_nodes) of the wide stage
        # gets a corridor keepout round its pads, one layer (its SMD pads' layer, a use_layer mask), via cost x
        # hot_loop_via_factor, and the bound max_mm = hot_loop_factor x the straight pad distance (checked after).
        hot_extra, hot_info = {}, {}
        for net_, loop_pads in sorted(rr_info["switch"].items()):
            if net_ not in nets:
                continue
            pad_xy, pad_layers = {}, set()
            for fp in b.GetFootprints():
                for p in fp.Pads():
                    if p.GetNetname() == net_:
                        pad_xy[f"{fp.GetReference()}.{p.GetNumber()}"] = (p.GetPosition().x / 1e6, p.GetPosition().y / 1e6)
                        pad_layers.add("*" if p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD else p.GetLayerName())
            h = routing_rules.hot_loop(pad_xy, loop_pads, float(rr_cfg.get("hot_loop_factor", 1.5)), d_w + d_c)
            if not h:
                continue
            one = [L for L in pad_layers if L in job_layers] if "*" not in pad_layers and len(pad_layers) == 1 else []
            hot_info[net_] = dict(h, layer=one[0] if one else None, loop_pads=loop_pads)
            hot_extra[net_] = dict(name="iot_hot_loop", keepouts={L: routing_rules.outside_rects(board_box, [h["box"]]) for L in job_layers},
                                   masks={net_: one} if one else {},
                                   via_costs=int(rr_cfg.get("via_costs", 300)) * int(rr_cfg.get("hot_loop_via_factor", 10)))
        rr_plan = routing_rules.stage_plan(sorted(nets), rr_info, rr_cls, wide, planes=plane_names,
                                           escape=esc_nets, hot=set(hot_info))
        if not rr_cfg.get("keepouts", True) or not rr_spec.get("adjacent"):
            rr_plan = [(n, s, False) for n, s, _ in rr_plan]
        ks = rr_cfg.get("keepout_stages", list(routing_rules.STAGES))
        rr_plan = [(n, s, k and (n in ks or n.split("_")[0] in ks)) for n, s, k in rr_plan]
        if len(rr_plan) > 1 or (rr_plan and rr_plan[0][2]):
            passes = []
            for n, s_, k in rr_plan:
                extra = None
                if n == "escape":
                    extra = escape_extra
                elif n.startswith("wide_hot"):
                    # one corridor and mask per net: a hot stage with several nets is split per net
                    for net_ in s_:
                        passes.append((f"{n}:{net_}", {net_}, k, hot_extra[net_]))
                    continue
                passes.append((n, set(s_), k, extra))
            passes.append(("final", set(nets), False, None))
        print("STAGES " + " ".join(f"{n}={len(s)}{'K' if k else ''}" for n, s, k in rr_plan) +
              " final=rest (K = reference-plane keepouts)", flush=True)
        if fine:
            print(f"ESCAPE fine-pitch {len(fine)} refs (" + ", ".join(f"{r} {fine[r]:g}mm" for r in sorted(fine)) +
                  f") pads {escape_info['pads']} nets {len(esc_nets)} belt {belt:g} mm (IPC-7351B fine pitch <= "
                  f"{escape_info['fine_pitch_mm']:g} mm)", flush=True)
        else:
            print("ESCAPE no fine-pitch footprint: no escape stage", flush=True)
        for net_, h in sorted(hot_info.items()):
            print(f"HOT_LOOP {net_} straight {h['straight_mm']:g} mm max {h['max_mm']:g} mm layer {h['layer'] or 'any'}", flush=True)
        # W5 run record: one action per routing-rules decision with its why
        for n, s_, k in rr_plan:
            run_record.append(a.outdir, 'plan', 'stage ' + n, inputs={'nets': len(s_)}, evidence='STAGES line',
                              result={'keepout': bool(k), 'locked_after': True},
                              why=('reference-plane keepouts on the adjacent layer (rule 3: never cross a split)' if k else
                                   'no keepout: power/ground or exempt nets') + '; its copper is locked for the later stages (rule 1)')
        if fine:
            run_record.append(a.outdir, 'plan', 'escape belt', inputs={'refs': sorted(fine), 'nets': len(esc_nets)}, evidence='ESCAPE line',
                              result={'belt_mm': belt}, why=f"fine pitch <= {escape_info['fine_pitch_mm']:g} mm (IPC-7351B): fan out "
                              "inside a belt of one clearance + a via + a track before any wide copper")
        for net_, h in sorted(hot_info.items()):
            run_record.append(a.outdir, 'plan', 'hot loop', inputs={'net': net_, 'pads': h['loop_pads']}, evidence='HOT_LOOP line',
                              result={'max_mm': h['max_mm'], 'layer': h['layer']},
                              why='switch node: corridor keepout, one layer, raised via cost (minimum loop area)')
    min_um = int(round(b.GetDesignSettings().m_TrackMinWidth / 1000))
    edge_um = int(round(b.GetDesignSettings().m_CopperEdgeClearance / 1000))
    sources = [os.environ.get('ROUTE_FEATURES_FILE') or route_features.DEFAULTS]
    if feat.get('_board_dir'):
        sources += [os.path.join(feat['_board_dir'], 'gate.json'),
                    os.path.join(feat['_board_dir'], feat['via_halo'].get('fast_nets_file', 'rp001-fast-nets.json'))]
    if rules and feat.get('_board_dir'):
        sources += [os.path.join(feat['_board_dir'], f) for f in
                    ('reference-planes.json', 'current-paths.json', 'diff-pairs.json')]
    if base_b_cfg:
        sources += policy_sources
    router_env = resources.router_env(a.threads)
    import hashlib
    t0 = lean.now()
    deadline = lean.deadline_after(a.max_time) if a.max_time else lean.inherited_deadline()
    phases = os.path.join(a.outdir, 'stages.jsonl')

    def vias():
        return sum(1 for t in b.GetTracks() if t.GetClass() == "PCB_VIA")

    def key(t):
        e = t.GetEnd() if t.GetClass() == "PCB_TRACK" else t.GetStart()
        return (t.GetClass(), t.GetNetname(), t.GetLayer(), t.GetStart().x, t.GetStart().y, e.x, e.y)

    def stage_keepouts(stage_nets):
        """Rule 3: the refilled planes of the board as it is now -> wire keepouts on each adjacent signal layer."""
        # Pads and vias of the other nets keep a disc open (pin access, their antipad in the plane): radius + margin,
        # margin = disc_margin_mm (above the 0.25 mm plane clearance) and never above the spec via_allow_mm. A
        # reference-net pad or via makes no void in its own plane, so it opens nothing.
        allow = min(float(rr_spec.get("via_allow_mm", 0.6)), float(feat["routing_rules"].get("disc_margin_mm", 0.35)))
        refs = routing_rules.ref_nets(rr_spec)
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
        ps = pcbnew.SHAPE_POLY_SET()
        b.GetBoardPolygonOutlines(ps, True)

        def rings(poly, k):
            rr_ = [poly.Outline(k)] + [poly.Hole(k, j) for j in range(poly.HoleCount(k))]
            return [[(c.CPoint(i).x / 1e6, c.CPoint(i).y / 1e6) for i in range(c.PointCount())] for c in rr_]
        outline = [r for k in range(ps.OutlineCount()) for r in rings(ps, k)]
        fills = {}
        for z in b.Zones():
            if z.GetIsRuleArea():
                continue
            for lid in z.GetLayerSet().Seq():
                f = z.GetFilledPolysList(lid)
                fills.setdefault(b.GetLayerName(lid), []).extend(
                    (z.GetNetname(), rings(f, k)) for k in range(f.OutlineCount()))
        job_layers = [l for l in a.layers.split(",") if l]
        discs = {L: [] for L in job_layers}
        lid = {L: b.GetLayerID(L) for L in job_layers}
        for p in b.GetPads():
            if p.GetNetname() in refs:
                continue
            c, sz = p.GetPosition(), p.GetBoundingBox()
            r = max(sz.GetWidth(), sz.GetHeight()) / 2e6 + allow
            for L in job_layers:
                if p.IsOnLayer(lid[L]):
                    discs[L].append((c.x / 1e6, c.y / 1e6, r))
        for t in b.GetTracks():
            if t.GetClass() == "PCB_VIA" and t.GetNetname() not in refs:
                c = t.GetPosition()
                for L in job_layers:
                    discs[L].append((c.x / 1e6, c.y / 1e6, t.GetWidth(pcbnew.F_Cu) / 2e6 + allow))
        fast = any(routing_rules._match(n, rr_info["fast"]) for n in stage_nets)
        return routing_rules.layer_keepouts(rr_spec, job_layers, outline, fills, discs,
                                            float(feat["routing_rules"].get("keepout_grid_mm", 0.1)), fast)

    solver_launches = []
    native_obligations = []   # admitted pending obligations; discharged by the final native DRC below

    def route_pass(tag, stage_nets, keep, rip=frozenset(), extra=None):
        """One router run over stage_nets (the other nets are ignored classes; existing copper stays locked).
        rip: nets whose copper of this job (stage copper) is unlocked too (the repair pass). extra (W10): per-stage
        keepouts {layer: rects} of both kinds with their name, layer masks, router flags, via_costs, max_time."""
        extra = extra or {}
        sfx = "" if tag in ("all", "final") else "-" + tag.replace(":", "_").replace("/", "")
        free = (unlock & stage_nets) | (set(rip) & stage_nets)
        for t in b.GetTracks():
            u = t.m_Uuid.AsString()
            # --unlock-nets: the copper of these nets goes to the router as normal wiring (a start it may rip up and
            # route again); a locked item stays locked. Copper of an earlier stage is locked unless its net is ripped.
            if u not in was:
                t.SetLocked(t.GetNetname() not in rip)
            else:
                t.SetLocked(was[u] or t.GetNetname() not in free)
        dsn, ses, rep = (os.path.join(a.outdir, n) for n in (f"board{sfx}.dsn", f"board{sfx}.ses", f"report{sfx}.json"))
        if not pcbnew.ExportSpecctraDSN(b, dsn):
            sys.exit("fastroute_job: DSN export failed")
        with open(dsn) as f:
            # Keep electrical membership: exclusions are applied as dedicated router
            # classes after rule and padstack transformations below.
            text = freeroute.restrict_dsn(f.read(), set(a.layers.split(",")), None)
        net_class = route_features.dsn_classes(text)
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
        else:
            pass_masks = dict(mandatory_masks)
            for n_, ls in (extra.get("masks") or {}).items():
                keep_ls = [l for l in ls if l in pass_masks.get(n_, ls)]
                if keep_ls:
                    pass_masks[n_] = keep_ls
            if pass_masks:
                text = route_features.apply_layer_masks(text, pass_masks)
                route_features.verify_layer_masks(text, pass_masks)
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
        n_keep = 0
        if keep:
            ko = stage_keepouts(stage_nets)
            n_keep = sum(len(v) for v in ko.values())
            text = routing_rules.add_wire_keepouts(text, ko)
        if extra.get("keepouts"):
            n_keep += sum(len(v) for v in extra["keepouts"].values())
            text = routing_rules.add_keepouts(text, extra["keepouts"], ("wire_keepout", "via_keepout"), extra.get("name", "iot_stage"))
        text, ignored_classes = dsn_skip.exclude(text, stage_nets)
        model_dsn = os.path.join(a.outdir, f'router-model{sfx}.dsn')
        native_classes = {str(n): str(v.GetNetClassName()) for n, v in b.GetNetsByName().items()}
        native_classes.setdefault('', 'Default')
        obstacle_set = set()
        for fp in b.GetFootprints():
            for pad in fp.Pads():
                kind = ('SMD' if pad.GetAttribute() == pcbnew.PAD_ATTRIB_SMD else
                        'NPTH, mechanical' if pad.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH else 'Through-hole')
                obstacle_set.add((str(pad.GetNetname()), 'Pad', kind))
        for track in b.GetTracks():
            obstacle_set.add((str(track.GetNetname()), 'Via' if track.GetClass() == 'PCB_VIA' else 'Track', ''))
        for zone in b.Zones():
            obstacle_set.add((str(zone.GetNetname()), 'Zone', ''))
        obstacles = [dict(NetName=n, Type=t, Pad_Type=p) for n, t, p in sorted(obstacle_set)]
        gate_path = os.path.join(feat['_board_dir'], 'gate.json') if feat.get('_board_dir') else None
        coverage_path = os.path.join(a.outdir, f'rule-coverage{sfx}.json')
        floor_path = os.path.join(a.outdir, f'clearance-floor{sfx}.json')
        before_floor = os.path.join(a.outdir, f'clearance-input{sfx}.dsn')
        try:
            text, floor = _strengthen_clearance_model(text, stem + '.kicad_pro', before_floor,
                model_dsn, floor_path, active_nets=stage_nets, net_classes=native_classes,
                obstacles=obstacles, layers=a.layers.split(','))
        except (ValueError, OSError, UnicodeError) as error:
            floor = json.load(open(floor_path)) if os.path.isfile(floor_path) else {}
            coverage = dict(schema=route_rule_coverage.SCHEMA, status='blocked', solver_launch_allowed=False,
                cause='project clearance strengthening: ' + str(error), qualified=False,
                clearance_strengthening=dict(path=floor_path, sha256=lean.digest(floor_path) if floor else None),
                inputs=floor.get('inputs', {}))
            lean.atomic_json(coverage_path, coverage)
            lean.atomic_json(os.path.join(a.outdir, 'outcome.json'), dict(status='blocked',
                cause='router rule coverage: ' + coverage['cause'], coverage=coverage_path,
                coverage_sha256=lean.digest(coverage_path), blocked_stage=tag,
                stage_solver_launched=False, solver_launched=bool(solver_launches), qualified=False))
            progress.write('rule coverage blocked: ' + coverage['cause'])
            print('STUCK router rule coverage: ' + coverage['cause'] + '; see ' + coverage_path, flush=True)
            sys.exit(4)
        with open(dsn, "w") as f:
            f.write(text)
        # Each invocation retains its exact model after every transformation.
        with open(model_dsn, 'x') as f:
            f.write(text)
        if lean.digest(model_dsn) != floor['after_sha256']:
            raise ValueError('strengthened final DSN differs from its recorded bytes')
        if ignored_classes:
            help_result = lean.run_stage([BIN, '--help'], stage='net-class-capability', event_file=phases,
                                         deadline=lean.deadline_after(10), stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, text=True)
            if help_result.returncode or 'router.autorouter.ignore_net_classes' not in help_result.stdout:
                sys.exit('fastroute_job: backend does not support safe net-class exclusion')
        cmd = [BIN, "-de", model_dsn, "-do", ses, "-mp", str(a.passes), f"--router.min_trace_width_um={min_um}",
               f"--router.copper_to_edge_clearance_um={edge_um}",
               f"--report={rep}"] + [f"--{kv}" for kv in a.set]
        if rules and not any(k.split('=', 1)[0] == 'router.scoring.via_costs' for k in a.set):
            # Rule 2: a layer change costs much more than Freerouting's default (50), so the router changes layer
            # only where the detour is long. A caller's own --set router.scoring.via_costs wins.
            cmd.append(f"--router.scoring.via_costs={int(extra.get('via_costs') or feat['routing_rules'].get('via_costs', 300))}")
        cmd += list(extra.get("flags") or [])
        if ignored_classes:
            cmd.append('--router.autorouter.ignore_net_classes=' + ','.join(ignored_classes))
        if a.neck_um:
            cmd.append(f"--router.neck_width_um={a.neck_um}")
        if backend_policy['mode'] == 'quality-first':
            cmd.append('--quality-first')
        # A pair that has copper on the board already (kept block copper) is not given to the pair router.
        has_copper = {t.GetNetname() for t in b.GetTracks() if t.GetClass() != "PCB_VIA"}
        pairs_file = write_pairs(a.pairs_json, stem + ".kicad_dru", stage_nets - has_copper,
                                 os.path.join(a.outdir, f"pairs{sfx}.txt"))
        if pairs_file:
            cmd.append(f"--pairs={pairs_file}")
        if a.max_time:
            left = lean.remaining(deadline) if len(passes) > 1 else a.max_time
            if extra.get("max_time"):
                left = min(left, extra["max_time"])
            cmd.append(f"--max-time={max(1, int(left))}")
        # Bound both phases with the same remaining job budget, and cap both pools.
        if a.optimizer != 'always':
            cmd += lean.optimizer_options(a.optimizer)
        if a.threads:
            cmd += [f'--router.autorouter.max_threads={a.threads}', f'--router.optimizer.max_threads={a.threads}']
        # Admission binds the complete argv, including caller/feature overrides.
        # This exact command is retained below and passed to the solver.
        try:
            coverage = route_rule_coverage.check_files(a.board, base, model_dsn, active_nets=stage_nets,
                net_classes=native_classes, obstacles=obstacles, layers=a.layers.split(','), gate=gate_path,
                backend_command=cmd, backend_policy=backend_policy,
                native_thermal_capability=native_thermal_capability)
        except (ValueError, OSError) as error:
            coverage = dict(schema=route_rule_coverage.SCHEMA, status='blocked', solver_launch_allowed=False,
                cause=str(error), qualified=False)
        coverage['clearance_strengthening'] = dict(path=floor_path, sha256=lean.digest(floor_path))
        bound = coverage.setdefault('inputs', {})
        for name, digest in floor['inputs'].items():
            actual = lean.digest(name) if os.path.isfile(name) else None
            if actual != digest or (name in bound and bound[name] != digest):
                coverage.update(status='blocked', solver_launch_allowed=False,
                    cause='clearance strengthening input changed before admission: ' + name)
            bound[name] = digest
        bound[os.path.abspath(floor_path)] = lean.digest(floor_path)
        lean.atomic_json(coverage_path, coverage)
        if not coverage['solver_launch_allowed']:
            progress.write('rule coverage blocked: ' + coverage['cause'])
            lean.atomic_json(os.path.join(a.outdir, 'outcome.json'), dict(status='blocked',
                cause='router rule coverage: ' + coverage['cause'], coverage=coverage_path,
                coverage_sha256=lean.digest(coverage_path), blocked_stage=tag,
                stage_solver_launched=False, solver_launched=bool(solver_launches), qualified=False))
            print('STUCK router rule coverage: ' + coverage['cause'] + '; see ' + coverage_path, flush=True)
            sys.exit(4)
        if coverage.get('status') == 'pending_native':
            native_obligations.extend(o for o in coverage.get('native_postconditions', []) if o not in native_obligations)
            print('ADMITTED router model with pending native obligations (' + ', '.join(
                o['constraint'] + ' ' + o.get('enforcement', 'native-checkback') for o in coverage.get('native_postconditions', []))
                + '); evidence=' + coverage_path, flush=True)
        else:
            print('PASS router rule coverage; evidence=' + coverage_path, flush=True)
        effective = dict(configuration=vars(a), features=feat, command=cmd, dsn_sha256=lean.digest(model_dsn),
                         rule_coverage=dict(path=coverage_path, sha256=lean.digest(coverage_path)),
                         backend_policy=backend_policy,
                         feature_sources={p: lean.digest(p) for p in sources if os.path.isfile(p)},
                         environment={k: os.environ.get(k) for k in ('ROUTE_FEATURES','ROUTE_BOARD','ROUTE_FEATURES_FILE')},
                         backend_resources=dict(global_rayon_threads=int(router_env['RAYON_NUM_THREADS']),
                              autorouter_workers=a.threads, optimizer_workers=a.threads,
                              live_reservation=router_env.get('IOT_RESOURCE_TICKET'),
                              scope='cooperating pool caps; coordinator and independently built pools are additional threads'),
                         learned_halo=route_features.learned_halo(a.board, feat['_board_dir'])[1],
                         mandatory_layer_masks=mandatory_masks, ignored_classes=ignored_classes, qualified=False)
        if rules:
            effective.update(stage=tag, stage_nets=sorted(stage_nets), keepouts=n_keep)
        effective['effective_sha256'] = hashlib.sha256(json.dumps(effective, sort_keys=True).encode()).hexdigest()
        lean.atomic_json(os.path.join(a.outdir, f'effective-configuration{sfx}.json'), effective)
        s0 = lean.now()
        stall_n = int(fail_fast.get('stall_passes', 0) or 0)
        stall_stop, stall_result, owner = threading.Event(), {}, {}
        watcher = threading.Thread(target=_router_watch, args=(os.path.join(a.outdir, f"run{sfx}.log"), stall_n, owner,
                                                                stall_stop, stall_result, progress, 'route' + sfx), daemon=True)
        progress.write('route' + sfx + ' start')
        # W12 snapshots: the router's checkpoint SES every --snapshot-interval-s seconds (route_snapshots.Watcher)
        snap = route_snapshots.Watcher(ses, a.outdir, os.path.join(a.outdir, f"run{sfx}.log"), a.snapshot_interval_s,
                                       stage='route' + sfx, t0=run_record.clock(a.outdir), dsn=model_dsn)
        def solver_started(proc):
            owner['proc'] = proc
            solver_launches.append(tag)
        with _router_observers(watcher, stall_stop, stall_result, snap,
                os.path.join(a.outdir, f'stall{sfx}.json'), stall_n, tag):
            with open(os.path.join(a.outdir, f"run{sfx}.log"), "w") as lf:
                rc = lean.run_stage(cmd, stage=('router-screen' if a.optimizer != 'always' else 'router') + sfx,
                                    event_file=phases, deadline=deadline, env=router_env,
                                    on_start=solver_started,
                                    stdout=lf, stderr=subprocess.STDOUT).returncode
            stall_stop.set()
            watcher.join(5)
            progress.write('route' + sfx + ' end')
            if rc == 0 and a.optimizer == 'if-routed' and os.path.isfile(rep) and os.path.isfile(ses):
                screen = json.load(open(rep))
                if dsn_skip.routable_open(screen) == 0:
                    checkpoint = os.path.join(a.outdir, f'screen{sfx}.ses')
                    shutil.copy(ses, checkpoint)
                    shutil.copy(rep, os.path.join(a.outdir, f'screen-report{sfx}.json'))
                    optimize = [x for x in cmd if not x.startswith('--router.optimizer.enabled=')
                                and not x.startswith('--max-time=')]
                    optimize += ['--router.optimizer.enabled=true', f'--initial-session={checkpoint}']
                    left = lean.remaining(deadline)
                    if left is not None:
                        optimize.append(f'--max-time={max(1, int(left))}')
                    with open(os.path.join(a.outdir, f'optimize{sfx}.log'), 'w') as lf:
                        rc = lean.run_stage(optimize, stage='router-optimize' + sfx, event_file=phases, deadline=deadline,
                                            env=router_env, stdout=lf, stderr=subprocess.STDOUT).returncode
                    # W16 (AC-24V 2026-10-11): the optimizer, started from the checkpoint, moved mains tracks into the 3 mm
                    # clearance at J1 (2.68 mm, 2.98 mm) where the screen result had none. Keep the screen result when the
                    # optimizer adds fixable violations or opens: polish never trades a rule for track length.
                    def _bad(r):
                        st = r.get('stats', {})
                        return (st.get('violations', 0) - st.get('violations_unfixable', 0), dsn_skip.routable_open(r))
                    if rc == 0 and os.path.isfile(rep) and any(x > y for x, y in zip(_bad(json.load(open(rep))), _bad(screen))):
                        print(f'OPTIMIZER rejected: violations/opens {_bad(json.load(open(rep)))} > screen {_bad(screen)}; '
                              'the screen result is kept', flush=True)
                        shutil.copy(checkpoint, ses)
                        shutil.copy(os.path.join(a.outdir, f'screen-report{sfx}.json'), rep)
                else:
                    print('OPTIMIZER deferred: screening result still has open connections', flush=True)
        if rc != 0 or not os.path.isfile(ses) or not os.path.isfile(rep):
            sys.exit(f"fastroute_job: fastroute failed (rc {rc}), see {a.outdir}/run{sfx}.log")
        report = json.load(open(rep))
        copper_before = {key(t) for t in b.GetTracks()}

        def skipped_copper(original_locks=False):
            records = []
            for t in b.GetTracks():
                if t.GetNetname() in stage_nets:
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
            replay_path = os.path.join(a.outdir, f'import-copper-snapshot{sfx}.kicad_pcb')
            preserved = {t.m_Uuid.AsString() for t in b.GetTracks() if t.IsLocked()}
            replay_before = import_replay_guard.snapshot(b, replay_path)
        except ValueError as exc:
            sys.exit('fastroute_job: SES pose integrity precondition failed; result is not verified: ' + str(exc))
        progress.write('import' + sfx + ' start')
        with _native_phase('ses-import' + sfx, phases):
            if not pcbnew.ImportSpecctraSES(b, ses):
                sys.exit("fastroute_job: SES import failed")
        progress.write('import' + sfx + ' end', vias=sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_VIA'))
        dup = []
        if True:
            # Fastroute 0.1.7 sometimes writes one segment twice (two wires of a net share it; seen with and without
            # the routing_rules feature: INPUT-4D2A and CELLULAR smoke runs, a FIELD-24V-BUS --unlock-nets
            # continuation of 2026-10-10 with the feature off). The second of two new tracks with the same net,
            # layer, width and end points is identical copper: it is deleted before the replay guard, and listed.
            seen = set()
            for t in list(b.GetTracks()):
                if t.GetClass() != "PCB_TRACK" or t.m_Uuid.AsString() in was or t.IsLocked():
                    continue
                g = key(t)[:3] + (t.GetWidth(),) + tuple(sorted(((t.GetStart().x, t.GetStart().y), (t.GetEnd().x, t.GetEnd().y))))
                if g in seen:
                    dup.append(dict(net=t.GetNetname(), layer=t.GetLayerName(), width_nm=t.GetWidth(), ends_nm=list(g[4:]),
                                    geometry=('segment', t.GetNetname(), t.GetLayerName(), t.GetWidth(), g[4])))
                    b.Delete(t)
                else:
                    seen.add(g)
            if dup:
                print(f"fastroute_job: {len(dup)} duplicate new segments removed (identical copper), stage {tag}", flush=True)
        # W10 (2026-10-10): a new segment shorter than the DSN unit (1 um) is no copper. Fastroute writes its result at
        # 0.1 um and joins a point it rounded to a point it did not with such a stub (BASE-PWR repair pass: 45 stubs of
        # 0.3-0.5 um); KiCad's DSN export writes whole um, so the next pass offers that stub as a one-point wire, the
        # router returns it as copper, and the replay guard cannot match the two. Deleted here, listed in the audit.
        sub_um = []
        for t in list(b.GetTracks()):
            if t.GetClass() != "PCB_TRACK" or t.m_Uuid.AsString() in was or t.IsLocked():
                continue
            s_, e_ = t.GetStart(), t.GetEnd()
            if abs(s_.x - e_.x) < 1000 and abs(s_.y - e_.y) < 1000:
                sub_um.append(dict(net=t.GetNetname(), layer=t.GetLayerName(), width_nm=t.GetWidth(),
                                   ends_nm=[[s_.x, s_.y], [e_.x, e_.y]]))
                b.Delete(t)
        if sub_um:
            print(f"fastroute_job: {len(sub_um)} new segments shorter than 1 um removed (no copper), stage {tag}", flush=True)
        try:
            restored = import_pose_guard.restore(b, poses_before, pose_grid)
            dedup = {}
            for row in dup:
                dedup[row['geometry']] = dedup.get(row['geometry'], 0) + 1
            replays = import_replay_guard.restore(b, replay_before, preserved, dsn, ses, replay_path,
                                                  unlocked=set(replay_before) - preserved, deduplicated=dedup)
        except ValueError as exc:
            sys.exit('fastroute_job: SES pose integrity failed; result is not verified: ' + str(exc))
        with open(os.path.join(a.outdir, f'import-pose-audit{sfx}.json'), 'w') as audit:
            json.dump(dict(grid_nm=pose_grid, restored=restored, exact_poses_and_pads=True,
                           guard_sha256=lean.digest(import_pose_guard.__file__),
                           dsn_sha256=lean.digest(dsn), ses_sha256=lean.digest(ses),
                           before_snapshot_sha256=hashlib.sha256(json.dumps(poses_before, sort_keys=True).encode()).hexdigest(),
                           qualified=False, independent_native_gate_required=True), audit, indent=2)
        with open(os.path.join(a.outdir, f'import-replay-audit{sfx}.json'), 'w') as audit:
            json.dump(dict(removed=replays, preserved_uuids=sorted(preserved),
                           duplicate_new_segments_removed=[{k: v for k, v in r.items() if k != 'geometry'} for r in dup],
                           sub_um_new_segments_removed=sub_um,
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
                if (t.GetClass() == "PCB_VIA" and t.GetNetname() in stage_nets and key(t) not in copper_before
                        and t.GetWidth(pcbnew.F_Cu) > pcbnew.FromMM(a.signal_via) - 1000):
                    d, dr = sizes.get(str(t.GetNetClassName()), sizes["Default"])
                    t.SetWidth(pcbnew.FromMM(d))
                    t.SetDrill(pcbnew.FromMM(dr))
                    n_big += 1
            print(f"fastroute_job: {n_big} signal vias routed with the {a.signal_via:g} mm padstack, set to the class size",
                  flush=True)
        if skipped_copper() != skipped_before:
            sys.exit('fastroute_job: via normalization changed excluded-net copper; result is not verified')
        imported = vias()
        if a.only_nets or stage_nets != nets:
            # Fastroute can add copper to a net that is not in --only-nets (RELAY-4 2026-10-04: a second route on /COIL1
            # and /LINK_SCL, both already connected). Remove new copper on the other nets: they keep their old copper.
            extra = [t for t in b.GetTracks() if t.GetNetname() not in stage_nets and key(t) not in copper_before]
            names = sorted({t.GetNetname() for t in extra})
            for t in extra:
                b.Delete(t)
            if extra:
                print(f"fastroute_job: removed {len(extra)} new items on nets outside "
                      f"{'--only-nets' if tag in ('all', 'final') else 'stage ' + tag}: {', '.join(names)}")
        if tag != "all":
            print(f"STAGE {tag} nets {len(stage_nets)} keepouts {n_keep} ROUTER_UNROUTED {report['stats']['unrouted']} "
                  f"VIAS {report['stats']['vias']} SECONDS {int(lean.now() - s0)}", flush=True)
        left_open = {u['net'] for u in report.get('unrouted', []) if u.get('net') in stage_nets}
        return report, imported, left_open, dict(stage=tag, nets=len(stage_nets), keepouts=n_keep, router_unrouted=report['stats']['unrouted'],
                                      vias=report['stats']['vias'], seconds=round(lean.now() - s0, 1))

    stage_log, staged, still_open = [], set(), set()
    for tag, stage_nets, keep, extra in passes:
        if tag == "final":
            # The last pass: the nets no stage routed (plane nets) and the nets a stage left open (their stage copper
            # unlocked). A finished stage net is an ignored class here: locked copper of a routed net made Fastroute
            # write coincident unprotected copper (CELLULAR /RF_ANT smoke run, import replay guard).
            stage_nets = (stage_nets - staged) | still_open
            # The stage copper of a net left open is ripped up (deleted, not drawn) so the last pass routes the net
            # again from its pads; locked or unlocked, that copper made the import replay guard reject the result
            # (coincident SES copper, CELLULAR smoke runs).
            gone = [t for t in b.GetTracks() if t.m_Uuid.AsString() not in was and t.GetNetname() in still_open]
            for t in gone:
                b.Delete(t)
            if gone:
                print(f"STAGE final: {len(gone)} stage items of {len(still_open)} nets left open ripped up: "
                      f"{', '.join(sorted(still_open))}", flush=True)
            if not stage_nets:
                last = passes[-2][0].replace(":", "_").replace("/", "")
                for n in ("board{}.dsn", "board{}.ses", "report{}.json"):
                    shutil.copy(os.path.join(a.outdir, n.format("-" + last)), os.path.join(a.outdir, n.format("")))
                print("STAGE final nets 0: every stage net routed; report.json is the last stage report", flush=True)
                break
        report, imported_vias, left_open, row = route_pass(tag, stage_nets, keep, extra=extra)
        if tag == "escape":
            # Expected: the far connections of the escape nets cannot be made inside the belts; the escapes stay
            # (locked stage copper) and the nets are routed again in their own stage.
            rb_ = [t for t in b.GetTracks() if t.m_Uuid.AsString() not in was and t.GetNetname() in stage_nets]
            n_v = sum(1 for t in rb_ if t.GetClass() == "PCB_VIA")
            inside = sum(1 for t in rb_ if t.GetClass() == "PCB_VIA" and any(
                c[0] <= t.GetPosition().x / 1e6 <= c[2] and c[1] <= t.GetPosition().y / 1e6 <= c[3]
                for c in (escape_info["refs"][r]["courtyard"] for r in escape_info["refs"])))
            escape_info.update(result=dict(items=len(rb_), vias=n_v, vias_inside_courtyard=inside,
                                           router_unrouted=report["stats"]["unrouted"], seconds=row["seconds"]))
            print(f"ESCAPE result: {len(rb_)} items, {n_v} vias ({inside} inside a fine-pitch courtyard) for "
                  f"{escape_info['pads']} pads; router left {report['stats']['unrouted']} connections (far ends, expected)", flush=True)
            left_open = set()   # the escape stage leaves nothing to the final pass: its nets have their own stage
        stage_log.append(dict(row, left_open=sorted(left_open)))
        staged |= stage_nets
        still_open = (still_open - stage_nets) | left_open
    if rules and still_open and int(feat["routing_rules"].get("repair_iterations", 2)) > 0:
        # Rip-up-and-repair (W9): the staged order locks each stage's copper, so a later stage cannot move it and
        # loses completion. Each repair iteration unlocks only the nets still open and their immediate blockers
        # (tools/routing_rules.repair_selection: copper within repair_corridor_mm of the straight line of the open
        # connection, the nearest repair_max_blockers nets), signal nets with the keepouts, exempt nets without; every
        # other net stays locked, pair, clock and fast copper included unless it is such a blocker. At most
        # repair_iterations; an iteration that leaves the same nets open stops the loop.
        rr_cfg = feat["routing_rules"]
        keep_any = any(k for _, _, k in rr_plan)
        grounds = set(rr_spec.get('grounds') or []) | plane_names
        for it in range(1, int(rr_cfg.get("repair_iterations", 2)) + 1):
            copper = []
            for t in b.GetTracks():
                if t.GetClass() == 'PCB_VIA':
                    c = t.GetPosition()
                    copper.append((t.GetNetname(), None, (c.x / 1e6, c.y / 1e6), (c.x / 1e6, c.y / 1e6)))
                else:
                    s, e = t.GetStart(), t.GetEnd()
                    copper.append((t.GetNetname(), t.GetLayerName(), (s.x / 1e6, s.y / 1e6), (e.x / 1e6, e.y / 1e6)))
            rows = [u for u in report.get('unrouted', []) if u.get('net') in still_open]
            sel = routing_rules.repair_selection(rows, copper, float(rr_cfg.get("repair_corridor_mm", 1.0)),
                                                 exclude=grounds, max_blockers=int(rr_cfg.get("repair_max_blockers", 4)))
            rip = set(sel['nets']) & nets
            if not rip:
                break
            sig = {n for n in rip if not routing_rules.exempt(n, rr_info, plane_names)}
            pwr = rip - sig
            print(f"STAGE repair{it}: {len(still_open)} nets open, {len(rip)} nets unlocked ({len(sig)} signal, "
                  f"{len(pwr)} exempt); blockers " + "; ".join(f"{k}: {', '.join(v) or '-'}" for k, v in sorted(sel['blockers'].items())),
                  flush=True)
            before_open = set(still_open)
            for tag, part, keep in ((f"repair{it}", sig, keep_any), (f"repair{it}_exempt", pwr, False)):
                if not part:
                    continue
                report, imported_vias, left_open, row = route_pass(tag, part, keep, rip=part)
                stage_log.append(dict(row, left_open=sorted(left_open), repair=True, unlocked=sorted(part),
                                      blockers=sel['blockers']))
                still_open = (still_open - part) | left_open
                for n in ("board{}.dsn", "board{}.ses", "report{}.json"):
                    shutil.copy(os.path.join(a.outdir, n.format("-" + tag)), os.path.join(a.outdir, n.format("")))
            print(f"STAGE repair{it}: {len(before_open)} -> {len(still_open)} nets open", flush=True)
            if not still_open or still_open == before_open:
                break
    if rules:
        lean.atomic_json(os.path.join(a.outdir, 'stage-plan.json'),
                         dict(stages=[dict(stage=n, nets=s, keepout=k) for n, s, k in rr_plan], runs=stage_log,
                              escape=escape_info, hot_loops=hot_info))
    secs = int(lean.now() - t0)
    after = vias()
    if a.native_thermal_checkback:
        _checked_thermal_fill(b, out, os.path.join(a.outdir, 'native-thermal-final-fill.json'),
                              phases, 'native-thermal-final-fill')
    else:
        with _native_phase('native-zone-fill-save', phases):
            pcbnew.ZONE_FILLER(b).Fill(b.Zones())
            pcbnew.SaveBoard(out, b)
    drc = os.path.join(a.outdir, "drc.json")
    progress.write('drc start')
    if a.native_thermal_checkback:
        d, final_drc = _thermal_drc(out, a.outdir, phases, 'native-thermal-final')
        final_thermal = route_native_thermals.discharge(native_thermal_capability, out,
            fill_receipt=os.path.join(a.outdir, 'native-thermal-final-fill.json'), drc_receipt=final_drc)
        lean.atomic_json(os.path.join(a.outdir, 'native-thermal-final.json'), final_thermal)
        lean.atomic_json(drc, d)
    else:
        p = lean.run_stage([KICAD_CLI, "pcb", "drc", "--refill-zones", "--severity-all", "--format", "json", "--units", "mm", "-o", drc, out],
                           stage='native-drc', event_file=phases, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        if p.returncode:
            sys.exit('native DRC failed; result is not verified')
        d = lean.validate_drc(json.load(open(drc)))
    progress.write('drc end')
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
    # W10 (2026-10-10, BASE-PWR-B preflight blocker: a GND pad via 0.186 mm from a 0.8 mm BACKUP_5V track, POWER class
    # clearance 0.2 mm): Fastroute leaves a routed track too close to a plane via the job placed before routing (the
    # DSN gives every class clearance 0.2 mm; the router's own report lists the violation as fixable and leaves it).
    # The via and its stub are deleted and the pad goes to the repair list: gnd_pad_vias.py places the via again with
    # the routed copper as the obstacle and the class clearance of each neighbour. No track is moved.
    src_keys = source_copper(a.board)
    moved = plane_via_clearance_repair(out, d, plane_names, preserve=src_keys)
    for net, pads in moved.items():
        todo.setdefault(net, set()).update(pads)
    if moved:
        print("fastroute_job: plane vias re-placed after a clearance violation with routed copper: " +
              ", ".join(f"{net} {', '.join(sorted(p))}" for net, p in sorted(moved.items())), flush=True)
    if a.native_thermal_checkback and todo:
        sys.exit('native thermal checkback prohibits post-import copper repairs')
    if todo:
        for net, pads in todo.items():
            tmp = os.path.join(a.outdir, "repair.kicad_pcb")
            r = lean.run_stage([sys.executable, tool, out, tmp, "--net", net, "--only", ",".join(sorted(pads))]
                               + shlex.split(a.via_args), stage=f"postimport-plane-repair:{net}", event_file=phases,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
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
    if a.native_thermal_checkback:
        thermal = dict(accepted=False, reason='explicit native checkback never performs thermal repairs')
    else:
        d, thermal = thermal_repair.repair(out, a.board, d, planes, shlex.split(a.via_args),
                                          KICAD_CLI, phases, 'postroute-thermal')
    lean.atomic_json(drc, d)
    lean.atomic_json(os.path.join(a.outdir, 'thermal-repair.json'), thermal)
    # Audit #815: every post-import repair (plane vias, thermal) is done; the input board's copper must all be there,
    # except the nets the caller unlocked for the router (--unlock-nets).
    unlocked = {n for n in a.unlock_nets.split(',') if n}
    lost = [k for k in missing_source_copper(out, src_keys) if k[1] not in unlocked]
    if lost:
        sys.exit(f"fastroute_job: SOURCE COPPER LOST: {len(lost)} input tracks/vias are missing after the post-import "
                 f"repairs (first {lost[0][:3]}); the result is not used")
    after = sum(1 for t in pcbnew.LoadBoard(out).GetTracks() if t.GetClass() == 'PCB_VIA')
    errors = sum(1 for v in d.get("violations", []) if v.get("severity") == "error")
    # Open connections of the skipped (ground) nets are a ground-via matter (gnd_pad_vias.py, a thermal pad via),
    # not a routing result: they are counted apart, so one ground pad cannot decide a placement step.
    # W16: a staged job (--only-nets, AC-24V stage M) leaves the nets of the later stages open by design; only opens on
    # the nets this job routes make it STUCK. The UNROUTED line still counts every signal open (the callers read it).
    gnd_open = other_open = 0
    for u in d.get("unconnected_items", []):
        m = re.search(r"\[([^\]]*)\]", u["items"][0]["description"]) if u.get("items") else None
        name = m.group(1) if m else ""
        if any(fnmatch.fnmatchcase(name, p) for p in skip) or name in plane_names:
            gnd_open += 1
        elif a.only_nets and name not in nets:
            other_open += 1
    signal_open = len(d.get("unconnected_items", [])) - gnd_open
    job_open = signal_open - other_open
    progress.write('triage start', open_=signal_open, vias=after)
    if route_features.on(feat, "triage_opens"):
        tri = os.path.join(a.outdir, "open-triage.json")
        if signal_open:
            p = lean.run_stage([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "route_grid.py"),
                                "triage", out, "--drc", drc, "--layers", a.layers, "--skip", ",".join(skip + planes), "--nets", routed_nets_file(),
                                "--out", tri], stage="open-triage", event_file=phases, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            print(([l for l in p.stdout.splitlines() if l.startswith("TRIAGE")] or ["TRIAGE failed"])[-1], flush=True)
        else:
            json.dump({"open": 0, "enclosed": 0, "router_miss": 0, "connections": []}, open(tri, "w"))
            print("TRIAGE open 0", flush=True)
        if feat["_board_dir"] and os.path.isfile(tri):
            os.makedirs(os.path.join(feat["_board_dir"], ".gate"), exist_ok=True)
            shutil.copy(tri, os.path.join(feat["_board_dir"], ".gate", "open-triage.json"))
    if rules:
        # Rule 2 evidence: vias per stage class and per net class; fast-net layer changes with no ground via near.
        rb = pcbnew.LoadBoard(out)
        grounds = set(rr_spec.get('grounds') or []) | plane_names
        vl, anchors = [], []
        for t in rb.GetTracks():
            if t.GetClass() == 'PCB_VIA':
                c, r = t.GetPosition(), t.GetWidth(pcbnew.F_Cu) / 2e6
                vl.append((t.GetNetname(), c.x / 1e6, c.y / 1e6, r))
                if t.GetNetname() in grounds:
                    anchors.append((c.x / 1e6, c.y / 1e6, r))
        for p in rb.GetPads():
            if p.GetNetname() in grounds and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                c, bb = p.GetPosition(), p.GetBoundingBox()
                anchors.append((c.x / 1e6, c.y / 1e6, min(bb.GetWidth(), bb.GetHeight()) / 2e6))
        net_stage = {n: s for s, ns, _ in rr_plan for n in ns}
        net_stage.update({n: 'plane' for n in plane_names})
        hot_len = {}
        for net_, h in hot_info.items():
            L_ = sum(t.GetLength() / 1e6 for t in rb.GetTracks() if t.GetClass() != 'PCB_VIA' and t.GetNetname() == net_)
            hot_len[net_] = dict(max_mm=h['max_mm'], straight_mm=h['straight_mm'], length_mm=round(L_, 3))
        vr = routing_rules.via_report(vl, net_stage, rr_cls, rr_info['fast'], grounds, anchors,
                                      float(rr_spec.get('via_allow_mm', 0.6)), hot=hot_len)
        lean.atomic_json(os.path.join(a.outdir, 'via-report.json'), vr)
        print(routing_rules.summary_line(vr), flush=True)
    progress.write('triage end', open_=signal_open)
    print(f"UNROUTED {signal_open} GND_OPEN {gnd_open} ERRORS {errors} ROUTER_UNROUTED {report['stats']['unrouted']} "
          f"CONGESTION {_diagnosis_count(report, 'congestion')} BLOCKED {_diagnosis_count(report, 'blocked')} "
          f"TRACK_MM {report['stats']['trace_length_mm']:.0f} VIAS {after} SECONDS {secs}", flush=True)
    if imported_vias != report["stats"]["vias"]:
        print(f"fastroute_job: RESULT NOT VERIFIED: {imported_vias} vias on the board, {report['stats']['vias']} in the router report", flush=True)
        sys.exit(4)
    if fail_fast.get('stuck_exit', True) and job_open:
        # The imported board, DRC, triage and the UNROUTED line are written; nothing more is spent on a board with opens.
        lean.atomic_json(os.path.join(a.outdir, 'outcome.json'),
                         dict(status='stuck', qualified=False, optimizer=a.optimizer, signal_open=signal_open,
                              ground_open=gnd_open, errors=errors, board_sha256=lean.digest(out),
                              note='fail_fast: open signal connections after routing; see open-triage.json'))
        print(f"STUCK {job_open} open signal connections after routing (fail_fast): no optimizer, exit {STUCK_RC}; "
              f"see {os.path.join(a.outdir, 'open-triage.json')}", flush=True)
        sys.exit(STUCK_RC)
    # Pending admission obligations: the final native DRC of the saved board must show none of their types.
    post = route_rule_coverage.discharge_native(native_obligations, d) if native_obligations else None
    if post is not None:
        lean.atomic_json(os.path.join(a.outdir, 'native-postconditions.json'), post)
    if post is not None and post['status'] != 'passed':
        lean.atomic_json(os.path.join(a.outdir, 'outcome.json'), dict(status='blocked', qualified=False,
            cause='native postcondition: ' + post['cause'], board_sha256=lean.digest(out),
            native_postconditions=os.path.join(a.outdir, 'native-postconditions.json')))
        print('STUCK native postcondition: ' + post['cause'], flush=True)
        sys.exit(4)
    if base_b_cfg:
        rb = pcbnew.LoadBoard(out)
        faults = base_b_route_rules.layer_faults([(t.GetNetname(), t.GetLayerName()) for t in rb.GetTracks()
                                                if t.GetClass() != 'PCB_VIA'], *base_b_cfg)
        counts = {}
        for t in rb.GetTracks():
            if t.GetClass() == 'PCB_VIA':
                counts[t.GetNetname()] = counts.get(t.GetNetname(), 0) + 1
        faults += base_b_route_rules.pair_via_faults(counts, mandatory_pairs, pair_profile)
        lean.atomic_json(os.path.join(a.outdir, 'mandatory-rules.json'), dict(faults=faults, preserved_pair_profile=pair_profile, qualified=False))
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
                          configured_gate_obligations=post['configured_gate'] if post else [],
                          note='import verified; full final board gate remains required'))


def _router_watch(log_path, stall_passes, owner, stop, result, progress, stage):
    """Read the router log while it runs: one progress line per autorouter pass (route_progress), and fail_fast
    stall_passes: after that many consecutive passes whose open count is not below the best so far, SIGTERM the router
    (Fastroute then writes its best board and the report and exits 0, as at --max-time; 0 = no stall stop). The router
    is the owned stage in owner['proc'] (lean.run_stage on_start); it gets one graceful interrupt. Parallel multi-start
    runs interleave their pass lines; they are read in log order."""
    best, stale, seen, starts, last_start = None, 0, 0, 1, False
    while not stop.wait(1.0):
        try:
            lines = open(log_path, errors='replace').read().splitlines()
        except OSError:
            continue
        for line in lines[seen:]:
            if 'Auto-routing stage started' in line:
                # W16 (POE-ETHERNET 2026-10-11): a new router stage ("diff pairs released ... routing again") starts
                # its own pass count; stale passes of the stage before must not stop it after its first pass. A burst
                # of stage starts is a parallel multi-start: its pass lines interleave, so the stall window is
                # stall_passes passes of each start (stall_passes x starts lines with no new best).
                starts = starts + 1 if last_start else 1
                best, stale, last_start = None, 0, True
                continue
            m = route_progress.parse_pass(line)
            if not m:
                continue
            last_start = False
            pass_no, n, _ = m
            progress.router_pass(pass_no, n, stage)
            if best is None or n < best:
                best, stale = n, 0
            else:
                stale += 1
            if stall_passes > 0 and stale >= stall_passes * starts:
                # Audit #803 (CIP 830): stop only the router this job owns, through its owned-stage handle (one
                # SIGTERM to its registered process group: Fastroute writes its best board). No process search by
                # name: pgrep -f DSN also matched unrelated processes whose command line contains that text.
                proc, how = owner.get('proc'), 'no owned router handle'
                attempted, acknowledged = False, None
                try:
                    if proc is not None:
                        attempted = True
                        answer = proc.interrupt()
                        acknowledged = answer if type(answer) is bool else None
                        how = 'owned-stage interrupt requested'
                except Exception as e:
                    # A socket timeout can follow delivery to the broker. Never
                    # send a second stop because its acknowledgment was lost.
                    how = f'interrupt acknowledgment unknown: {type(e).__name__}: {e}'
                result.update(interrupt_attempted=attempted, interrupt_acknowledged=acknowledged,
                              pass_no=pass_no, unrouted=n, best=best, how=how, seconds=round(time.time(), 1))
                stop.set()
                return   # W15: one stop signal only; a second one (more stale pass lines in the same read) made Fastroute
                         # exit 130 without its best board ("second stop signal, exiting", run-escape.log of /tmp/w15/run-1)
        seen = len(lines)


def main():
    import lean_resources as resources
    a = _parse_args()
    cpu = a.threads or resources.default_cpu()
    outdir = a.outdir
    events = outdir + '.admission.jsonl' if outdir else None
    # W17 (2026-10-11): a routing job reserves its measured peak, not the 8 GiB container default (IOT_JOB_MEMORY_GIB,
    # sized for kicad-cli in the Hetzner Docker image): BASE-PWR-B, the largest board in scope, peaks at 1.07 GB in
    # kicad-cli DRC --refill-zones, 0.38 GB in a pcbnew zone fill, 0.32 GB in Fastroute (/usr/bin/time -l), one after
    # another; 2 GiB is about 2x. 8 GiB let only two jobs into the 16 GiB pool. A queued job waits for its slot (up to
    # IOT_ROUTE_ADMISSION_WAIT_S, 1 h) and its --max-time starts after admission: run-6 (W15) and run-c2/c3 (W17) died
    # after 30 s in the queue as "deadline reached", rc 124.
    memory = float(os.environ.get('IOT_ROUTE_MEMORY_GIB', '2'))
    wait = float(os.environ.get('IOT_ROUTE_ADMISSION_WAIT_S', '3600'))
    admitted = False
    try:
        with resources.reserve(cpu, memory, wait_s=wait, events=events, label='routing') as env:
            admitted = True
            budget_env = dict(env)
            if a.max_time:
                budget_env['IOT_LEAN_DEADLINE'] = lean.encode_deadline(lean.deadline_after(a.max_time))
            with resources.environment(budget_env):
                ended = {}
                try:
                    ended['rc'] = _main(a)
                    return ended['rc']
                except SystemExit as stop:
                    ended['rc'] = stop.code
                    raise
                finally:   # W5: the run record gets the passes, reasons, triage and exit from the job's files
                    if outdir and os.path.isdir(outdir):
                        # CIP #829: an exit without outcome.json still leaves terminal evidence for the live view (a
                        # timeout or a cancel writes outcome.json in the handlers below, so they are not recorded here)
                        if 'rc' in ended and not os.path.isfile(os.path.join(outdir, 'outcome.json')):
                            code = ended['rc']
                            ok = code in (0, None)
                            try:
                                run_record.append(outdir, 'job', 'exit OK' if ok else 'exit FAILED', evidence='fastroute_job exit',
                                                  result={'returncode': code if isinstance(code, int) or code is None else 1,
                                                          'message': None if isinstance(code, int) or code is None else str(code)},
                                                  why='the job exited without outcome.json' + ('' if ok else ': it failed'))
                            except OSError:
                                pass
                        try:
                            run_record.sync(outdir)
                        except Exception:
                            pass
                        if os.path.isdir(os.path.join(outdir, 'snapshots')):   # W12: the 60 s timelapse (frames deleted)
                            try:
                                import board_frame
                                board_frame.mp4(outdir, keep=True)  # keep the frames: the live view replay (W12) reads snapshots/NNNN.png
                            except Exception as e:
                                print(f'fastroute_job: timelapse not made: {type(e).__name__}: {e}', flush=True)
    except (TimeoutError, subprocess.TimeoutExpired) as error:
        if outdir and os.path.isdir(outdir):
            lean.router_timeout(outdir, error)
        if not admitted:
            print(f'fastroute_job: ADMISSION TIMEOUT: no {cpu} CPU / {memory} GiB slot within {wait:.0f} s ({error})',
                  file=sys.stderr)
            return 124
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
