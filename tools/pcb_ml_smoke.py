#!/usr/bin/env python3
"""Actual native/router observations through the small-ML foundation.

Three deliberately tiny passive circuits exercise different net topologies.
Their separate families test partition wiring, not statistical generalisation.
No routing-quality improvement, production-board change or qualification is
claimed. All six ordinary G4 checks remain active on every routed candidate.
"""
import argparse
import collections
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys

import lean_workflow as lean
from pcb_workflow import sha


ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 'iot-lab.pcb-ml-native-proof.v1'
TOPOLOGIES = {'pairs': ('A', 'A', 'B', 'B'),
              'fork': ('A', 'A', 'A', 'B'),
              'bus': ('A', 'A', 'A', 'A')}
CHECKS = {'erc', 'drc', 'paths', 'viapads', 'kicad_happy', 'port_labels'}


def read(path):
    return json.loads(Path(path).read_text())


def fixture(output, topology):
    """Create actual electrical differences, not relabelled copies of a case."""
    import pcbnew as p
    import native_workflow_smoke as native
    from pcb_operations import pcb_identity
    from pcb_search.block_bindings import footprints
    from pcb_search.native_srj import source_set

    if p.Version() != '10.0.6':
        raise ValueError('native proof requires admitted pcbnew 10.0.6')
    names = TOPOLOGIES[topology]
    common = output / 'common'
    native.generate(common)
    path = common / 'fixture.kicad_pcb'
    board = p.LoadBoard(str(path))
    for track in list(board.GetTracks()):
        board.Delete(track)
    for zone in list(board.Zones()):
        board.Remove(zone)
    for fp in board.GetFootprints():
        index = int(fp.GetReference()[1:]) - 1
        net = names[index]
        for pad in fp.Pads():
            pad.SetNet(board.GetNetsByName()['/' + net])
        x, y = 5 + (index % 2) * 10, 5 + (index // 2) * 10
        for label, yy in ((net, y + 1.2), ('TEST PORT ' + fp.GetReference(), y - 2)):
            text = p.PCB_TEXT(board)
            text.SetText(label)
            text.SetPosition(p.VECTOR2I(p.FromMM(x), p.FromMM(yy)))
            text.SetLayer(p.F_SilkS)
            text.SetTextSize(p.VECTOR2I(p.FromMM(.8), p.FromMM(.8)))
            text.SetTextThickness(p.FromMM(.12))
            board.Add(text)
    p.SaveBoard(str(path), board)
    original = native.schematic()
    labels = list(re.finditer(r'\(label "[AB]"', original))
    if len(labels) != 4:
        raise ValueError('native fixture schematic labels are ambiguous')
    for index in reversed(range(4)):
        item = labels[index]
        original = original[:item.start()] + '(label "' + names[index] + '"' + original[item.end():]
    path.with_suffix('.kicad_sch').write_text(original)
    before = source_set(path)
    native.worker('move', path, output / 'alternative')
    alternative = output / 'alternative/candidate.kicad_pcb'
    if source_set(path) != before or pcb_identity(path) != pcb_identity(alternative):
        raise ValueError('deriving a placement changed electrical/mechanical identity')
    data = dict(topology=topology, nets=list(names), expected_opens=sum(n - 1 for n in collections.Counter(names).values()),
                arms=dict(baseline=str(path), alternative=str(alternative)),
                poses={arm: {fp['props']['Reference']: [float(v) for v in fp['pose']]
                             for fp in footprints(source)}
                       for arm, source in (('baseline', path), ('alternative', alternative))},
                source_inputs=before, qualified=False)
    lean.atomic_json(output / 'fixture.json', data)


def run(args):
    from pcb_test_fixture import workflow_runtime_files
    from real_board_regression import cancel_and_settle, native_contract
    from routing_trial_smoke import copy_runtime, wait_run

    output = args.output.resolve()
    if output.exists() or output == ROOT or output in ROOT.parents or any(
            output.is_relative_to(ROOT / name) for name in ('tools', 'hardware-design')):
        raise ValueError('proof needs a new owned evidence directory outside source files')
    output.mkdir(parents=True)
    context = Path(os.environ.get('PCB_EXECUTION_CONTEXT', '')).resolve()
    if not os.environ.get('PCB_EXECUTION_CONTEXT') or not context.is_file():
        raise ValueError('original read-only host Docker inspection is required')
    deadline = lean.deadline_after(args.timeout)
    started = lean.now()
    paths = set(workflow_runtime_files(ROOT / 'tools'))
    paths.update(ROOT / 'tools' / name for name in (
        'pcb_ml_smoke.py', 'native_workflow_smoke.py', 'routing_trial_smoke.py',
        'real_board_regression.py', 'pcb_test_fixture.py', 'pcbtool.py'))
    result = dict(schema=SCHEMA, status='failed', qualified=False, adopt_model=False,
                  cause='proof incomplete', cases=[], ml_runs=[], cleanup=[],
                  scope='synthetic actual-CAD/router and ML integration; no routing improvement or physical qualification',
                  execution_context=dict(path=str(context), sha256=sha(context)))
    workspaces = []
    counter = 0
    sources = {}

    def invoke(label, command, cwd=ROOT, expected=0):
        nonlocal counter
        counter += 1
        log = output / ('%02d-%s.log' % (counter, label))
        print('START: ' + label + '; evidence=' + str(log), file=sys.stderr, flush=True)
        with log.open('w') as handle:
            done = lean.run_stage(command, stage=label, deadline=deadline,
                event_file=output / 'stages.jsonl', cwd=cwd, env=dict(os.environ),
                stdout=handle, stderr=subprocess.STDOUT)
        if done.returncode != expected:
            raise ValueError(label + ': exit ' + str(done.returncode) + '; inspect ' + str(log))
        return log

    def cli(workspace, runs, label, argv):
        command = [args.python, str(workspace / 'tools/pcb_cli.py'), argv[0],
                   '--runs-dir', str(runs), '--json'] + argv[1:]
        log = invoke(label, command, cwd=workspace)
        return json.loads(log.read_text().splitlines()[-1])

    def operation(workspace, runs, label, argv, expected):
        admitted = cli(workspace, runs, label + '-admit',
                       [argv[0], '--timeout', str(args.run_timeout), '--detach'] + argv[1:])
        folder = runs / admitted['run_id']
        terminal = wait_run(folder, deadline, label)
        if terminal['status'] != expected:
            raise ValueError(label + ': expected ' + expected + ', got ' + terminal['status'] +
                             '; ' + str(terminal.get('cause')) + '; evidence=' + str(folder))
        return folder, terminal

    try:
        collector = ('import {gateTools} from ' + json.dumps((ROOT / 'tools/lib/gate-inputs.mjs').as_uri()) +
                     '; process.stdout.write(JSON.stringify(gateTools(' + json.dumps(str(ROOT)) + ')));')
        closure = invoke('actual-native-runtime', [os.environ.get('NODE', 'node'), '--input-type=module', '-e', collector])
        paths.update(Path(name).resolve() for name in json.loads(closure.read_text()))
        if any(not p.is_relative_to(ROOT / 'tools') or not p.is_file() for p in paths):
            raise ValueError('native runtime closure has missing or external files')
        sources = {str(p): sha(p) for p in sorted(paths)}
        routing_trials, workflow_trials = [], []
        for split, topology in zip(('train', 'validation', 'test'), TOPOLOGIES):
            family = 'SYNTHETIC-' + topology.upper()
            case_dir = output / topology
            invoke(topology + '-fixture', [args.python, str(Path(__file__).resolve()), '_fixture', str(case_dir), topology])
            raw = read(case_dir / 'fixture.json')
            case = dict(family=family, split=split, topology=topology, arms=[])
            result['cases'].append(case)
            selected = ['/' + net for net, count in collections.Counter(raw['nets']).items() if count > 1]
            for arm in ('baseline', 'alternative'):
                label = topology + '-' + arm
                workspace = case_dir / arm / 'checkout'
                runs = workspace / '.gate/cli'
                workspaces.append((workspace, runs))
                native = copy_runtime(workspace, paths)
                native.with_name('SPEC.md').write_text(
                    '# Synthetic passive ' + topology + '\n\n'
                    'Four one-pad passive test ports on a two-layer board. '
                    'J1-J4 nets are ' + ', '.join(raw['nets']) + '. '
                    'The original input has no tracks, vias or zones. '
                    'Only J2 moves between the two placement arms. '
                    'No energised supply paths or production qualification.\n')
                source = Path(raw['arms'][arm])
                for ext in ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru'):
                    shutil.copy2(source.with_suffix(ext), native.with_suffix(ext))
                before = {str(native.with_suffix(ext)): sha(native.with_suffix(ext)) for ext in
                          ('.kicad_pcb', '.kicad_sch', '.kicad_pro', '.kicad_dru')}
                policy = dict(schema='iot-lab.routing-policy.v1', layers=['F.Cu', 'B.Cu'],
                              only_nets=selected, passes=40, threads=1, timeout_s=30,
                              optimizer='if-routed', max_repairs=0)
                lean.atomic_json(workspace / 'policy.json', policy)
                initial, _ = operation(workspace, runs, label + '-preflight',
                                       ['check', 'TRIAL', '--fresh'], 'failed')
                _, gate, _ = native_contract(initial, 'failed')
                metrics = gate['metrics']
                if (set(gate['checks']) != CHECKS or metrics.get('drc_errors') != 0 or
                        metrics.get('drc_parity') != 0 or metrics.get('erc_errors') != 0 or
                        metrics.get('drc_unconnected') != raw['expected_opens'] or
                        any(row['status'] != ('failed' if name == 'drc' else 'passed')
                            for name, row in gate['checks'].items())):
                    raise ValueError(label + ': native preflight differs from declared passive opens')
                folder, terminal = operation(workspace, runs, label + '-route',
                    ['route', 'TRIAL', '--router', 'fastroute', '--spec', str(workspace / 'policy.json')], 'passed')
                native_contract(folder, 'passed')
                if any(sha(name) != digest for name, digest in before.items()):
                    raise ValueError(label + ': native source changed')
                row = dict(id=label, family=family, split=split, path=str(folder),
                           sha256=sha(folder / 'result.json'),
                           placement_input=dict(path=str(native), sha256=sha(native)),
                           execution_policy='operation/execution-policy.json')
                routing_trials.append(row)
                workflow_trials.extend(dict(id=label + '-' + kind, family=family, split=split,
                    path=str(path), sha256=sha(path / 'result.json'))
                    for kind, path in (('preflight', initial), ('route', folder)))
                case['arms'].append(dict(arm=arm, route=row, initial_check=str(initial),
                                         route_elapsed_s=terminal.get('elapsed_s')))

        workspace = workspaces[0][0]
        runs = workspace / '.gate/cli'
        for adapter, trials, target in (('routing', routing_trials, 'owned_elapsed_s'),
                                        ('workflow', workflow_trials, 'run_passed')):
            corpus = output / (adapter + '-corpus.json')
            lean.atomic_json(corpus, dict(schema='iot-lab.pcb-ml-corpus.v1',
                dataset_id='native-' + adapter, adapter=adapter, trials=trials))

            def ml(action, options):
                folder, _ = operation(workspace, runs, adapter + '-ml-' + action,
                    ['ml', action, 'native-' + adapter] + options, 'passed')
                report = read(folder / 'operation/report.json')
                if report.get('qualified') is not False or report.get('adopt_model') is not False:
                    raise ValueError('ML observation incorrectly grants qualification/adoption')
                result['ml_runs'].append(dict(adapter=adapter, action=action, run=str(folder),
                    terminal_sha256=sha(folder / 'result.json'), artifacts=report.get('artifacts')))
                return folder / 'operation'

            data_dir = ml('dataset', ['--manifest', str(corpus)])
            data_path = data_dir / 'dataset.json'
            model_dir = ml('train', ['--dataset', str(data_path), '--target', target, '--algorithm', 'ridge'])
            model_path = model_dir / 'model.json'
            ml('evaluate', ['--dataset', str(data_path), '--model', str(model_path)])
            sources_for_prediction = [row['placement_input'] if adapter == 'routing'
                                      else dict(path=str(Path(row['path']) / 'run.json'),
                                                sha256=sha(Path(row['path']) / 'run.json'))
                                      for row in trials if row['split'] == 'test']
            request = output / (adapter + '-features-request.json')
            lean.atomic_json(request, dict(schema='iot-lab.pcb-ml-features-request.v1',
                id='native-' + adapter, adapter=adapter,
                samples=[dict(id='candidate-' + str(i), source=source)
                         for i, source in enumerate(sources_for_prediction)]))
            features_dir = ml('features', ['--manifest', str(request)])
            prediction_dir = ml('predict', ['--model', str(model_path),
                '--features', str(features_dir / 'features.json')])
            predicted = read(prediction_dir / 'predictions.json')
            if predicted.get('qualified') is not False or predicted.get('adopt_model') is not False:
                raise ValueError('prediction incorrectly permits model/CAD adoption')
        result.update(status='passed', cause='actual native/router observations exported, trained, evaluated and scored through owned CLI runs',
                      route_trials=len(routing_trials), workflow_trials=len(workflow_trials),
                      generalisation_claim=False, performance_improvement_claim=False)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError,
            subprocess.SubprocessError, lean.StageCancelled) as error:
        result.update(status='failed', cause=str(error))
    finally:
        handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            for workspace, runs in workspaces:
                cleanup = cancel_and_settle(runs, workspace)
                result['cleanup'].append(dict(root=str(workspace), **cleanup))
                if not cleanup['complete']:
                    result.update(status='failed', cause='owned CLI cleanup is unconfirmed')
            if any(sha(name) != digest for name, digest in sources.items()):
                result.update(status='failed', cause='proof implementation changed during execution')
            result.update(elapsed_s=round(lean.now() - started, 3), source_inputs=sources)
            lean.atomic_json(output / 'summary.json', result)
        finally:
            for sig, handler in handlers.items():
                signal.signal(sig, handler)
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == '_fixture':
        fixture(Path(argv[1]).resolve(), argv[2])
        print('PASS: native passive topology and preserved alternative placement')
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--timeout', type=float, default=600)
    parser.add_argument('--run-timeout', type=float, default=120)
    parser.add_argument('--python', default=os.environ.get('KICAD_PYTHON', sys.executable))
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    if any(not math.isfinite(v) or v <= 0 for v in (args.timeout, args.run_timeout)):
        parser.error('finite positive operational deadlines required')
    def interrupted(signum, frame):
        raise lean.StageCancelled(signum)
    handlers = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        value = run(args)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    if args.json:
        print(json.dumps(value, allow_nan=False))
    else:
        print(('PASS' if value['status'] == 'passed' else 'FAIL') + ': ' + value['cause'])
    return 0 if value['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
