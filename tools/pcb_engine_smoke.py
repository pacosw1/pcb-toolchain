#!/usr/bin/env python3
"""Native integration regression: repair a real-board gap through the public engine.

This is a validation harness, not an alternate production routing workflow.
It injects a known defect only in a new snapshot and never adopts the result.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import lean_workflow as lean
from engineering_workflow_smoke import gap_candidate
from pcb_operations import snapshot
from pcb_workflow import board_config, sha
from placer.dru import _tree, _tokens
from pcb_search.block_bindings import child


class NoFixture(RuntimeError):
    pass


def verified_gap(native, output, timeout_s):
    """Bounded test preparation; rejected injections never become engine labels."""
    from route_decision import select_gap
    original = native.read_bytes()
    root = _tree(_tokens(original.decode()))[0]
    table = {row[1]: row[2] for row in root if isinstance(row, list) and row[:1] == ['net'] and len(row) == 3}
    planes = set()
    for row in root:
        if isinstance(row, list) and row[:1] == ['zone']:
            net = child(row, 'net', [])
            if net:
                planes.add(table.get(net[-1], net[-1]))
    rejected, excluded = [], []
    deadline = lean.deadline_after(min(120, timeout_s), {})

    def check(index):
        path = output / ('injection-preflight-' + str(index) + '.json')
        command = [os.environ.get('KICAD_CLI', 'kicad-cli'), 'pcb', 'drc', '--schematic-parity',
                   '--refill-zones', '--severity-all', '--format', 'json', '--units', 'mm',
                   '-o', str(path), str(native)]
        with path.with_suffix('.log').open('wb') as stream:
            try:
                run = lean.run_stage(command, stage='injection-preflight-' + str(index), deadline=deadline,
                                     stdout=stream, stderr=subprocess.STDOUT)
            except (OSError, subprocess.TimeoutExpired) as error:
                raise NoFixture('bounded native defect preflight unavailable: ' + str(error)) from error
        if run.returncode or not path.is_file():
            raise NoFixture('native defect preflight did not complete')
        report = json.loads(path.read_text())
        if any(not isinstance(report.get(key), list) for key in ('violations', 'schematic_parity', 'unconnected_items')):
            raise NoFixture('native defect preflight report is incomplete')
        return report, path

    baseline, _ = check('source')
    if baseline['schematic_parity'] or baseline['unconnected_items'] or any(r.get('severity') == 'error' for r in baseline['violations']):
        raise NoFixture('source is not a native-clean finished-board fixture')
    try:
        for index in range(8):
            native.write_bytes(original)
            try:
                injection, text = gap_candidate(native, exclude_nets=planes, rejected_ids=excluded, min_length_width=3)
            except ValueError as error:
                raise NoFixture(str(error)) from error
            native.write_text(text)
            report, evidence = check(index)
            choice, reasons = select_gap(native, report)
            valid = (not report['schematic_parity'] and
                     not any(row.get('severity') == 'error' for row in report['violations']) and
                     len(report['unconnected_items']) > len(baseline['unconnected_items']) and
                     choice is not None and choice.get('net') == injection['net'])
            if valid:
                injection.update(native_preflight=str(evidence), native_preflight_sha256=sha(evidence),
                                 native_open_count=len(report['unconnected_items']), excluded_plane_nets=sorted(planes))
                lean.atomic_json(output / 'rejected-injections.json', rejected)
                return injection
            rejected.append(dict(injection=injection, evidence=str(evidence), sha256=sha(evidence),
                                 native_open_count=len(report['unconnected_items']), repair_rejections=reasons))
            excluded.append(injection['removed_id'])
        raise NoFixture('eight bounded injections produced no independently verified repairable gap')
    except BaseException:
        native.write_bytes(original)
        lean.atomic_json(output / 'rejected-injections.json', rejected)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--board', default='ENV-SENSE')
    parser.add_argument('--compute', choices=('auto', 'cpu', 'metal'), default='metal')
    parser.add_argument('--timeout', type=int, default=300)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    workspace = output / 'checkout'
    sources = snapshot(root, workspace, args.board)
    native = board_config(workspace, args.board)[2].with_suffix('.kicad_pcb')
    try:
        injection = verified_gap(native, output, args.timeout)
    except NoFixture as error:
        preserved = all((root / name).is_file() and sha(root / name) == value for name, value in sources['files'].items()
                        if name.startswith('hardware-design/'))
        summary = dict(schema='iot-lab.engine-native-smoke.v1', status='blocked', board=args.board,
                       cause=str(error), shipping_sources_unchanged=preserved,
                       scope='no suitable verified defect fixture; engine comparison was not run')
        lean.atomic_json(output / 'summary.json', summary)
        print(json.dumps(summary), flush=True)
        return 2
    layer = child(_tree(_tokens(injection['original_segment']))[0], 'layer')[0]
    policy = dict(schema='iot-lab.engine-policy.v1',
        routing=dict(schema='iot-lab.routing-policy.v2', thermal_verification='native-checkback',
                     layers=[layer], only_nets=[injection['net']], passes=20, threads=2,
                     timeout_s=30, optimizer='if-routed', max_repairs=0),
        max_attempts=3, movement=dict(refs=[], max_displacement_mm=0, step_mm=.5),
        compute=args.compute, runtime='native' if sys.platform == 'darwin' else 'container')
    policy_path = workspace / 'engine-job.json'
    lean.atomic_json(policy_path, policy)
    lean.atomic_json(output / 'injection.json', injection)
    command = [sys.executable, str(workspace / 'tools/pcb'), 'route', args.board,
               '--router', 'engine', '--spec', str(policy_path), '--timeout', str(args.timeout),
               '--detach', '--json']
    start = subprocess.run(command, cwd=workspace, capture_output=True, text=True, timeout=30)
    (output / 'submit.log').write_text(start.stdout + start.stderr)
    if start.returncode:
        raise RuntimeError('engine submission failed: ' + start.stderr)
    run_id = json.loads(start.stdout)['run_id']
    folder = workspace / '.gate/cli' / run_id
    cursor = 0
    deadline = time.monotonic() + args.timeout + 60
    while True:
        if time.monotonic() > deadline:
            subprocess.run([sys.executable, str(workspace / 'tools/pcb'), 'cancel', run_id],
                           cwd=workspace, timeout=10, capture_output=True)
            raise RuntimeError('bounded native regression did not settle; cancellation requested')
        events = subprocess.run([sys.executable, str(workspace / 'tools/pcb'), 'events', run_id,
            '--after', str(cursor), '--wait', '20', '--json'], cwd=workspace,
            capture_output=True, text=True, timeout=30)
        if events.returncode:
            raise RuntimeError(events.stderr)
        rows = [json.loads(line) for line in events.stdout.splitlines() if line.strip()]
        if rows:
            cursor = rows[-1].get('cursor', cursor)
            print(json.dumps(dict(run_id=run_id, event=rows[-1].get('type'), cursor=cursor)), flush=True)
        result_path = folder / 'result.json'
        if result_path.is_file():
            break
        if not rows:
            observed = subprocess.run([sys.executable, str(workspace / 'tools/pcb'), 'status',
                run_id, '--json'], cwd=workspace, timeout=10, capture_output=True, text=True)
            state = json.loads(observed.stdout)
            if state['status'] in ('error', 'cancelled', 'timeout', 'failed'):
                raise RuntimeError(state.get('cause', 'engine stopped without a sealed result'))
    result = json.loads(result_path.read_text())
    operation = json.loads((folder / 'operation/result.json').read_text())
    engine = json.loads((folder / 'operation/engine/result.json').read_text())
    changed = [name for name, value in sources['files'].items()
               if not (root / name).is_file() or sha(root / name) != value]
    preserved = not any(name.startswith('hardware-design/') for name in changed)
    status = ('passed' if result['status'] == 'passed' and operation.get('candidate_verified') is True
              and engine.get('improved') is True and preserved else 'failed')
    summary = dict(schema='iot-lab.engine-native-smoke.v1', status=status, board=args.board,
                   run_id=run_id, run=str(folder), run_sha256=sha(result_path),
                   metrics=operation.get('metrics'), selected_strategy=engine.get('selected_strategy'),
                   shipping_sources_unchanged=preserved, compute_requested=args.compute,
                   parent_tooling_changes=[name for name in changed if not name.startswith('hardware-design/')],
                   execution_sources_unchanged=operation.get('source_unchanged'),
                   scope='native regression; no production adoption or general performance claim')
    lean.atomic_json(output / 'summary.json', summary)
    print(json.dumps(summary), flush=True)
    return 0 if status == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
