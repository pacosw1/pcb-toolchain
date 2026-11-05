"""Compaction router backend `iotroute` (milestone M4, tools/router/DESIGN.md): one step = iotroute run on the
step board, then the board gate on the routed copy. The step score is measured, never the router claim:

  score = DRC errors + unconnected + parity   (iotroute run: kicad-cli pcb drc --schematic-parity on the saved board)
        + every other gate metric with a target (erc_errors, planes, pairs, viapads, paths_low, kicad_happy, ...)

The gate runs only when the DRC part is 0 (a cheaper check that fails first). A step passes only at score 0 with a
complete gate. A gate metric that did not run makes the score NO_RESULT. The gate runs in one isolated snapshot of
the repo per compaction run (tools/pcb_operations.snapshot: tools + the board folder + its dependencies); each step
copies its routed board into the snapshot's project path, then `node tools/gate.mjs BOARD --fresh --evidence-dir`.
"""
import json
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NO_RESULT = 10 ** 6
INFO_METRICS = {'erc_warnings', 'drc_warnings'}         # tools/lib/gate-core.mjs METRICS without a target
DRC_METRICS = {'drc_errors', 'drc_unconnected', 'drc_parity'}  # measured by iotroute run on the saved board


THREAD_MARKS = ('std::thread', 'thread::spawn', 'thread::scope', 'rayon', 'available_parallelism', 'crossbeam')
DRC_TOKENS = 1  # iotroute run ends with kicad-cli pcb drc on the saved board: one more token for that phase


def router_cpu(core=os.path.join(REPO, 'tools', 'router', 'core'), full=None):
    """CPU tokens for one iotroute run job from the router's real thread use: 1 + DRC_TOKENS when the core sources
    (Cargo.toml and src/) use no thread or parallel crate (the binary runs on one thread), else `full` (the
    resource default). A core that cannot be read gets `full` (fail safe)."""
    if full is None:
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        import lean_resources
        full = lean_resources.default_cpu()
    files = [os.path.join(core, 'Cargo.toml')] + [os.path.join(b, n) for b, _, ns in os.walk(os.path.join(core, 'src'))
                                                  for n in ns if n.endswith('.rs')]
    try:
        text = '\n'.join(open(f).read() for f in files)
    except OSError:
        return full
    if len(files) < 2 or any(m in text for m in THREAD_MARKS):
        return full
    return min(full, 1 + DRC_TOKENS)


def board_id(board_dir):
    """hardware-design/boards/<ID>[/cad/...] -> ID."""
    parts = os.path.abspath(board_dir).split(os.sep)
    for i in range(len(parts) - 2):
        if parts[i] == 'hardware-design' and parts[i + 1] == 'boards':
            return parts[i + 2]
    raise ValueError('--board-dir is not below hardware-design/boards: ' + board_dir)


def gate_part(metrics):
    """(sum of the non-DRC gate metrics with a target, complete). None metrics make it incomplete."""
    total, complete = 0, True
    for name, value in (metrics or {}).items():
        if name in INFO_METRICS or name in DRC_METRICS:
            continue
        if not isinstance(value, int) or isinstance(value, bool):
            complete = False
            continue
        total += value
    return total, complete and bool(metrics)


def score(rec, metrics):
    """Step score from the iotroute run record and the gate metrics (None = gate not run)."""
    if rec.get('status') not in ('PASS', 'FAIL'):
        return NO_RESULT
    drc = rec['drc_errors'] + rec['unconnected'] + rec['parity']
    if drc:
        return drc
    if metrics is None:
        return NO_RESULT
    total, complete = gate_part(metrics)
    return total if complete else NO_RESULT


class GateWorkspace:
    """One repo snapshot for the gate runs of a compaction call (made at the first clean step)."""

    def __init__(self, outdir, board):
        self.path = os.path.join(os.path.abspath(outdir), 'gate-workspace')
        self.board = board
        self.project = None

    def ensure(self):
        if self.project is None:
            sys.path.insert(0, os.path.join(REPO, 'tools'))
            import pcb_operations
            pcb_operations.snapshot(REPO, self.path, self.board)
            bdir = os.path.join(self.path, 'hardware-design', 'boards', self.board)
            cfg = 'gate.json' if os.path.isfile(os.path.join(bdir, 'gate.json')) else 'gate.pending.json'
            self.config = cfg
            self.project = os.path.join(bdir, json.load(open(os.path.join(bdir, cfg)))['project'])
        return self

    def run(self, routed, evidence, log, runner=subprocess.run):
        self.ensure()
        shutil.copyfile(routed, self.project + '.kicad_pcb')
        cmd = ['node', os.path.join(self.path, 'tools', 'gate.mjs'), self.board, '--fresh', '--evidence-dir', evidence]
        if self.config != 'gate.json':
            cmd += ['--config', self.config]
        with open(log, 'w') as fh:
            runner(cmd, cwd=self.path, stdout=fh, stderr=subprocess.STDOUT)
        result = os.path.join(evidence, 'result.json')
        if not os.path.isfile(result):
            return None
        return json.load(open(result)).get('metrics')


MEASURE_SOURCE = 'iotroute run copper_counts: track lengths and via count of the saved board'


def measure_key(key, routed, source='route'):
    """Measure from a repair score key (DRC part, gate part, length, vias) of the board `routed`; None without a
    finite length."""
    try:
        length, vias = float(key[2]), int(key[3])
    except (IndexError, TypeError, ValueError, OverflowError):
        return None
    if length != length or length in (float('inf'), float('-inf')):
        return None
    return dict(length_mm=round(length, 1), vias=vias, routed=routed, source=source + ': ' + MEASURE_SOURCE)


def measure(d):
    """Measure of the step route d/route-0/score.json: the routed length (mm) and via count that iotroute run measured
    on the saved board (never the router core claim). None when the record has no measure."""
    try:
        with open(os.path.join(d, 'route-0', 'score.json')) as fh:
            rec = json.load(fh).get('run') or {}
    except (OSError, ValueError):
        return None
    if rec.get('status') not in ('PASS', 'FAIL') or rec.get('track_length_mm') is None or rec.get('vias') is None:
        return None
    return measure_key((None, None, rec['track_length_mm'], rec['vias']), rec.get('board_file'), 'route')


def iotroute_bin():
    """The binary of these sources (tools/lib/iotroute-bin.ts)."""
    finder = os.path.join(REPO, 'tools', 'lib', 'iotroute-bin.ts')
    return subprocess.run(['node', '--no-warnings', '--experimental-strip-types', finder], check=True, capture_output=True, text=True).stdout.strip()


def route_step(path, d, board, gate, iters, extra=(), run_stage=None):
    """Route the step board `path` into d/route-0 with iotroute run, gate it, write d/route-0/score.json; -> [score]."""
    name = os.path.splitext(os.path.basename(path))[0]
    out_dir = os.path.join(d, 'route-0')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, name + '.kicad_pcb')
    cmd = [iotroute_bin(), 'run', board, out, '--pcb', path, '--iters', str(iters), '--tools', os.path.join(REPO, 'tools'),
           '--json'] + list(extra)
    run_stage = run_stage or (lambda c, *a, **k: subprocess.run(c, **k))
    p = run_stage(cmd, 'routing', cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    open(os.path.join(d, 'route-0.log'), 'w').write(p.stdout or '')
    rec = {'status': 'ERROR', 'cause': 'iotroute run printed no JSON record'}
    for line in reversed((p.stdout or '').splitlines()):
        if line.startswith('{'):
            rec = json.loads(line)
            break
    metrics = None
    if rec.get('status') in ('PASS', 'FAIL') and rec['drc_errors'] + rec['unconnected'] + rec['parity'] == 0:
        metrics = gate.run(out, os.path.join(out_dir, 'gate'), os.path.join(d, 'gate.log'))
    s = score(rec, metrics)
    summary = dict(router='iotroute', score=s, run=rec, gate_metrics=metrics,
                   gate='run' if metrics is not None else 'not run: DRC part not 0 or no record',
                   passed=s == 0, qualified=False)
    json.dump(summary, open(os.path.join(out_dir, 'score.json'), 'w'), indent=1)
    print('IOTROUTE %s score %s drc %s unconnected %s parity %s gate %s length %s mm vias %s' % (
        'PASS' if s == 0 else 'FAIL', s, rec.get('drc_errors'), rec.get('unconnected'), rec.get('parity'),
        'n/a' if metrics is None else gate_part(metrics)[0], rec.get('track_length_mm'), rec.get('vias')), flush=True)
    return [s]
