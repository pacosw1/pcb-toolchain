#!/usr/bin/env python3
"""Replay a frozen-board defect repair through the real CLI in an isolated copy.

Uses current ENV-SENSE geometry, all configured gates and its semantic checks.
An injected C1 placement defect is repaired to the original native pose. This
is a workflow regression, never a release or measured board qualification.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from decimal import Decimal, InvalidOperation

import lean_owned
import lean_workflow as lean
import pcb_operations as operations
from pcb_workflow import board_config, sha

ROOT = Path(__file__).resolve().parent.parent
BOARD = 'ENV-SENSE'
CASES = ('detect_injected_placement_defect', 'repair_with_fresh_configured_gates',
         'reject_candidate_tamper', 'adopt_named_frozen_defect', 'preserve_shipping_sources')


def read(path):
    return json.loads(Path(path).read_text())


def inject(project, output):
    """Native worker: only move C1; preserve the real board's rules and copper."""
    import pcbnew as p
    path = Path(project).with_suffix('.kicad_pcb')
    board = p.LoadBoard(str(path))
    fp = board.FindFootprintByReference('C1')
    if fp is None or fp.IsLocked():
        raise ValueError('regression requires existing unlocked ENV-SENSE C1')
    pose = [p.ToMM(fp.GetPosition().x), p.ToMM(fp.GetPosition().y), fp.GetOrientationDegrees()]
    before = sha(path)
    # Deliberately disconnected test specimen, not an engineering threshold.
    fp.Move(p.VECTOR2I(p.FromMM(3), 0))
    p.SaveBoard(str(path), board)
    lean.atomic_json(output / 'repair.json', dict(place=dict(C1=pose)))
    lean.atomic_json(output / 'injection.json', dict(ref='C1', original_pose=pose,
        injected_offset_mm=[3, 0], original_sha256=before, injected_sha256=sha(path)))


def native_contract(folder, expected):
    result = read(folder / 'result.json')
    gate = read(folder / 'gate/result.json')
    findings = read(folder / 'gate/findings.json')
    if result.get('status') != expected or not result.get('cleanup', {}).get('complete'):
        raise ValueError('regression run did not settle with expected verdict')
    if gate.get('changedDuringRun') or gate.get('preflightErrors') or not findings.get('inputs_valid'):
        raise ValueError('regression has invalid/missing native inputs')
    if not {'erc', 'drc'}.issubset(findings.get('completed_checks', [])):
        raise ValueError('regression did not execute both native checks')
    if gate.get('cache', {}).get('enabled') is not False or gate.get('cache', {}).get('hits') != 0:
        raise ValueError('real-board regression requires fresh native evidence')
    if expected == 'passed':
        if gate.get('exit') != 0 or not findings.get('complete'):
            raise ValueError('repair lacks complete configured gate evidence')
        if any(gate.get('metrics', {}).get(key) != 0 for key in ('erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected')):
            raise ValueError('repair native electrical/parity/connectivity targets failed')
    return result, gate, findings


def preserved_layout(source, candidate):
    """Independently check every native pose and all retained track/via forms."""
    from pcb_search.block_bindings import footprints
    from placer.dru import _tree, _tokens

    def signature(path):
        poses = {fp['props']['Reference']: (fp['pose'][0], fp['pose'][1], (fp['pose'][2] + 360) % 360)
                 for fp in footprints(path)}

        def normalized(form):
            if isinstance(form, list):
                return [normalized(value) for value in form]
            try:
                value = Decimal(form)
                return str(value.normalize()) if value.is_finite() else form
            except InvalidOperation:
                return form

        copper = sorted(json.dumps(normalized(form)) for form in _tree(_tokens(Path(path).read_text()))[0][1:]
                        if isinstance(form, list) and form and form[0] in ('segment', 'arc', 'via'))
        return poses, copper

    before, after = signature(source), signature(candidate)
    if before[0] != after[0]:
        raise ValueError('repair did not restore every original native footprint pose')
    if before[1] != after[1]:
        raise ValueError('repair changed retained native copper')
    return dict(footprint_poses_checked=len(before[0]), retained_copper_items_checked=len(before[1]),
                copper_sha256=hashlib.sha256(json.dumps(before[1]).encode()).hexdigest())


def cancel_and_settle(runs, workspace, timeout=10):
    """Settle this replay's detached CLI supervisors through their own handles.

    The follower's owned process group excludes the intentionally detached run
    supervisor. Cancellation therefore uses its durable run directory, never a
    discovered PID or a broad process search.
    """
    import pcb_cli
    pending, observations, errors = {}, {}, []
    for folder in sorted(Path(runs).glob('run-*')):
        try:
            if folder.is_symlink() or not folder.is_dir() or not pcb_cli.RUN_ID.fullmatch(folder.name):
                raise ValueError('unexpected run directory')
            manifest = read(folder / 'run.json')
            if manifest.get('run_id') != folder.name or Path(manifest.get('root', '')).resolve() != workspace.resolve():
                raise ValueError('run does not belong to the isolated replay checkout')
            observations[folder.name] = dict(cancellation_requested=False)
            pending[folder.name] = folder
        except (OSError, ValueError, KeyError, TypeError) as error:
            errors.append(folder.name + ': ' + str(error))
    deadline = time.monotonic() + timeout
    while pending:
        for name, folder in list(pending.items()):
            try:
                state = pcb_cli.status(folder)
                observation = observations[name]
                observation['status'] = state['status']
                if state.get('controller_alive') is False and state['status'] in pcb_cli.TERMINAL:
                    observation['cleanup'] = state.get('cleanup')
                    if not (state.get('cleanup') or {}).get('complete'):
                        errors.append(name + ': ' + state.get('cause', 'run cleanup unconfirmed'))
                    del pending[name]
                elif not observation['cancellation_requested']:
                    lean.atomic_json(folder / 'cancel.request', dict(reason='real-board replay settling owned run'))
                    observation['cancellation_requested'] = True
            except (OSError, ValueError, KeyError, TypeError) as error:
                observations[name]['observation_error'] = str(error)
        if not pending:
            break
        if time.monotonic() >= deadline:
            errors.extend(name + ': detached supervisor did not settle within cleanup budget' for name in pending)
            break
        time.sleep(min(.1, max(0, deadline - time.monotonic())))
    return dict(complete=not errors, runs=observations, errors=errors)


def run(args):
    output = args.output.resolve()
    if (ROOT == output or output in ROOT.parents
            or any(output.is_relative_to(ROOT / name) for name in ('tools', 'hardware-design'))):
        raise ValueError('evidence directory overlaps source inputs')
    output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    deadline = lean.deadline_after(args.timeout, {})
    summary = dict(schema='iot-lab.real-board-regression.v1', status='failed', board=BOARD,
        scope='real-board workflow regression in isolated copy; no release or qualification',
        expected_cases=list(CASES), cases=[], skipped=0)
    canonical = None
    counter = 0
    workspace, runs = output / 'checkout', output / 'runs'
    signals = (signal.SIGTERM, signal.SIGINT)

    def interrupted(signum, frame):
        raise lean.StageCancelled(signum)

    prior = {sig: signal.signal(sig, interrupted) for sig in signals}

    def invoke(label, command, expected=0):
        nonlocal counter
        counter += 1
        log = output / f'{counter:02d}-{label}.log'
        print('START: ' + label, file=sys.stderr, flush=True)
        proc, cleanup = None, None
        try:
            with log.open('wb') as stream:
                proc = lean_owned.prepare(command, dict(cwd=ROOT, env=dict(os.environ), stdin=subprocess.DEVNULL,
                    stdout=stream, stderr=subprocess.STDOUT))
                proc.start()
                proc.activate()
                heartbeat = time.monotonic()
                while True:
                    if lean.remaining(deadline) <= 0:
                        raise TimeoutError('real-board regression deadline reached: ' + label)
                    try:
                        proc.communicate(timeout=min(.1, lean.remaining(deadline)))
                        cleanup = proc.last_cleanup
                        break
                    except subprocess.TimeoutExpired:
                        if time.monotonic() - heartbeat >= 5:
                            print('ALIVE: ' + label + '; progress unknown; evidence=' + str(log), file=sys.stderr, flush=True)
                            heartbeat = time.monotonic()
        finally:
            cleanup_handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in signals}
            try:
                if proc:
                    cleanup = cleanup if cleanup is not None else proc.cleanup()
                    if not proc.close() or not cleanup.get('complete'):
                        raise ValueError(label + ': owned cleanup unconfirmed')
            finally:
                for sig, handler in cleanup_handlers.items():
                    signal.signal(sig, handler)
        if proc.returncode != expected:
            raise ValueError(f'{label}: expected exit {expected}, got {proc.returncode}; evidence={log}')
        return log

    def passed(case, **evidence):
        summary['cases'].append(dict(case=case, status='passed', **evidence))
        print('PASS: ' + case, file=sys.stderr, flush=True)

    try:
        canonical = operations.source_state(ROOT, BOARD)
        summary['shipping_inputs'] = canonical
        operations.snapshot(ROOT, workspace, BOARD)
        _, _, project = board_config(workspace, BOARD)
        target = project.with_suffix('.kicad_pcb')
        protected = operations.pcb_identity(target)
        invoke('inject-placement-defect', [args.python, str(Path(__file__).resolve()), '_inject', str(project), str(output)])
        if operations.pcb_identity(target) != protected:
            raise ValueError('injection changed protected board identity')
        injected = target.read_bytes()
        cli = [args.python, str(workspace / 'tools/pcb_cli.py')]

        def command(label, arguments, expected=0):
            common = ['--runs-dir', str(runs), '--json']
            if arguments[0] in ('check', 'edit'):
                common += ['--timeout', str(max(.1, lean.remaining(deadline) - 1))]
            log = invoke(label, cli + arguments + common, expected)
            return read_last_json(log)

        baseline = command('detect-native-defect', ['check', BOARD, '--fresh'], 1)
        baseline_dir = runs / baseline['run_id']
        _, _, findings = native_contract(baseline_dir, 'failed')
        defect = next((f for f in findings['findings'] if f['stage'] == 'drc' and f['severity'] == 'error'
                       and ('C1' in f.get('refs', []) or any('C1' in i.get('description', '') for i in f.get('items', [])))), None)
        if not defect:
            raise ValueError('injected C1 defect was not found in real native DRC')
        passed(CASES[0], run_id=baseline['run_id'], defect=defect['id'], rule=defect['rule'])
        repaired = command('repair-original-placement', ['edit', BOARD, '--kind', 'place', '--spec', str(output / 'repair.json')])
        candidate_dir = runs / repaired['run_id']
        _, _, repaired_findings = native_contract(candidate_dir, 'passed')
        receipt = read(candidate_dir / 'operation/result.json')
        candidate = Path(receipt['candidate'])
        if not receipt.get('candidate_verified') or not receipt.get('identity_preserved') or not receipt.get('source_unchanged'):
            raise ValueError('CLI did not verify a preserved isolated repair')
        if target.read_bytes() != injected or operations.pcb_identity(candidate) != protected:
            raise ValueError('repair mutated canonical specimen or protected board constraints')
        if any(f['id'] == defect['id'] for f in repaired_findings['findings']):
            raise ValueError('named native defect was not resolved')
        _, _, original_project = board_config(ROOT, BOARD)
        preserved = preserved_layout(original_project.with_suffix('.kicad_pcb'), candidate)
        # Both existing board-specific semantic checks must really have executed.
        for name in ('board-semantic-0.log', 'board-semantic-1.log', 'board-check.json'):
            if not (candidate_dir / 'operation' / name).is_file():
                raise ValueError('missing ENV-SENSE semantic evidence: ' + name)
        passed(CASES[1], run_id=repaired['run_id'], candidate_sha256=sha(candidate), preserved_layout=preserved)
        candidate_bytes = candidate.read_bytes()
        candidate.write_bytes(candidate_bytes + b'\n; regression tamper\n')
        try:
            rejected = command('reject-tampered-candidate', ['adopt', repaired['run_id'], '--baseline', baseline['run_id'], '--defect', defect['id']], 2)
            if 'evidence changed' not in rejected.get('cause', ''):
                raise ValueError('adoption rejected for a reason other than the injected evidence tamper')
            if target.read_bytes() != injected:
                raise ValueError('rejected adoption changed canonical specimen')
            passed(CASES[2], cause=rejected.get('cause', rejected.get('error')), evidence='candidate hash mismatch')
        finally:
            candidate.write_bytes(candidate_bytes)
        adopted = command('adopt-verified-repair', ['adopt', repaired['run_id'], '--baseline', baseline['run_id'], '--defect', defect['id']])
        if target.read_bytes() != candidate_bytes or (candidate_dir / 'backup' / target.name).read_bytes() != injected:
            raise ValueError('adoption did not preserve exact candidate/backup bytes')
        if adopted.get('before_sha256') != hashlib.sha256(injected).hexdigest() or adopted.get('after_sha256') != sha(target):
            raise ValueError('adoption receipt does not bind before/after native bytes')
        passed(CASES[3], adoption=adopted)
        if operations.source_state(ROOT, BOARD) != canonical:
            raise ValueError('shipping source inputs changed during real-board regression')
        passed(CASES[4], source_sha256=canonical['sha256'])
        summary.update(status='passed', cause='real frozen-board defect detected, repaired, freshly checked and adopted only in isolated copy')
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, KeyError, TypeError, StopIteration, KeyboardInterrupt) as error:
        summary['cause'] = str(error)
    finally:
        for sig in signals:
            signal.signal(sig, signal.SIG_IGN)
        try:
            summary['run_cleanup'] = cancel_and_settle(runs, workspace)
            if not summary['run_cleanup']['complete']:
                summary.update(status='failed', cause='owned CLI cleanup unconfirmed: ' + '; '.join(summary['run_cleanup']['errors']))
            summary['elapsed_s'] = round(time.monotonic() - started, 3)
            try:
                summary['shipping_sources_unchanged'] = canonical is not None and operations.source_state(ROOT, BOARD) == canonical
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyError, TypeError) as error:
                summary.update(shipping_sources_unchanged=False, source_check_error=str(error))
            if not summary['shipping_sources_unchanged']:
                summary.update(status='failed', cause='shipping source inputs changed or could not be verified during regression')
            summary['evidence'] = {str(p.relative_to(output)): sha(p) for p in sorted(output.rglob('*')) if p.is_file()
                                   and 'checkout' not in p.relative_to(output).parts and 'workspace' not in p.relative_to(output).parts}
            lean.atomic_json(output / 'summary.json', summary)
        finally:
            for sig, handler in prior.items():
                signal.signal(sig, handler)
    return summary


def read_last_json(log):
    return json.loads(Path(log).read_text().splitlines()[-1])


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == '_inject':
        inject(Path(argv[1]), Path(argv[2]))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--python', default=os.environ.get('KICAD_PYTHON', sys.executable))
    parser.add_argument('--timeout', type=float, default=180)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error('--timeout must be finite and positive')
    try:
        result = run(args)
    except (OSError, ValueError) as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(result) if args.json else ('PASS: ' if result['status'] == 'passed' else 'FAIL: ') + result['cause'])
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
