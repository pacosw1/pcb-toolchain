#!/usr/bin/env python3
"""One synthetic, controlled native-placement/real-router development pair.

This exercises the owned CLI and existing outcome observer. It is not a ranking
benchmark, holdout, shipping-board experiment, release or qualification. No
production proxy is substituted when the actual scorer is unavailable.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import lean_workflow as lean
from pcb_workflow import sha


ROOT = Path(__file__).resolve().parent.parent
BOARD = 'TRIAL'
SCHEMA = 'iot-lab.routing-trial-smoke.v1'
POLICY = dict(schema='iot-lab.routing-policy.v1', layers=['F.Cu', 'B.Cu'],
              only_nets=['/A'], passes=40, threads=1, timeout_s=30,
              optimizer='if-routed', max_repairs=0)
REQUIRED_CHECKS = {'erc', 'drc', 'paths', 'viapads', 'kicad_happy', 'port_labels'}


def read(path):
    return json.loads(Path(path).read_text())


def native_fixture(output):
    """Native-only worker; create a common task before either pose is derived."""
    import pcbnew as p
    import native_workflow_smoke as native
    from pcb_operations import pcb_identity
    from pcb_search.block_bindings import footprints
    from pcb_search.native_candidate import copper_items
    from pcb_search.native_srj import source_set
    from placer.dru import _tree, _tokens

    if p.Version() != '10.0.6':
        raise ValueError('fixture requires admitted pcbnew 10.0.6')
    common = output / 'common'
    native.generate(common)
    source = common / 'fixture.kicad_pcb'
    original = source_set(source)
    board = p.LoadBoard(str(source))
    removed = [track for track in board.GetTracks() if track.GetNetname() == '/A']
    if len(removed) != 1 or removed[0].GetClass() != 'PCB_TRACK':
        raise ValueError('fixture must contain exactly one removable /A segment')
    removed_id = removed[0].m_Uuid.AsString()
    board.Delete(removed[0])
    # These J references are deliberate one-pin test ports. Give each port an
    # actual net label and a distinct title; do not exempt it from the normal
    # connector-label checker. The common labels are retained by both poses.
    labels = []
    for index in range(4):
        ref, net = 'J' + str(index + 1), 'A' if index < 2 else 'B'
        x, y = 5 + (index % 2) * 10, 5 + (index // 2) * 10
        for text, yy in ((net, y + 1.2), ('TEST PORT ' + ref, y - 2.0)):
            item = p.PCB_TEXT(board)
            item.SetText(text)
            item.SetPosition(p.VECTOR2I(p.FromMM(x), p.FromMM(yy)))
            item.SetLayer(p.F_SilkS)
            item.SetTextSize(p.VECTOR2I(p.FromMM(.8), p.FromMM(.8)))
            item.SetTextThickness(p.FromMM(.12))
            board.Add(item)
            labels.append(dict(ref=ref, text=text, layer='F.SilkS', at_mm=[x, yy]))
    # Routing refills zones. Start both specimens with the same explicitly
    # filled retained /B zone, so SaveBoard cannot first introduce `(fill yes)`
    # inside the protected policy during the routing transaction.
    filler = p.ZONE_FILLER(board)
    filler.Fill(board.Zones())
    fills = [dict(net=zone.GetNetname(), layer='F.Cu',
                  filled_outline_count=zone.GetFilledPolysList(p.F_Cu).OutlineCount())
             for zone in board.Zones()]
    if len(fills) != 1 or fills[0]['net'] != '/B' or fills[0]['filled_outline_count'] <= 0:
        raise ValueError('common synthetic /B zone did not acquire a native filled cache')
    p.SaveBoard(str(source), board)
    saved_zones = [form for form in _tree(_tokens(source.read_text()))[0][1:]
                   if isinstance(form, list) and form and form[0] == 'zone']
    if len(saved_zones) != 1 or not any(
            isinstance(form, list) and form[:2] == ['fill', 'yes'] for form in saved_zones[0]):
        raise ValueError('common native source did not retain the explicit filled-zone policy')
    common_inputs = source_set(source)
    moved = output / 'moved'
    native.worker('move', source, moved)
    transaction = read(moved / 'transaction.json')
    if transaction.get('moved_refs') != ['J2'] or not transaction.get('production_identity_preserved'):
        raise ValueError('existing native placement guard did not prove J2-only movement')

    def copper(path):
        text, items = copper_items(path)
        return {uid: _tree(_tokens(text[slice(*row['span'])]))[0] for uid, row in items.items()}

    retained = copper(source)
    if len(retained) != 1 or any(row['net'] != '/B' for row in copper_items(source)[1].values()):
        raise ValueError('common task did not retain exactly the original /B segment')
    sources, poses = {}, {}
    for arm, path in (('baseline', source), ('alternative', moved / 'candidate.kicad_pcb')):
        if copper(path) != retained or pcb_identity(path) != pcb_identity(source):
            raise ValueError('pair differs in protected native identity or retained copper')
        poses[arm] = {fp['props']['Reference']: [float(v) for v in fp['pose']] for fp in footprints(path)}
        sources[arm] = dict(path=str(path), files=source_set(path))
    expected = dict(baseline=[15.0, 5.0, 0.0], alternative=[14.0, 5.0, 0.0])
    if any(poses[arm]['J2'] != expected[arm] for arm in expected):
        raise ValueError('actual pair poses differ from the declared synthetic specimen')
    if any(poses['baseline'][ref] != poses['alternative'][ref] for ref in ('J1', 'J3', 'J4')):
        raise ValueError('a protected fixture footprint moved')
    if source_set(source) != common_inputs:
        raise ValueError('deriving the alternative mutated the common source')
    value = dict(schema='iot-lab.routing-trial-fixture.v1', status='passed', qualified=False,
                 scope='synthetic routing task; no manufacturer or engineering qualification',
                 pcbnew_version=p.Version(), original_inputs=original, common_inputs=common_inputs,
                 initial_native_fill=dict(status='passed', before_pose_derivation=True,
                                          retained_zone_caches=fills, saved_fill_enabled=True),
                 common_port_labels=labels,
                 removed_item=removed_id, selected_nets=['/A'], arms=sources, poses=poses,
                 retained_copper_ids=sorted(retained), placement_transaction=transaction,
                 proxy_cost=None, proxy_rank=None,
                 proxy_unknown='production scorer requires NumPy; no substitute proxy or ranking is claimed')
    lean.atomic_json(output / 'fixture.json', value)


def preflight_report(folder):
    """Full fresh gate: the one expected open is input, never a final waiver."""
    from real_board_regression import native_contract
    from native_workflow_smoke import drc_counts
    _, gate, findings = native_contract(folder, 'failed')
    if (gate.get('exit') != 1 or set(gate.get('checks', {})) != REQUIRED_CHECKS
            or set(findings.get('completed_checks', [])) != REQUIRED_CHECKS
            or findings.get('complete') is not True):
        raise ValueError('initial configured gate did not execute all six mandatory checks')
    expected = dict(erc_errors=0, drc_errors=0, drc_parity=0, drc_unconnected=1,
                    paths_low=0, viapads=0, kicad_happy_findings=0, port_label_failures=0)
    if any(gate.get('metrics', {}).get(name) != value for name, value in expected.items()):
        raise ValueError('initial configured gate has a failure beyond the deliberately unrouted /A connection')
    if any(row.get('status') != ('failed' if name == 'drc' else 'passed')
           for name, row in gate['checks'].items()):
        raise ValueError('initial configured checker status is invalid')
    errors = [row for row in findings['findings'] if row.get('severity') not in ('warning', 'info')]
    if (len(errors) != 1 or errors[0].get('stage') != 'drc'
            or errors[0].get('evidence', {}).get('pointer') != '/unconnected_items/0'
            or set(errors[0].get('nets', [])) != {'/A'}
            or {(row['ref'], row['pad']) for row in errors[0].get('pads', [])} != {('J1', '1'), ('J2', '1')}):
        raise ValueError('initial configured finding is not exactly the declared /A endpoint gap')
    erc, drc = folder / 'gate/erc.json', folder / 'gate/drc.json'
    counts = drc_counts(drc)
    if counts['errors'] or counts['parity'] or counts['unconnected'] != 1:
        raise ValueError('initial specimen must be native-legal with exactly one intentionally unrouted connection')
    opens = read(drc)['unconnected_items']
    items = opens[0].get('items', [])
    if len(items) != 2 or not all('[/A]' in row.get('description', '') for row in items):
        raise ValueError('initial open is not attributable to the deliberately removed /A segment')
    return dict(status='passed', run_id=folder.name, expected_verdict='failed',
                terminal=dict(path=str(folder / 'result.json'), sha256=sha(folder / 'result.json')),
                complete_configured_gate=True, configured_checks=sorted(REQUIRED_CHECKS),
                expected_finding=errors[0], metrics=gate['metrics'], native=counts,
                expected_input_opens=1, final_required_opens=0,
                erc=dict(path=str(erc), sha256=sha(erc)), drc=dict(path=str(drc), sha256=sha(drc)))


def copy_runtime(target, paths):
    for source in paths:
        destination = target / 'tools' / source.relative_to(ROOT / 'tools')
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    (target / 'FOCUS.md').write_text(
        '# FOCUS: isolated TRIAL\n\nGoal: one synthetic routing/control proof.\n\n'
        '## Frozen\n\nNone; this is an explicitly synthetic test specimen.\n\n'
        '## Done when\n\nBoth declared input poses have attributed real solver and fresh configured gate outcomes.\n\n'
        '## Not now\n\nShipping CAD, release, purchasing, ranking claims and weight adoption.\n')
    folder = target / 'hardware-design/boards' / BOARD
    folder.mkdir(parents=True)
    lean.atomic_json(folder / 'gate.json', dict(project='fixture', stage='G4',
        checks=dict(erc=True, drc=True, paths='current-paths.json', viapads=dict(allow=[]),
                    kicad_happy={}, port_labels=True),
        about='Synthetic native/router development specimen; every configured check remains required.'))
    lean.atomic_json(folder / 'current-paths.json', dict(nets={}, about=(
        'Synthetic passive continuity specimen: all four embedded symbol pins are passive; '
        '/A and /B have no declared energized supply, voltage or operating current. '
        'No power-path capacity is claimed. Actual netlist supply coverage remains enabled; '
        'a detected uncovered supply is a failure. No supply exemption is declared.')))
    (folder / 'SPEC.md').write_text(
        '# Synthetic TRIAL\n\nFour passive one-pad footprints, two nets and a 20 mm square test outline.\n'
        'Policy comes from native_workflow_smoke.generate; it is not a manufacturing threshold.\n'
        '/A is intentionally disconnected before routing; /B copper and zone are retained.\n'
        'All four embedded pins are passive; this specimen has no energized supply or current requirement.\n'
        'The six required G4 checks execute normally, with no exemptions: native ERC/DRC, actual netlist supply\n'
        'coverage, via-in-pad, the pinned kicad-happy analyses, and real per-port labels/titles.\n'
        'No parts, stock, fabrication, assembly or bench qualification is claimed.\n')
    return folder / 'fixture.kicad_pcb'


def wait_run(folder, deadline, label):
    import pcb_cli
    heartbeat = lean.now()
    while True:
        if lean.remaining(deadline) <= 0:
            raise TimeoutError('routing trial total deadline reached: ' + label)
        state = pcb_cli.status(folder)
        if state['status'] in pcb_cli.TERMINAL and state.get('controller_alive') is False:
            if not (folder / 'result.json').is_file():
                raise ValueError('owned run settled without its terminal result: ' + str(folder))
            return read(folder / 'result.json')
        if lean.now() - heartbeat >= 5:
            print('ALIVE: ' + label + '; status=' + state['status'] + '; evidence=' + str(folder),
                  file=sys.stderr, flush=True)
            heartbeat = lean.now()
        time.sleep(min(.2, max(0, lean.remaining(deadline))))


def run(args):
    from pcb_test_fixture import workflow_runtime_files
    from real_board_regression import cancel_and_settle, native_contract
    import placement_outcomes

    output = args.output.resolve()
    if output == ROOT or output in ROOT.parents or any(output.is_relative_to(ROOT / name) for name in ('tools', 'hardware-design')):
        raise ValueError('new evidence directory must not overlap repository source inputs')
    context = Path(os.environ.get('PCB_EXECUTION_CONTEXT', '')).resolve()
    if not os.environ.get('PCB_EXECUTION_CONTEXT') or not context.is_file():
        raise ValueError('actual read-only container execution context is required')
    output.mkdir(parents=True, exist_ok=False)
    deadline = lean.deadline_after(args.timeout)
    started = lean.now()
    paths = set(workflow_runtime_files(ROOT / 'tools'))
    paths.update(ROOT / 'tools' / name for name in ('routing_trial_smoke.py', 'native_workflow_smoke.py',
        'real_board_regression.py', 'placement_outcomes.py', 'pcb_test_fixture.py', 'pcbtool.py'))
    sources = {str(path): sha(path) for path in sorted(paths)}
    result = dict(schema=SCHEMA, status='failed', board=BOARD, qualified=False,
        scope='one synthetic actual-router development pair; no ranking, holdout, release or physical qualification',
        cause='proof incomplete', arms=[], source_inputs=sources,
        execution_context=dict(path=str(context), sha256=sha(context)),
        proxy_cost=None, proxy_rank=None, proxy_unknown='actual production scorer unavailable; no substitute',
        comparative_readiness=False, adopt_weights=False, run_cleanup=[], skipped=0)
    workspaces = []
    counter = 0

    def invoke(label, command, cwd=ROOT, env=None, expected=0):
        nonlocal counter
        counter += 1
        log = output / ('%02d-%s.log' % (counter, label))
        print('START: ' + label + '; evidence=' + str(log), file=sys.stderr, flush=True)
        with log.open('w') as stream:
            done = lean.run_stage(command, stage=label, event_file=output / 'stages.jsonl',
                deadline=deadline, cwd=cwd, env=env or dict(os.environ), stdout=stream, stderr=subprocess.STDOUT)
        if done.returncode != expected:
            raise ValueError(label + ': expected exit ' + str(expected) + ', got ' + str(done.returncode) + '; evidence=' + str(log))
        return log

    def cli(workspace, runs, label, arguments):
        command = [args.python, str(workspace / 'tools/pcb_cli.py'), arguments[0],
                   '--runs-dir', str(runs), '--json'] + arguments[1:]
        log = invoke(label, command, cwd=workspace,
                     env=dict(os.environ, IOT_LAB=str(workspace), KICAD_CLI=args.cli,
                              KICAD_PYTHON=args.python, PYTHON_MODERN=args.python,
                              PYTHONDONTWRITEBYTECODE='1'))
        return json.loads(log.read_text().splitlines()[-1])

    try:
        # The cheap CPU fixture deliberately substitutes pcbtool and a fake
        # native executable. This proof instead adds the actual gate's own
        # transitive script/module closure, including real pcbtool and its
        # file-loaded helpers. Reuse the production collector, not a fake gate.
        collector = ('import {gateTools} from ' + json.dumps((ROOT / 'tools/lib/gate-inputs.mjs').as_uri()) +
                     '; process.stdout.write(JSON.stringify(gateTools(' + json.dumps(str(ROOT)) + ')));')
        closure = invoke('actual-gate-runtime-closure',
                         [os.environ.get('NODE', 'node'), '--input-type=module', '-e', collector])
        paths.update(Path(name).resolve() for name in json.loads(closure.read_text()))
        if any(not path.is_relative_to(ROOT / 'tools') or not path.is_file() for path in paths):
            raise ValueError('actual gate runtime closure has a missing or external source')
        sources.update({str(path): sha(path) for path in sorted(paths)})
        invoke('generate-native-pair', [args.python, str(Path(__file__).resolve()), '_fixture', str(output)])
        fixture = read(output / 'fixture.json')
        result['fixture'] = dict(path=str(output / 'fixture.json'), sha256=sha(output / 'fixture.json'))
        for arm in ('baseline', 'alternative'):
            workspace = output / arm / 'checkout'
            runs = workspace / '.gate/cli'
            workspaces.append((workspace, runs))
            native = copy_runtime(workspace, paths)
            source = Path(fixture['arms'][arm]['path'])
            for extension in ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'):
                shutil.copy2(source.with_suffix(extension), native.with_suffix(extension))
            policy = workspace / 'policy.json'
            lean.atomic_json(policy, POLICY)
            before = {str(native.with_suffix(ext)): sha(native.with_suffix(ext)) for ext in
                      ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru')}
            cycle = cli(workspace, runs, arm + '-cycle-start',
                        ['cycle', 'start', BOARD, '--owner', 'routing-trial-smoke'])['cycle_id']
            row = dict(arm=arm, cycle_id=cycle, root=str(workspace), status='preflight',
                       input=dict(path=str(native), sha256=sha(native)), native_inputs=before,
                       poses=fixture['poses'][arm], policy=dict(path=str(policy), sha256=sha(policy)),
                       proxy_cost=None, proxy_rank=None)
            result['arms'].append(row)
            if lean.remaining(deadline) <= args.run_timeout:
                raise TimeoutError('insufficient remaining total budget for the declared input-check deadline')
            checked = cli(workspace, runs, arm + '-full-input-check', ['check', BOARD, '--fresh',
                '--timeout', str(args.run_timeout), '--detach', '--cycle', cycle])
            check_folder = runs / checked['run_id']
            row['preflight_run'] = dict(run_id=check_folder.name, path=str(check_folder))
            wait_run(check_folder, deadline, arm + '-input-check')
            row['initial_native_legality'] = preflight_report(check_folder)
            if any(sha(name) != digest for name, digest in before.items()):
                raise ValueError('initial native check mutated an input')
            if lean.remaining(deadline) <= args.run_timeout:
                raise TimeoutError('insufficient remaining total budget for the same declared per-arm deadline')
            admitted = cli(workspace, runs, arm + '-route-admit', ['route', BOARD, '--router', 'fastroute',
                '--spec', str(policy), '--timeout', str(args.run_timeout), '--detach', '--cycle', cycle])
            folder = runs / admitted['run_id']
            row.update(status='running', run_id=folder.name, run_directory=str(folder))
            terminal = wait_run(folder, deadline, arm)
            row.update(status=terminal['status'], terminal=dict(path=str(folder / 'result.json'), sha256=sha(folder / 'result.json')),
                       elapsed_s=terminal.get('elapsed_s'), timing=terminal.get('timing'), cause=terminal.get('cause'))
            cycle_summary = cli(workspace, runs, arm + '-cycle-finish', ['cycle', 'finish', cycle])
            lean.atomic_json(output / arm / 'cycle-summary.json', cycle_summary)
            row['cycle_summary'] = dict(path=str(output / arm / 'cycle-summary.json'), sha256=sha(output / arm / 'cycle-summary.json'))
            if (cycle_summary.get('evidence_issues') or len(cycle_summary.get('runs', [])) != 2
                    or not all(link.get('evidence_verified') for link in cycle_summary.get('runs', []))):
                raise ValueError('cycle contains stale or unsealed owned run evidence')
            if terminal.get('status') != 'passed':
                raise ValueError(arm + ': first real solver/native failure; ' + str(terminal.get('cause')))
            native_contract(folder, 'passed')
            operation = read(folder / 'operation/result.json')
            if not operation.get('candidate_verified') or not operation.get('identity_preserved') or not operation.get('source_unchanged'):
                raise ValueError('route lacks existing preserved-source candidate verification')
            if any(sha(name) != digest for name, digest in before.items()):
                raise ValueError('route changed its canonical synthetic input')
            row['candidate'] = dict(path=operation['candidate'], sha256=sha(operation['candidate']))
        study = dict(schema=placement_outcomes.STUDY, study_id='synthetic-routing-producer-pair',
            arms=['baseline', 'alternative'], development_families=['SYNTHETIC-FOUR-PAD'], holdout_families=[],
            trials=[dict(id=row['arm'] + '-1', kind='cli_run', path=row['run_directory'], sha256=row['terminal']['sha256'],
                arm=row['arm'], split='development', family='SYNTHETIC-FOUR-PAD', case='common-A-gap', replicate=1,
                placement_input=row['input'], execution_policy='operation/execution-policy.json') for row in result['arms']])
        lean.atomic_json(output / 'study.json', study)
        observed = placement_outcomes.evaluate_study(ROOT, output / 'study.json')
        lean.atomic_json(output / 'observations.json', observed)
        result['observation'] = dict(path=str(output / 'observations.json'), sha256=sha(output / 'observations.json'))
        rows = observed['observations']
        if (len(rows) != 2 or not all(row.get('evidence_valid') and row.get('full_gate_success') for row in rows)
                or not rows[0].get('case_fingerprint') or rows[0]['case_fingerprint'] != rows[1].get('case_fingerprint')
                or not rows[0].get('policy_fingerprint') or rows[0]['policy_fingerprint'] != rows[1].get('policy_fingerprint')):
            raise ValueError('actual pair lacks identical attributed case and execution-policy controls; inspect observations.json')
        if observed['comparative_readiness'] is not False or observed['qualified'] is not False or observed['adopt_weights'] is not False:
            raise ValueError('one development pair incorrectly acquired broader comparative/qualification status')
        result.update(status='passed', cause='two distinct native-legal inputs completed real routing and fresh configured gates under matching controls',
            case_fingerprint=rows[0]['case_fingerprint'], policy_fingerprint=rows[0]['policy_fingerprint'],
            comparative_blockers=observed['blockers'])
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.SubprocessError, KeyboardInterrupt) as error:
        result.update(status='failed', cause=str(error) or type(error).__name__)
    finally:
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            for workspace, runs in workspaces:
                cleanup = cancel_and_settle(runs, workspace)
                result['run_cleanup'].append(dict(root=str(workspace), **cleanup))
                if not cleanup['complete']:
                    result.update(status='failed', cause='owned trial CLI cleanup unconfirmed; inspect run_cleanup')
            for row in result['arms']:
                if row.get('run_directory'):
                    terminal = Path(row['run_directory']) / 'result.json'
                    if terminal.is_file():
                        settled = read(terminal)
                        row.update(status=settled['status'],
                                   terminal=dict(path=str(terminal), sha256=sha(terminal)),
                                   elapsed_s=settled.get('elapsed_s'), timing=settled.get('timing'),
                                   cause=settled.get('cause'))
            try:
                unchanged = all(sha(name) == digest for name, digest in sources.items())
                unchanged = unchanged and sha(context) == result['execution_context']['sha256']
            except OSError as error:
                unchanged = False
                result['source_check_error'] = str(error)
            if not unchanged:
                result['integrity_failure'] = 'proof source or actual execution context changed during trial'
                if result['status'] == 'passed':
                    result['cause'] = result['integrity_failure']
                result['status'] = 'failed'
            result['elapsed_s'] = round(lean.now() - started, 3)
            result['artifacts'] = {str(path.relative_to(output)): sha(path) for path in sorted(output.rglob('*'))
                if path.is_file() and 'checkout' not in path.relative_to(output).parts and path.name != 'summary.json'}
            lean.atomic_json(output / 'summary.json', result)
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == '_fixture':
        native_fixture(Path(argv[1]).resolve())
        print('PASS: synthetic common task and guarded distinct poses; no routing or qualification')
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=300)
    parser.add_argument('--run-timeout', type=float, default=120)
    parser.add_argument('--python', default=os.environ.get('KICAD_PYTHON', sys.executable))
    parser.add_argument('--cli', default=os.environ.get('KICAD_CLI', 'kicad-cli'))
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    if any(not math.isfinite(value) or value <= 0 for value in (args.timeout, args.run_timeout)):
        parser.error('finite positive operational deadlines required')
    def interrupted(signum, frame):
        raise lean.StageCancelled(signum)
    handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        try:
            result = run(args)
        except (OSError, ValueError, RuntimeError) as error:
            print('STUCK: ' + str(error), file=sys.stderr)
            return 2
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    path = args.output.resolve() / 'summary.json'
    compact = dict(schema=SCHEMA, status=result['status'], cause=result['cause'], qualified=False,
                   arms=[dict(arm=row['arm'], status=row['status'], run_id=row.get('run_id')) for row in result['arms']],
                   comparative_readiness=False, adopt_weights=False, summary=dict(path=str(path), sha256=sha(path)))
    print(json.dumps(compact) if args.json else
          ('PASS: ' if result['status'] == 'passed' else 'STUCK: ') + result['cause'] + '; evidence=' + str(path))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
