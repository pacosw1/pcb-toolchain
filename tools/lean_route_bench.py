#!/usr/bin/env python3
"""Bounded identical-input router-policy comparison; never qualifies a release."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import time

import lean_workflow as lean
import route_features


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('board')
    ap.add_argument('out')
    ap.add_argument('--board-name', required=True)
    ap.add_argument('--seconds', type=int, default=30)
    ap.add_argument('--passes', type=int, default=40)
    ap.add_argument('--threads', type=int, default=1)
    ap.add_argument('--route-args', default='')
    ap.add_argument('--order', choices=['AB', 'BA'], default='AB')
    a = ap.parse_args()
    if not 1 <= a.seconds <= 300 or a.threads <= 0 or a.passes <= 0:
        ap.error('positive passes/threads and 1–300 seconds per policy required')
    args = shlex.split(a.route_args)
    if any(v.split('=', 1)[0] in ('--optimizer', '--max-time', '--passes', '--threads', '--set') for v in args):
        ap.error('policy/budget controls cannot be overridden by route-args')
    board, out = Path(a.board).resolve(), Path(a.out).resolve()
    if out.exists() or board.parent == out or board.parent in out.parents:
        ap.error('comparison destination must be new and outside source CAD')
    features = route_features.load(str(board), a.board_name)
    source = out / 'input'
    shutil.copytree(board.parent, source, ignore=shutil.ignore_patterns('fab', '.gate', '*.kicad_prl'))
    for p in Path(features['_board_dir']).glob('*.json'):
        shutil.copy(p, source / p.name)
    gate = source / 'gate.json'
    config = json.loads(gate.read_text())
    config['route_features'] = {k: v for k, v in features.items() if not k.startswith('_')}
    lean.atomic_json(gate, config)
    feature_file = out / 'features.json'
    lean.atomic_json(feature_file, dict(features={k: v for k, v in features.items() if not k.startswith('_')}))
    env = dict(os.environ, ROUTE_FEATURES_FILE=str(feature_file))
    env.pop('ROUTE_BOARD', None)
    env.pop('ROUTE_FEATURES', None)
    router = Path(os.environ.get('FASTROUTE_BIN', str(Path.home() / 'opt/fastroute/fastroute-0.1.7-macos-arm64/fastroute')))
    paths = list(source.rglob('*')) + list(Path(__file__).parent.rglob('*.py')) + [router, feature_file]
    paths += [Path(v).resolve() for v in args if Path(v).is_file()]
    before = {str(p): lean.digest(p) for p in paths if p.is_file()}
    results = []
    policies = [('A', 'always'), ('B', 'if-routed')]
    if a.order == 'BA':
        policies.reverse()
    for name, policy in policies:
        cmd = [sys.executable, str(Path(__file__).parent / 'fastroute_job.py'), str(source / board.name), str(out / name),
               '--preflight', '--optimizer', policy, '--passes', str(a.passes), '--threads', str(a.threads),
               '--max-time', str(a.seconds)] + args
        started = time.monotonic()
        with open(out / f'{name}.log', 'w') as log:
            try:
                p = lean.run_stage(cmd, stage=name, event_file=str(out / 'stages.jsonl'),
                                   deadline=started+a.seconds+15, env=env, stdout=log, stderr=subprocess.STDOUT)
                rc = p.returncode
            except subprocess.TimeoutExpired:
                rc = 124
        outcome = out / name / 'outcome.json'
        results.append(dict(name=name, policy=policy, wall_s=time.monotonic()-started, returncode=rc,
                            outcome=json.loads(outcome.read_text()) if outcome.exists() else None))
    unchanged = all(Path(p).is_file() and lean.digest(p) == h for p, h in before.items())
    summary = dict(configuration=vars(a), fingerprints=before, unchanged=unchanged, results=results,
                   qualified=False, adoption=False,
                   note='screening comparison only; repetitions/full native board gates required before adoption')
    lean.atomic_json(out / 'comparison.json', summary)
    print(json.dumps({k: summary[k] for k in ('unchanged', 'results', 'qualified', 'adoption')}, indent=2))
    return 0 if unchanged and all(r['returncode'] == 0 for r in results) else 1


if __name__ == '__main__':
    sys.exit(main())
