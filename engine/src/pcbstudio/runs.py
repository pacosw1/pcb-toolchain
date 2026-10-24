"""Runs of the iot-lab CLI in the project root (wrap first): gate checks (phase 3) and candidate operations (phase 5).

  check  `tools/pcb check BOARD --fresh|--changed --json`
  build  `tools/pcb build BOARD --json`              (the board's own pipeline; unsupported boards fail explicitly)
  route  `tools/pcb route BOARD --router fastroute --spec POLICY.json --timeout S --json`
  adopt  `tools/pcb adopt RUN_ID --json`             (only on a user click; the only step that writes canonical CAD)

Each JSON Lines event of the iot-lab run record is kept and published as a `run.event` notification; the terminal
`run.end` event carries status, cause and the gate metrics. For build/route, `run.end` is the sealed
operation/result.json (tools/pcb_operations.py run()) plus supervisor fields (tools/pcb_cli.py worker()):
`candidate` (absolute path of the isolated native board under `evidence_dir`/workspace/), `candidate_sha256`,
`candidate_verified`, `identity_preserved` and `metrics` (the candidate's own gate result). The iot-lab run record
(.gate/cli/RUN_ID) stays the durable evidence; this module only supervises and relays it.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import os
import signal
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import events

MAX_EVENTS = 2000
OPS = ('check', 'build', 'route')
POLICY_SCHEMA = 'iot-lab.routing-policy.v1'
POLICY_FIELDS = {'schema', 'layers', 'only_nets', 'passes', 'threads', 'timeout_s', 'optimizer', 'max_repairs'}
_ids = itertools.count(1)


@dataclass
class Run:
    id: str
    board: str
    mode: str                         # check: fresh | changed; build: build; route: the router (fastroute)
    argv: list[str]
    op: str = 'check'
    root: Path | None = None
    policy: dict | None = None        # route: the exact routing policy given to the CLI
    started: float = field(default_factory=time.time)
    state: str = 'running'            # running | passed | failed | error | cancelled
    exit_code: int | None = None
    run_id: str | None = None         # iot-lab run id (run-…)
    end: dict | None = None
    events: list[dict] = field(default_factory=list)
    stderr: list[str] = field(default_factory=list)
    proc: asyncio.subprocess.Process | None = None
    adoption: dict | None = None      # the adopt receipt (target, before/after sha256) once adopted

    def candidate(self) -> dict | None:
        """The isolated candidate board of a build/route run, project-relative, or None.

        `target` is the canonical board file adopt replaces: the run workspace is a snapshot of the checkout, so the
        candidate's path inside it is the same project-relative path in the checkout."""
        e = self.end or {}
        if self.op == 'check' or not e.get('candidate') or self.root is None:
            return None
        rp, cand = self.root.resolve(), Path(e['candidate']).resolve()
        if rp not in cand.parents:                      # a run store outside the project (PCB_RUNS_DIR)
            return None
        target = None
        if e.get('evidence_dir'):
            ws = Path(e['evidence_dir']).resolve() / 'workspace'
            if ws in cand.parents:
                target = str(cand.relative_to(ws))
        return {'pcb': str(cand.relative_to(rp)), 'target': target, 'exists': cand.is_file(),
                'sha256': e.get('candidate_sha256'), 'verified': bool(e.get('candidate_verified')),
                'identity_preserved': e.get('identity_preserved'), 'metrics': e.get('metrics')}

    def adoptable(self) -> str | None:
        """Why this run cannot be adopted, or None. The CLI re-verifies everything; this only refuses early."""
        if self.op == 'check':
            return 'a gate check has no candidate'
        if self.adoption:
            return 'already adopted'
        if self.state != 'passed':
            return f'run is {self.state}, not passed'
        c = self.candidate()
        if not c or not c['exists'] or not c['target']:
            return 'run has no candidate board inside the project'
        if not c['verified'] or not c['identity_preserved']:
            return 'candidate is not gate-verified with preserved design identity'
        return None

    def summary(self) -> dict:
        e = self.end or {}
        return {'id': self.id, 'op': self.op, 'board': self.board, 'mode': self.mode, 'state': self.state,
                'started': self.started, 'exit_code': self.exit_code, 'run_id': self.run_id,
                'cause': e.get('cause'), 'metrics': e.get('metrics'), 'findings': len(e.get('findings') or []),
                'events': len(self.events), 'elapsed_s': e.get('elapsed_s'),
                'candidate': self.candidate(), 'policy': self.policy, 'adoption': self.adoption,
                'adoptable': self.op != 'check' and self.adoptable() is None}


class Runs:
    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}

    def start_check(self, root: Path, board: str, fresh: bool = True) -> Run:
        return self.start(root, 'check', board, fresh=fresh)

    def start(self, root: Path, op: str, board: str, *, fresh: bool = True, policy: dict | None = None,
              timeout_s: int | None = None) -> Run:
        """Start one CLI run. route needs a complete routing policy (see routing_policy); it goes to a spec file
        outside the project (the CLI reads it once at admission and keeps it in its sealed run.json)."""
        if op not in OPS:
            raise ValueError(f'unknown run op {op!r} (one of {", ".join(OPS)})')
        if not board or '/' in board or board.startswith('-'):
            raise ValueError(f'invalid board gate name: {board!r}')
        tool = _tool(root)
        if op == 'check':
            mode = 'fresh' if fresh else 'changed'
            argv = [str(tool), 'check', board, f'--{mode}', '--json']
        elif op == 'build':
            mode = 'build'
            argv = [str(tool), 'build', board, *(['--timeout', str(timeout_s)] if timeout_s else []), '--json']
        else:
            if policy is None:
                raise ValueError('route needs a routing policy')
            _check_policy(policy)
            # The CLI deadline covers the solver and the complete fresh verification of the candidate.
            total = timeout_s or max(600, policy['timeout_s'] + 600)
            if total < policy['timeout_s']:
                raise ValueError('the total timeout must be at least the router timeout_s')
            fd, spec = tempfile.mkstemp(prefix=f'pcbstudio-route-{board}-', suffix='.json')
            with os.fdopen(fd, 'w') as f:
                json.dump(policy, f)
            mode = 'fastroute'
            argv = [str(tool), 'route', board, '--router', 'fastroute', '--spec', spec, '--timeout', str(total), '--json']
        run = Run(id=f'r{next(_ids)}', op=op, board=board, mode=mode, argv=argv, root=root,
                  policy=policy if op == 'route' else None)
        self.runs[run.id] = run
        asyncio.get_running_loop().create_task(self._supervise(run, root))
        events.publish('run.state', run.summary())
        return run

    async def _supervise(self, run: Run, root: Path) -> None:
        try:
            run.proc = await asyncio.create_subprocess_exec(
                *run.argv, cwd=str(root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                start_new_session=True, env={**os.environ})
            await asyncio.gather(self._read_events(run), self._read_stderr(run))
            run.exit_code = await run.proc.wait()
        except Exception as e:  # noqa: BLE001 - reported on the run, never swallowed
            run.stderr.append(f'{type(e).__name__}: {e}')
            run.state = 'error'
        if run.state == 'running':
            status = (run.end or {}).get('status')
            run.state = 'passed' if status == 'passed' and run.exit_code == 0 else (
                'failed' if run.end and status != 'error' else 'error')
        events.publish('run.state', run.summary())

    async def _read_events(self, run: Run) -> None:
        assert run.proc and run.proc.stdout
        async for raw in run.proc.stdout:
            line = raw.decode(errors='replace').strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                ev = None
            if not isinstance(ev, dict):
                ev = {'type': 'output.text', 'text': line}
            run.run_id = run.run_id or ev.get('run_id')
            if ev.get('type') == 'run.end':
                run.end = ev
            elif 'type' not in ev and 'status' in ev and 'cause' in ev and run.end is None:
                # Admission errors (bad spec, unknown board) print one bare {status, exit_code, cause} object.
                ev = run.end = {**ev, 'type': 'run.end'}
            run.events.append(ev)
            if len(run.events) > MAX_EVENTS:
                del run.events[: len(run.events) - MAX_EVENTS]
            events.publish('run.event', {'id': run.id, 'event': _compact(ev)})

    async def _read_stderr(self, run: Run) -> None:
        assert run.proc and run.proc.stderr
        async for raw in run.proc.stderr:
            run.stderr.append(raw.decode(errors='replace').rstrip())
            del run.stderr[:-200]

    def findings(self, run_id: str, root: Path) -> dict:
        """DRC violations and unconnected items of a finished run, with board positions (mm), from its drc.json."""
        run = self.runs[run_id]
        gate_result = (run.end or {}).get('gate_result')
        if not gate_result:
            return {'id': run_id, 'items': [], 'source': None}
        drc = Path(gate_result).parent / 'drc.json'
        rp = root.resolve()
        if not drc.is_file() or rp not in drc.resolve().parents:
            return {'id': run_id, 'items': [], 'source': None}
        data = json.loads(drc.read_text())
        items = []
        for kind, rows in (('violation', data.get('violations') or []), ('unconnected', data.get('unconnected_items') or [])):
            for v in rows:
                pts = [i.get('pos') for i in v.get('items', []) if i.get('pos')]
                if not pts:
                    continue
                items.append({'kind': kind, 'type': v.get('type', kind), 'severity': v.get('severity', 'error'),
                              'description': v.get('description', ''),
                              'x': sum(p['x'] for p in pts) / len(pts), 'y': sum(p['y'] for p in pts) / len(pts),
                              'items': [{'description': i.get('description', ''), 'x': i['pos']['x'], 'y': i['pos']['y']}
                                        for i in v.get('items', []) if i.get('pos')]})
        order = {'error': 0, 'warning': 1}
        items.sort(key=lambda f: (order.get(f['severity'], 2), f['type']))
        return {'id': run_id, 'items': items, 'source': str(drc.relative_to(rp))}

    async def adopt(self, run_id: str) -> dict:
        """`tools/pcb adopt RUN_ID --json`. The CLI re-verifies the sealed candidate, its evidence and the unchanged
        canonical inputs, takes the board writer lock, backs the original up into the run folder and atomically
        replaces only the canonical PCB. Its receipt: {board, target, before_sha256, after_sha256, candidate_run}."""
        run = self.runs[run_id]
        why = run.adoptable()
        if why:
            raise ValueError(f'cannot adopt {run_id}: {why}')
        assert run.root is not None
        if not run.run_id:
            raise ValueError(f'cannot adopt {run_id}: no iot-lab run id')
        proc = await asyncio.create_subprocess_exec(
            str(_tool(run.root)), 'adopt', run.run_id, '--json', cwd=str(run.root),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env={**os.environ})
        out, err = await proc.communicate()
        lines = [ln for ln in out.decode(errors='replace').splitlines() if ln.strip()]
        try:
            data = json.loads(lines[-1]) if lines else {}
        except json.JSONDecodeError:
            data = {}
        if proc.returncode != 0 or not isinstance(data, dict) or 'after_sha256' not in data:
            cause = (data.get('cause') if isinstance(data, dict) else None) or err.decode(errors='replace').strip()[-800:] \
                or (lines[-1] if lines else '')
            raise RuntimeError(f'tools/pcb adopt refused (exit {proc.returncode}): {cause}')
        run.adoption = data
        events.publish('run.state', run.summary())
        return data

    def cancel(self, run_id: str) -> dict:
        run = self.runs[run_id]
        if run.proc and run.proc.returncode is None:
            os.killpg(run.proc.pid, signal.SIGTERM)       # the iot-lab supervisor cleans its process family
            run.state = 'cancelled'
        return run.summary()


def _tool(root: Path) -> Path:
    tool = root / 'tools' / 'pcb'
    if not tool.is_file():
        raise FileNotFoundError(f'{tool} (this project has no tools/pcb)')
    return tool


def routing_policy(layers: list[str], nets: list[str], passes: int, timeout_s: int, threads: int = 1,
                   optimizer: str = 'if-routed') -> dict:
    """The exact iot-lab.routing-policy.v1 object (tools/PCB-CLI.md; tools/pcb_routing_trial.py validate())."""
    policy = {'schema': POLICY_SCHEMA, 'layers': list(layers), 'only_nets': list(nets), 'passes': passes,
              'threads': threads, 'timeout_s': timeout_s, 'optimizer': optimizer, 'max_repairs': 0}
    _check_policy(policy)
    return policy


def _check_policy(p: dict) -> None:
    """An early, readable refusal of what the CLI refuses anyway (the CLI stays the authority)."""
    if not isinstance(p, dict) or set(p) != POLICY_FIELDS or p.get('schema') != POLICY_SCHEMA:
        raise ValueError(f'routing policy needs exactly the {POLICY_SCHEMA} fields {sorted(POLICY_FIELDS)}')
    for k in ('passes', 'threads', 'timeout_s'):
        if type(p[k]) is not int or p[k] <= 0:
            raise ValueError(f'{k} must be a positive integer')
    for k in ('layers', 'only_nets'):
        v = p[k]
        if not isinstance(v, list) or not v or any(not isinstance(x, str) or not x for x in v) or len(set(v)) != len(v):
            raise ValueError(f'{k} needs a nonempty list of distinct names')
    if p['optimizer'] not in ('off', 'if-routed') or p['max_repairs'] != 0:
        raise ValueError('optimizer must be off or if-routed, and max_repairs 0')
    if any(any(c in n for c in ',*?[]\r\n\x00') for n in p['only_nets']):
        raise ValueError('only_nets must be exact net names (no commas or wildcards)')


def _compact(ev: dict) -> dict:
    """Drop bulky fields from a relayed event (the full event stays in run.events)."""
    return {k: v for k, v in ev.items() if k not in ('timing', 'cleanup', 'command')}


runs = Runs()
