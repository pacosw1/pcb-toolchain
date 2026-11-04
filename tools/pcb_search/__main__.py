"""Run cheap placement or capacity routing on a frozen JSON model; never edit CAD.

Cheap pattern routing is `pcbsearch route` (core/).
"""
import argparse
import json
from pathlib import Path
import sys

import lean_workflow as lean
from .contracts import fingerprint


def run():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('mode', choices=('place', 'route-srj'))
    ap.add_argument('input')
    ap.add_argument('--output', required=True)
    ap.add_argument('--budget-s', required=True, type=float)
    ap.add_argument('--steps-mm', type=float, nargs='+', help='placement search steps, not clearance rules')
    ap.add_argument('--backend', choices=('quench', 'packing'), default='quench', help='placement proposal backend')
    ap.add_argument('--rotation-quarters', type=int, nargs='+', default=[0], help='allowed packing rotations')
    ap.add_argument('--pipeline', choices=('topology', 'fanout', 'reuse'), default='topology', help='capacity SRJ pipeline')
    ap.add_argument('--capture-stages', action='store_true', help='retain unqualified local/stitch geometry for diagnosis')
    a = ap.parse_args()
    if a.mode != 'place' and a.backend != 'quench':
        ap.error('--backend applies only to placement')
    if a.capture_stages and a.mode != 'route-srj':
        ap.error('--capture-stages applies only to route-srj')
    source, dest = Path(a.input), Path(a.output)
    if dest.exists() or source.resolve() == dest.resolve():
        ap.error('output must be new and separate from input')
    raw = json.loads(source.read_text())
    before = fingerprint(raw)
    if a.mode == 'route-srj':
        from .capacity import run as route_capacity
        result = route_capacity(raw, budget_s=a.budget_s, pipeline=a.pipeline, capture_stages=a.capture_stages)
    else:
        from .placement import quench
        if set(raw) != {'problem', 'attachments', 'params'}:
            ap.error('placement input requires problem, attachments and params')
        if a.backend == 'packing':
            from .packing import propose
            result = propose(raw['problem'], budget_s=a.budget_s, params=raw['params'],
                             attachments=raw['attachments'], rotations=a.rotation_quarters)
        else:
            result = quench(raw['problem'], steps_mm=a.steps_mm, budget_s=a.budget_s,
                            params=raw['params'], attachments=raw['attachments'])
    if before != fingerprint(json.loads(source.read_text())):
        raise ValueError('input changed during computation; result not saved')
    result['source_sha256'] = before
    implementation = list(Path(__file__).parent.glob('*.py'))
    implementation += [Path(lean.__file__)]
    if a.mode == 'place':
        from placer import cost
        implementation += [Path(cost.__file__)]
    result['implementation_sha256'] = fingerprint({str(p.relative_to(Path(__file__).parents[1])): lean.digest(p)
        for p in sorted(implementation)})
    lean.atomic_json(dest, result)
    unresolved = len(result.get('unresolved', []))
    complete = result['status'] == 'candidate' and unresolved == 0
    print(f"{'PASS' if complete else 'STUCK'}: {a.mode} {result['status']}; "
          f"{unresolved} unresolved; proposal only, native validation required; {dest}")
    return 0 if complete else 3


def main():
    try:
        return run()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
