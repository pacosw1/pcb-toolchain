#!/usr/bin/env python3
"""One entry point for the in-house router: model -> iotroute -> board copy -> KiCad DRC (tools/router/DESIGN.md).

  $PY tools/router/run.py BOARD OUT.kicad_pcb [--pcb IN.kicad_pcb] [--iters N] [--max-time S]
                          [--lock-from SRC.kicad_pcb] [--reuse PREV.kicad_pcb [--reuse-fallback full|none]]
                          [--bin PATH] [--json]

BOARD is the board ID (hardware-design/boards/<BOARD>, gate.json or gate.pending.json names the project) or that
folder. The input is --pcb, else the project board. The input is only read.

Steps (each step stops the run at its first failure):
  1. --lock-from SRC: a copy of the input without tracks and vias, with the copper of the lock nets from SRC added
     and locked. Lock nets = diff-pairs.json pairs + nets with DRU via_count 0 (crystals), read from the model of
     SRC. Every pad of a lock net must be at the same place in SRC and in the input, else the copper cannot fit.
     Without --lock-from, all copper of the input stays and is locked (model.py reads it as fixed copper).
  2. The release binary. --bin PATH: used only when it is not older than the newest core source. Default: a cache
     folder per sha256 of the core sources (~/Library/Caches/iot-lab/iotroute/<sha>, env IOTROUTE_CACHE); cargo
     builds it there when it is missing. The stamp file binds the binary to the exact source bytes.
  3. tools/router/model.py, then iotroute MODEL ROUTE --iters N, then tools/router/write.py (adds the result to a
     copy, refills every zone, saves, puts back the .kicad_pro that pcbnew overwrites). With --congestion the core
     also writes OUT.iotroute/congestion.json (the congestion map for the placer, DESIGN.md 5d; it does not change ROUTE).
  4. OUT gets the board and the project files of the input. run.py checks that OUT's .kicad_pro is byte-identical
     to the input's .kicad_pro (pcbnew save rewrites it) and puts it back when it is not.
  5. kicad-cli pcb drc --schematic-parity on OUT (the saved zone fill, no --refill-zones: a stale fill shows here).

--reuse PREV (partial re-route, DESIGN.md 5c): PREV is an earlier run.py result (PREV.iotroute/route.json, bound to
PREV by the board_sha256 of PREV.iotroute/result.json). The seed (work/seed.json) = the copper of that route, the parts
that moved between PREV and the route input (position, orientation or side) and the nets that PREV left open or in a
DRC error (route.json failed + PREV.iotroute/drc.json). The core keeps the copper of the nets that the moves do not
touch and routes the rest (core reuse.rs). --reuse-fallback full (default): when the reuse result is not PASS, the full
route of the same input runs too and the better result is kept (DRC errors + unconnected + parity, then the core's
failed count; a tie keeps the full route); result.json `reuse` names both. none: the reuse result is the result.

The router's own counts are never the verdict; the DRC on OUT is. Output, one line:
  PASS|FAIL <drc errors> <unconnected> <parity> <tracks> <vias> <seconds>
  (ERROR <seconds> <cause> when a step did not complete)
and with --json a JSON record on the next line. The record is also in <OUT>.iotroute/result.json.
Exit: 0 PASS, 1 FAIL (routed, DRC not clean), 2 a step did not complete (no verdict).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CORE = os.path.join(HERE, 'core')
KICAD_CLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
SCHEMA = 'iot-lab.iotroute-run.v1'
SIDECARS = ('.kicad_pro', '.kicad_dru', '.kicad_sch')
TABLES = ('sym-lib-table', 'fp-lib-table')


class StepError(Exception):
    """A step did not complete: no verdict (exit 2)."""


def python_native():
    if 'pcbnew' in sys.modules or _has_pcbnew():
        return sys.executable
    return os.environ.get('KICAD_PYTHON', os.environ.get('KICAD_PY',
        '/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3'))


def _has_pcbnew():
    import importlib.util
    return importlib.util.find_spec('pcbnew') is not None


def sha_file(path):
    with open(path, 'rb') as fh:
        return hashlib.sha256(fh.read()).hexdigest()


# ---------- binary ----------

def core_sources(core=CORE):
    """The files that define the binary: Cargo.toml, Cargo.lock and every file below src/."""
    files = [os.path.join(core, n) for n in ('Cargo.toml', 'Cargo.lock') if os.path.isfile(os.path.join(core, n))]
    for base, dirs, names in os.walk(os.path.join(core, 'src')):
        dirs.sort()
        files += [os.path.join(base, n) for n in sorted(names)]
    if not files:
        raise StepError('no router core sources in ' + core)
    return files


def sources_sha(core=CORE):
    h = hashlib.sha256()
    for f in core_sources(core):
        h.update(os.path.relpath(f, core).encode() + b'\0' + open(f, 'rb').read() + b'\0')
    return h.hexdigest()


def check_explicit_bin(path, core=CORE):
    """--bin PATH must exist and must not be older than the newest core source."""
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise StepError('router binary missing or not executable: ' + path)
    newest = max(core_sources(core), key=os.path.getmtime)
    if os.path.getmtime(path) < os.path.getmtime(newest):
        raise StepError(f'router binary {path} is older than its source {os.path.relpath(newest, core)}: rebuild it')
    return path


def cache_dir(src_sha):
    base = os.environ.get('IOTROUTE_CACHE', os.path.expanduser('~/Library/Caches/iot-lab/iotroute'))
    return os.path.join(base, src_sha)


def find_or_build(core=CORE, log=None, build=None):
    """Binary for the exact current sources: cache hit by stamp, else cargo build into the cache folder."""
    src = sources_sha(core)
    d = cache_dir(src)
    exe = os.path.join(d, 'release', 'iotroute')
    stamp = os.path.join(d, 'sources.sha256')
    if os.path.isfile(exe) and os.path.isfile(stamp) and open(stamp).read().strip() == src:
        return exe, src, 'cache'
    os.makedirs(d, exist_ok=True)
    cmd = ['cargo', 'build', '--release', '--locked', '--manifest-path', os.path.join(core, 'Cargo.toml')]
    env = dict(os.environ, CARGO_TARGET_DIR=d)
    p = (build or subprocess.run)(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if log:
        open(log, 'w').write(p.stdout or '')
    if p.returncode or not os.path.isfile(exe):
        raise StepError(f'cargo build failed (exit {p.returncode}), see {log}')
    if sources_sha(core) != src:
        raise StepError('router core sources changed during the build')
    open(stamp, 'w').write(src + '\n')
    return exe, src, 'built'


# ---------- board files ----------

def board_project(board):
    """BOARD ID or board folder -> (board folder, project path without extension)."""
    bdir = board if os.path.isdir(board) else os.path.join(ROOT, 'hardware-design', 'boards', board)
    bdir = os.path.abspath(bdir)
    for name in ('gate.json', 'gate.pending.json'):
        p = os.path.join(bdir, name)
        if os.path.isfile(p):
            return bdir, os.path.join(bdir, json.load(open(p))['project'])
    raise StepError('no gate.json / gate.pending.json in ' + bdir)


def project_files(pcb):
    """The sidecar files next to a board: {target suffix or table name: source path}. The .kicad_pro is required."""
    d = os.path.dirname(os.path.abspath(pcb))
    stem = os.path.splitext(os.path.basename(pcb))[0]
    pros = sorted(f for f in os.listdir(d) if f.endswith('.kicad_pro'))
    proj = stem if stem + '.kicad_pro' in pros else (os.path.splitext(pros[0])[0] if len(pros) == 1 else None)
    if proj is None:
        raise StepError('no unique .kicad_pro next to ' + pcb)
    out = {}
    for ext in SIDECARS:
        if os.path.isfile(os.path.join(d, proj + ext)):
            out[ext] = os.path.join(d, proj + ext)
    for t in TABLES:
        if os.path.isfile(os.path.join(d, t)):
            out[t] = os.path.join(d, t)
    # v8: the sub-sheets of a hierarchical schematic (KiCad finds them next to the root sheet): without them the
    # parity check of the copy reads a partial netlist (BASE-PWR-C: parity 80 on a copy, 0 on the project)
    for f in sorted(os.listdir(d)):
        if f.endswith('.kicad_sch') and f != proj + '.kicad_sch':
            out[f] = os.path.join(d, f)
    return out


def place_sidecars(src_pcb, out_pcb):
    """Copy the project files of src_pcb next to out_pcb (named after out_pcb). An existing different file stops."""
    stem = os.path.splitext(os.path.abspath(out_pcb))[0]
    placed = {}
    for key, src in project_files(src_pcb).items():
        dst = stem + key if key.startswith('.') else os.path.join(os.path.dirname(stem), key)
        if os.path.exists(dst) and sha_file(dst) != sha_file(src):
            raise StepError(f'{dst} exists and differs from {src}')
        if not os.path.exists(dst):
            shutil.copyfile(src, dst)
        placed[key] = dst
    return placed


def restore_pro(src_pcb, out_pcb):
    """pcbnew SaveBoard rewrites the .kicad_pro with defaults: put the input's bytes back. True when it differed."""
    src = project_files(src_pcb)['.kicad_pro']
    dst = os.path.splitext(os.path.abspath(out_pcb))[0] + '.kicad_pro'
    if os.path.exists(dst) and sha_file(dst) == sha_file(src):
        return False
    shutil.copyfile(src, dst)
    return True


# ---------- lock copper ----------

def lock_nets(model):
    """Nets whose copper is kept from --lock-from: diff pairs + DRU via_count 0 nets (as M2 and NET-CORE did)."""
    nets = set()
    for p in model.get('pairs', []):
        nets.update(n for n in (p.get('p'), p.get('n')) if n)
    for name, info in model.get('nets', {}).items():
        if (info.get('limits') or {}).get('via_count') == 0:
            nets.add(name)
    return nets


def pad_mismatch(src_pads, dst_pads, nets, tol=0.001):
    """Pads of the lock nets that moved or are missing: {(ref, num): (x, y, net)} in mm."""
    bad = []
    for key, (x, y, net) in sorted(src_pads.items()):
        if net not in nets:
            continue
        d = dst_pads.get(key)
        if d is None or d[2] != net or abs(d[0] - x) > tol or abs(d[1] - y) > tol:
            bad.append(f'{key[0]}.{key[1]} {net}')
    return bad


def pads_of(board):
    import pcbnew
    T = pcbnew.ToMM
    return {(fp.GetReference(), p.GetNumber()): (T(p.GetPosition().x), T(p.GetPosition().y), p.GetNetname())
            for fp in board.GetFootprints() for p in fp.Pads()}


def make_locked_input(in_pcb, src_pcb, nets, out_pcb):
    """Copy of in_pcb: all tracks/vias removed, lock-net copper of src_pcb added and locked; sidecars copied."""
    import pcbnew
    b = pcbnew.LoadBoard(in_pcb)
    s = pcbnew.LoadBoard(src_pcb)
    bad = pad_mismatch(pads_of(s), pads_of(b), nets)
    if bad:
        raise StepError(f'--lock-from: {len(bad)} lock-net pads differ from the input: ' + ', '.join(bad[:8]))
    bn = b.GetNetsByName()   # before the removal: afterwards SWIG cannot wrap the net list (KiCad 10.0.6)
    removed = 0
    for t in list(b.GetTracks()):
        b.Delete(t)
        removed += 1
    kept = 0
    for t in s.GetTracks():
        if t.GetNetname() in nets:
            c = t.Duplicate()
            # v9 determinism: keep the source KIID. Duplicate() gives a random one, and KiCad saves the tracks sorted by
            # KIID, so the copper order of the copy (and of the model and the route) changed from run to run (v8b:
            # ESP32-CORE, same copper, 10 GND vias in another order)
            c.SetUuid(t.m_Uuid)
            b.Add(c)
            c.SetNet(bn[t.GetNetname()])
            c.SetLocked(True)
            kept += 1
    os.makedirs(os.path.dirname(os.path.abspath(out_pcb)), exist_ok=True)
    place_sidecars(in_pcb, out_pcb)
    b.Save(out_pcb)
    restore_pro(in_pcb, out_pcb)
    return dict(removed=removed, kept=kept, nets=sorted(nets))


# ---------- measurement ----------

def drc_counts(report):
    """KiCad DRC JSON -> (errors, unconnected, parity, errors by type). Errors = violations with severity error."""
    errs = [v for v in report.get('violations', []) if v.get('severity') == 'error']
    kinds = {}
    for v in errs:
        kinds[v.get('type', '?')] = kinds.get(v.get('type', '?'), 0) + 1
    return len(errs), len(report.get('unconnected_items', [])), len(report.get('schematic_parity', [])), kinds


def run_drc(pcb, out_json):
    p = subprocess.run([KICAD_CLI, 'pcb', 'drc', '--schematic-parity', '--severity-all', '--format', 'json',
                        '--units', 'mm', '--output', out_json, pcb], capture_output=True, text=True)
    if not os.path.isfile(out_json):
        raise StepError(f'kicad-cli drc wrote no report (exit {p.returncode}): {p.stderr.strip()[:300]}')
    return drc_counts(json.load(open(out_json)))


def copper_counts(pcb):
    import pcbnew
    b = pcbnew.LoadBoard(pcb)
    tracks = vias = 0
    length = 0.0
    for t in b.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            vias += 1
        elif t.GetClass() == 'PCB_TRACK':
            tracks += 1
            length += pcbnew.ToMM(t.GetLength())
    return tracks, vias, round(length, 1)


def summary_line(rec):
    if rec['status'] == 'ERROR':
        return 'ERROR %.0f %s' % (rec['seconds'], rec.get('cause', ''))
    return '%s %s %s %s %s %s %.0f' % (rec['status'], rec['drc_errors'], rec['unconnected'], rec['parity'],
                                       rec['tracks'], rec['vias'], rec['seconds'])


# ---------- reuse (partial re-route) ----------

REUSE_SCHEMA = 'iot-lab.route-seed.v0'


def footprint_poses(board):
    """{reference: (x nm, y nm, orientation in 0.1 degree, layer)} of a pcbnew board."""
    out = {}
    for fp in board.GetFootprints():
        p = fp.GetPosition()
        out[fp.GetReference()] = (p.x, p.y, round(fp.GetOrientationDegrees() * 10) % 3600, fp.GetLayer())
    return out


def moved_refs(prev, new, tol=100):
    """References whose position (tol nm), orientation or side differ between two pose maps; a reference in only one
    map stops (not the same board)."""
    if set(prev) != set(new):
        raise StepError('--reuse: the earlier board has other parts: ' + ', '.join(sorted(set(prev) ^ set(new))[:8]))
    return sorted(r for r in new if abs(prev[r][0] - new[r][0]) > tol or abs(prev[r][1] - new[r][1]) > tol
                  or prev[r][2:] != new[r][2:])


def drc_nets(report):
    """Nets named in the error violations and unconnected items of a KiCad DRC JSON report (the '[NET]' text)."""
    nets = set()
    items = [v for v in report.get('violations', []) if v.get('severity') == 'error'] + report.get('unconnected_items', [])
    for v in items:
        for it in v.get('items', []):
            nets.update(re.findall(r'\[([^\]]+)\]', it.get('description', '')))
    return nets


def reuse_seed(prev, route_in, out_json):
    """Write the seed of a reuse route (see the module text) -> its summary dict."""
    import pcbnew
    pw = os.path.abspath(prev) + '.iotroute'
    res, route, drc = (os.path.join(pw, n) for n in ('result.json', 'route.json', 'drc.json'))
    if not os.path.isfile(res) or not os.path.isfile(route):
        raise StepError('--reuse: %s has no run.py work folder with result.json and route.json' % prev)
    rec = json.load(open(res))
    if rec.get('board_sha256') != sha_file(prev):
        raise StepError('--reuse: %s is not the board of its result.json (sha256 differs)' % prev)
    r = json.load(open(route))
    moved = moved_refs(footprint_poses(pcbnew.LoadBoard(prev)), footprint_poses(pcbnew.LoadBoard(route_in)))
    failed = {f['net'] for f in r.get('failed', [])}
    # the core starts the present cost where the earlier negotiation ended (0.5 x 1.5^(passes - 1)); an earlier reuse
    # route itself started at its seed's passes, so its end equals passes_seed + passes - 1 iterations from 0.5
    passes = int(r.get('passes', 0))
    prev_reuse = rec.get('reuse') or {}
    if prev_reuse.get('chosen') == 'reuse' and prev_reuse.get('passes'):
        passes = int(prev_reuse['passes']) + passes - 1
    if os.path.isfile(drc):
        failed |= drc_nets(json.load(open(drc)))
    seed = dict(schema=REUSE_SCHEMA, source=os.path.abspath(prev), source_sha256=rec['board_sha256'], moved_refs=moved,
                failed_nets=sorted(failed), passes=passes, tracks=r['tracks'], vias=r['vias'])
    with open(out_json, 'w') as fh:
        json.dump(seed, fh, sort_keys=True)
    return dict(source=seed['source'], source_sha256=seed['source_sha256'], moved_refs=moved,
                failed_nets=seed['failed_nets'], passes=passes, tracks=len(r['tracks']), vias=len(r['vias']), seed_sha256=sha_file(out_json))


def better_attempt(a, b):
    """True when attempt a is better than b: fewer DRC errors + unconnected + parity, then fewer core failed nets."""
    key = lambda t: (t['drc_errors'] + t['unconnected'] + t['parity'], (t.get('claim') or {}).get('failed', 10 ** 6))
    return key(a) < key(b)


def parse_route_line(text):
    m = re.findall(r'^ROUTE (PASS|FAIL) converged (\w+) iters (\d+) tracks (\d+) vias (\d+) failed (\d+)', text, re.M)
    if not m:
        return None
    s, conv, it, tr, vi, fa = m[-1]
    return dict(status=s, converged=conv == 'true', iters=int(it), tracks=int(tr), vias=int(vi), failed=int(fa))


# ---------- tools/pcb route --router iotroute policy ----------

POLICY_SCHEMA = 'iot-lab.iotroute-policy.v1'
POLICY_DEFAULT = dict(schema=POLICY_SCHEMA, iters=80, max_time_s=None, keep='lock-nets')


def policy(spec):
    """Validated --spec of `tools/pcb route --router iotroute` (None = defaults). Exact fields only:
    {"schema": POLICY_SCHEMA, "iters": 1..1000, "max_time_s": null or > 0, "keep": "lock-nets" | "all"}.
    keep lock-nets: route from the candidate's pair + crystal copper (run.py --lock-from the candidate);
    keep all: keep and lock all candidate copper, route only what is open."""
    if spec is None:
        return dict(POLICY_DEFAULT)
    if not isinstance(spec, dict) or spec.get('schema') != POLICY_SCHEMA:
        raise ValueError('route --router iotroute requires a ' + POLICY_SCHEMA + ' spec')
    unknown = set(spec) - set(POLICY_DEFAULT)
    if unknown:
        raise ValueError('unknown iotroute policy fields: ' + ', '.join(sorted(unknown)))
    p = dict(POLICY_DEFAULT, **spec)
    if type(p['iters']) is not int or not 1 <= p['iters'] <= 1000:
        raise ValueError('iotroute policy iters must be an integer 1..1000')
    if p['max_time_s'] is not None and (type(p['max_time_s']) not in (int, float) or not p['max_time_s'] > 0):
        raise ValueError('iotroute policy max_time_s must be null or a positive number')
    if p['keep'] not in ('lock-nets', 'all'):
        raise ValueError('iotroute policy keep must be lock-nets or all')
    return p


def policy_args(spec, candidate):
    """run.py arguments for a validated policy on the candidate board."""
    p = policy(spec)
    args = ['--iters', str(p['iters'])]
    if p['max_time_s'] is not None:
        args += ['--max-time', str(p['max_time_s'])]
    if p['keep'] == 'lock-nets':
        args += ['--lock-from', str(candidate)]
    return args


# ---------- main ----------

def step(cmd, log, **kw):
    with open(log, 'w') as fh:
        p = subprocess.run(cmd, stdout=fh, stderr=subprocess.STDOUT, text=True, **kw)
    return p.returncode, open(log).read()


def run(a, rec, t0):
    out, work = rec['board_file'], rec['work']
    if not out.endswith('.kicad_pcb'):
        raise StepError('OUT must end in .kicad_pcb')
    if os.path.exists(work) or os.path.exists(out):
        rec['work'] = None   # not ours: never write into it
        raise StepError('OUT and its work folder must be new: ' + work)
    os.makedirs(work)
    py = python_native()
    bdir, proj = board_project(a.board)
    src = os.path.abspath(a.pcb or proj + '.kicad_pcb')
    rec.update(board=os.path.basename(bdir), input=src, input_sha256=sha_file(src), iters=a.iters)

    # 1. lock copper
    route_in = src
    if a.lock_from:
        lock_src = os.path.abspath(a.lock_from)
        rc, text = step([py, os.path.join(HERE, 'model.py'), bdir, '--pcb', lock_src,
                         '--out', os.path.join(work, 'lock-model.json')], os.path.join(work, 'lock-model.log'))
        if rc:
            raise StepError('model.py on --lock-from failed: ' + text.strip().splitlines()[-1][:300])
        nets = lock_nets(json.load(open(os.path.join(work, 'lock-model.json'))))
        route_in = os.path.join(work, 'input', os.path.basename(src))
        rec['stages']['lock'] = dict(make_locked_input(src, lock_src, nets, route_in), source=lock_src,
                                     source_sha256=sha_file(lock_src))

    # 2. binary
    if a.bin:
        exe, src_sha, how = check_explicit_bin(os.path.abspath(a.bin)), sources_sha(), 'explicit'
    else:
        exe, src_sha, how = find_or_build(log=os.path.join(work, 'cargo.log'))
    rec['stages']['binary'] = dict(path=exe, how=how, sources_sha256=src_sha, sha256=sha_file(exe))

    # 3. model, core, write
    model = os.path.join(work, 'model.json')
    rc, text = step([py, os.path.join(HERE, 'model.py'), bdir, '--pcb', route_in, '--out', model]
                    + (['--return-exempt'] if getattr(a, 'return_exempt', False) else []), os.path.join(work, 'model.log'))
    if rc:
        raise StepError('model.py failed: ' + (text.strip().splitlines() or ['no output'])[-1][:300])
    rec['stages']['model'] = dict(line=(text.strip().splitlines() or [''])[-1], sha256=sha_file(model))
    if not a.reuse:
        stages = route_attempt(a, exe, py, model, route_in, src, out, work)
        rec['stages'].update(stages)
        return finish(rec, out, work)

    # reuse: the partial route first; the full route only as the fallback (--reuse-fallback full) of a result that is
    # not PASS. Each attempt in its own folder; the chosen one's files go to work/ and its board to OUT.
    seed = os.path.join(work, 'seed.json')
    rec['reuse'] = dict(reuse_seed(a.reuse, route_in, seed), fallback=a.reuse_fallback, attempts={})
    tries = [('reuse', ['--reuse', seed])] + ([('full', [])] if a.reuse_fallback == 'full' else [])
    chosen = None
    for name, extra in tries:
        d = os.path.join(work, 'a-' + name)
        os.makedirs(d)
        cand = os.path.join(d, os.path.basename(out))
        st = route_attempt(a, exe, py, model, route_in, src, cand, d, extra)
        st.pop('pro_restored', None)
        att = dict(stages=st, claim=st['core']['claim'])
        rec['reuse']['attempts'][name] = att
        if len(tries) == 1:   # no fallback: the verdict DRC on OUT is the only one
            chosen = name
            break
        errors, unc, par, kinds = run_drc(cand, os.path.join(d, 'drc.json'))
        att.update(drc_errors=errors, unconnected=unc, parity=par, drc_by_type=kinds)
        if chosen is None or better_attempt(att, rec['reuse']['attempts'][chosen]) or (name == 'full' and not better_attempt(rec['reuse']['attempts'][chosen], att)):
            chosen = name
        if errors == 0 and unc == 0 and par == 0:
            break
    rec['reuse']['chosen'] = chosen
    d = os.path.join(work, 'a-' + chosen)
    for n in ('route.json', 'route.log', 'write.log', 'congestion.json'):
        if os.path.isfile(os.path.join(d, n)):
            shutil.copyfile(os.path.join(d, n), os.path.join(work, n))
    rec['stages'].update(rec['reuse']['attempts'][chosen]['stages'])
    shutil.copyfile(os.path.join(d, os.path.basename(out)), out)
    place_sidecars(src, out)
    rec['pro_restored'] = restore_pro(src, out)
    return finish(rec, out, work)


def route_attempt(a, exe, py, model, route_in, src, out, work, extra=()):
    """iotroute (+ extra flags) -> write.py -> OUT with its project files; -> stages {core, write}."""
    stages = {}
    route = os.path.join(work, 'route.json')
    # the congestion map (core congestion.rs, DESIGN.md 5d) is an opt-in side file for the placer repair rank 'hot'
    # (about 4 s per call); it never changes route.json
    cmd = [exe, model, route, '--iters', str(a.iters)] + (['--max-time', str(a.max_time)] if a.max_time else []) + list(extra)
    if getattr(a, 'congestion', False):
        cmd += ['--congestion', os.path.join(work, 'congestion.json'), '--cong-free', '1']
    tc = time.monotonic()
    rc, text = step(cmd, os.path.join(work, 'route.log'))
    claim = parse_route_line(text)
    stages['core'] = dict(exit=rc, seconds=round(time.monotonic() - tc, 1), claim=claim)
    if not os.path.isfile(route) or claim is None:
        raise StepError(f'iotroute wrote no result (exit {rc}), see {os.path.join(work, "route.log")}')
    wdir = os.path.join(work, 'write')
    rc, text = step([py, os.path.join(HERE, 'write.py'), route_in, route, wdir], os.path.join(work, 'write.log'))
    written = os.path.join(wdir, os.path.splitext(os.path.basename(project_files(route_in)['.kicad_pro']))[0] + '.kicad_pcb')
    if not os.path.isfile(written):
        raise StepError(f'write.py wrote no board (exit {rc}), see {os.path.join(work, "write.log")}')
    stages['write'] = dict(exit=rc, line=(text.strip().splitlines() or [''])[-1])

    # 4. OUT + project files
    shutil.copyfile(written, out)
    place_sidecars(src, out)
    stages['pro_restored'] = restore_pro(src, out)
    return stages


def finish(rec, out, work):
    """5. verdict: KiCad DRC with parity on OUT."""
    if 'pro_restored' in rec['stages']:
        rec['pro_restored'] = rec['stages'].pop('pro_restored')
    errors, unc, par, kinds = run_drc(out, os.path.join(work, 'drc.json'))
    tracks, vias, length = copper_counts(out)
    rec.update(drc_errors=errors, drc_by_type=kinds, unconnected=unc, parity=par, tracks=tracks, vias=vias,
               track_length_mm=length, board_sha256=sha_file(out),
               status='PASS' if errors == 0 and unc == 0 and par == 0 else 'FAIL')
    return rec


def parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('board', help='board ID or hardware-design/boards/<BOARD> folder')
    ap.add_argument('out', help='routed board to write (new file); work files go to OUT.iotroute/')
    ap.add_argument('--pcb', help='input board (default: the project board of BOARD); only read')
    ap.add_argument('--iters', type=int, default=80, help='negotiation iterations (default 80, as M2)')
    ap.add_argument('--max-time', type=float, help='iotroute --max-time seconds')
    ap.add_argument('--lock-from', help='keep only the lock-net copper (pairs + via_count 0 nets) of this board')
    ap.add_argument('--reuse', help='partial re-route from this earlier run.py result board (keeps the copper that the '
                    'moved parts do not touch; DESIGN.md 5c)')
    ap.add_argument('--reuse-fallback', choices=['full', 'none'], default='full',
                    help='full (default): a reuse result that is not PASS is compared with the full route; none: no full route')
    ap.add_argument('--congestion', action='store_true', default=os.environ.get('IOTROUTE_CONGESTION') == '1',
                    help='also write OUT.iotroute/congestion.json (DESIGN.md 5d; default off, env IOTROUTE_CONGESTION=1)')
    ap.add_argument('--return-exempt', action='store_true',
                    help='the nets of the gate kicad-happy RP-001 exemptions need no return via (model.py --return-exempt)')
    ap.add_argument('--bin', help='use this iotroute binary (must not be older than its sources)')
    ap.add_argument('--json', action='store_true', help='also print the JSON record')
    return ap


def main(argv=None):
    a = parser().parse_args(argv)
    t0 = time.monotonic()
    out = os.path.abspath(a.out)
    rec = dict(schema=SCHEMA, status='ERROR', board_file=out, work=out + '.iotroute', stages={}, drc_errors=None,
               unconnected=None, parity=None, tracks=None, vias=None)
    try:
        run(a, rec, t0)
        code = 0 if rec['status'] == 'PASS' else 1
    except StepError as e:
        rec.update(status='ERROR', cause=str(e))
        code = 2
    rec['seconds'] = round(time.monotonic() - t0, 1)
    if rec['work'] and os.path.isdir(rec['work']):
        json.dump(rec, open(os.path.join(rec['work'], 'result.json'), 'w'), indent=1)
    print(summary_line(rec), flush=True)
    if a.json:
        print(json.dumps(rec, sort_keys=True), flush=True)
    return code


if __name__ == '__main__':
    sys.exit(main())
