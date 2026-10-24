"""Gate runs (phase 3, wrap first): `tools/pcb check BOARD --fresh|--changed --json` in the project root.

Each JSON Lines event of the iot-lab run record is kept and published as a `run.event` notification; the terminal
`run.end` event carries status, cause and the gate metrics. The iot-lab run record (.gate/cli/RUN_ID) stays the
durable evidence; this module only supervises and relays it.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import os
import signal
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import events

MAX_EVENTS = 2000
_ids = itertools.count(1)


@dataclass
class Run:
    id: str
    board: str
    mode: str
    argv: list[str]
    started: float = field(default_factory=time.time)
    state: str = 'running'            # running | passed | failed | error | cancelled
    exit_code: int | None = None
    run_id: str | None = None         # iot-lab run id (run-…)
    end: dict | None = None
    events: list[dict] = field(default_factory=list)
    stderr: list[str] = field(default_factory=list)
    proc: asyncio.subprocess.Process | None = None

    def summary(self) -> dict:
        e = self.end or {}
        return {'id': self.id, 'board': self.board, 'mode': self.mode, 'state': self.state,
                'started': self.started, 'exit_code': self.exit_code, 'run_id': self.run_id,
                'cause': e.get('cause'), 'metrics': e.get('metrics'), 'findings': len(e.get('findings') or []),
                'events': len(self.events), 'elapsed_s': e.get('elapsed_s')}


class Runs:
    def __init__(self) -> None:
        self.runs: dict[str, Run] = {}

    def start_check(self, root: Path, board: str, fresh: bool = True) -> Run:
        if not board or '/' in board or board.startswith('-'):
            raise ValueError(f'invalid board gate name: {board!r}')
        tool = root / 'tools' / 'pcb'
        if not tool.is_file():
            raise FileNotFoundError(f'{tool} (this project has no tools/pcb)')
        argv = [str(tool), 'check', board, '--fresh' if fresh else '--changed', '--json']
        run = Run(id=f'r{next(_ids)}', board=board, mode='fresh' if fresh else 'changed', argv=argv)
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
                'failed' if run.end else 'error')
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
                ev = {'type': 'output.text', 'text': line}
            run.run_id = run.run_id or ev.get('run_id')
            if ev.get('type') == 'run.end':
                run.end = ev
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

    def cancel(self, run_id: str) -> dict:
        run = self.runs[run_id]
        if run.proc and run.proc.returncode is None:
            os.killpg(run.proc.pid, signal.SIGTERM)       # the iot-lab supervisor cleans its process family
            run.state = 'cancelled'
        return run.summary()


def _compact(ev: dict) -> dict:
    """Drop bulky fields from a relayed event (the full event stays in run.events)."""
    return {k: v for k, v in ev.items() if k not in ('timing', 'cleanup', 'command')}


runs = Runs()
