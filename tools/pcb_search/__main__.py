"""Run cheap placement or routing on a frozen JSON model; never edit CAD."""
import argparse
import json
from pathlib import Path

import lean_workflow as lean
from .contracts import Problem, fingerprint
from .patterns import route_patterns


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('mode', choices=('place', 'route'))
    ap.add_argument('input')
    ap.add_argument('--output', required=True)
    ap.add_argument('--budget-s', required=True, type=float)
    ap.add_argument('--steps-mm', type=float, nargs='+', help='placement search steps, not clearance rules')
    a = ap.parse_args()
    source, dest = Path(a.input), Path(a.output)
    if dest.exists() or source.resolve() == dest.resolve():
        ap.error('output must be new and separate from input')
    raw = json.loads(source.read_text())
    before = fingerprint(raw)
    if a.mode == 'route':
        result = route_patterns(Problem.read(raw), budget_s=a.budget_s)
    else:
        from .placement import quench
        if set(raw) != {'problem', 'attachments', 'params'}:
            ap.error('placement input requires problem, attachments and params')
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


if __name__ == '__main__':
    raise SystemExit(main())
