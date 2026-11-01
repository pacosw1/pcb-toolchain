"""Compaction router backend `iotroute` (milestone M4, tools/router/DESIGN.md): one step = tools/router/run.py on the
step board, then the board gate on the routed copy. The step score is measured, never the router claim:

  score = DRC errors + unconnected + parity   (run.py: kicad-cli pcb drc --schematic-parity on the saved board)
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
DRC_METRICS = {'drc_errors', 'drc_unconnected', 'drc_parity'}  # measured by run.py on the saved board


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
    """Step score from the run.py record and the gate metrics (None = gate not run)."""
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


def route_step(path, d, board, gate, iters, extra=(), run_stage=None):
    """Route the step board `path` into d/route-0 with run.py, gate it, write d/route-0/score.json; -> [score]."""
    name = os.path.splitext(os.path.basename(path))[0]
    out_dir = os.path.join(d, 'route-0')
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, name + '.kicad_pcb')
    cmd = [sys.executable, os.path.join(REPO, 'tools', 'router', 'run.py'), board, out, '--pcb', path,
           '--iters', str(iters), '--json'] + list(extra)
    run_stage = run_stage or (lambda c, *a, **k: subprocess.run(c, **k))
    p = run_stage(cmd, 'routing', cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    open(os.path.join(d, 'route-0.log'), 'w').write(p.stdout or '')
    rec = {'status': 'ERROR', 'cause': 'run.py printed no JSON record'}
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
