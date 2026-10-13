"""Export a fresh native placement model and attributed DRC evidence, without CAD edits.

Run with KiCad Python and numpy. The output is benchmark evidence, not a release
certificate. Every existing board-specific gate remains required for adoption.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('board')
    ap.add_argument('outdir')
    ap.add_argument('--drc-seconds', required=True, type=float)
    ap.add_argument('--cli', default='kicad-cli')
    ap.add_argument('--block-binding', action='append', default=[], help='exact hierarchical block binding JSON')
    ap.add_argument('--movable-ref', action='append', help='limit movement to these exact references; select entire rigid units')
    ap.add_argument('--decap-tie-mm', type=float, default=0., help='explicit decoupler grouping distance from board policy')
    ap.add_argument('--max-displacement-mm', type=float, help='search movement cap, not an electrical tolerance')
    ap.add_argument('--no-rotate', action='store_true')
    args = ap.parse_args()
    if not 0 < args.drc_seconds < float('inf'):
        ap.error('finite positive DRC budget required')
    if not 0 <= args.decap_tie_mm < float('inf'):
        ap.error('finite nonnegative decoupler grouping distance required')
    if args.max_displacement_mm is not None and not 0 < args.max_displacement_mm < float('inf'):
        ap.error('finite positive movement cap required')
    board, out = Path(args.board).resolve(), Path(args.outdir).resolve()
    sources = [board.with_suffix(ext) for ext in ('.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch')]
    if any(not p.is_file() for p in sources):
        ap.error('native board, project, rules and schematic are all required')
    before = {p.name: digest(p) for p in sources}
    out.mkdir(parents=True, exist_ok=False)
    record = dict(schema='iot-lab.native-export.v1', qualified=False, inputs=before,
                  board=str(board), source_mutated=False, board_specific_gates_required=True)
    try:
        import pcbnew
        from placer.kicad_io import read_problem
        from .placement import screen_pose
        from placer import cost
        record['kicad_version'] = pcbnew.GetBuildVersion()
        bindings = [json.loads(Path(p).read_text()) for p in args.block_binding]
        if bindings:
            from .block_bindings import verify_binding
            for binding in bindings:
                verify_binding(binding)
                if Path(binding['target']).resolve() != board:
                    raise ValueError('block binding targets another board')
        start = time.monotonic()
        cmd = [args.cli, 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--severity-all', '--format', 'json',
               '--units', 'mm', '-o', str(out/'drc.json'), str(board)]
        record['drc_command'] = cmd
        try:
            proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.drc_seconds)
        except subprocess.TimeoutExpired as error:
            record.update(status='timeout', reason='native DRC deadline', drc_elapsed_s=time.monotonic()-start)
            (out/'drc.log').write_text(str(error))
            return 3
        (out/'drc.log').write_text(proc.stdout + proc.stderr)
        record.update(drc_returncode=proc.returncode, drc_elapsed_s=time.monotonic()-start)
        if proc.returncode or not (out/'drc.json').is_file():
            record.update(status='native_error', reason='native DRC did not produce a complete report')
            return 3
        drc = json.loads((out/'drc.json').read_text())
        if any(not isinstance(drc.get(k),list) for k in ('violations','unconnected_items','schematic_parity')):
            raise ValueError('incomplete native DRC report')
        errors = [v for v in drc['violations'] if v['severity'] == 'error']
        record['native'] = dict(errors=len(errors), unconnected=len(drc['unconnected_items']),
                                parity=len(drc['schematic_parity']),
                                error_types=sorted({v['type'] for v in errors}))
        record['drc_sha256'] = digest(out/'drc.json')
        # Existing native faults stop before expensive search. Opens alone are
        # expected on a routing input and are not a geometry rejection.
        if errors or drc['schematic_parity']:
            record.update(status='reject', reason='native input geometry/rules or schematic parity fail')
            return 3
        problem = read_problem(str(board), decap_tie=args.decap_tie_mm)
        if bindings:
            from .block_bindings import attach_to_units
            problem = attach_to_units(problem, bindings)
            record['block_bindings'] = problem['block_bindings']
        from .native_placement import restrict_movement
        restrict_movement(problem, args.movable_ref, no_rotate=args.no_rotate)
        params = {} if args.max_displacement_mm is None else dict(max_displacement=args.max_displacement_mm)
        payload = dict(problem=problem, params=params, attachments=[])
        record['movement_policy'] = dict(movable_refs=args.movable_ref, decap_tie_mm=args.decap_tie_mm,
            max_displacement_mm=args.max_displacement_mm, no_rotate=args.no_rotate)
        (out/'placement.json').write_text(json.dumps(payload, indent=2))
        record['placement_sha256'] = digest(out/'placement.json')
        record['screen'] = screen_pose(problem, cost.initial_pose(problem), params)
        ready = record['screen']['status'] == 'candidate'
        status = 'candidate' if ready else ('needs_native_check' if record['screen']['status'] == 'needs_native_check' else 'model_rejected')
        record.update(status=status, units=len(problem['units']), nets=len(problem['nets']))
        if not ready:
            record['reason'] = 'native input and placement model require reconciliation before search'
        return 0 if ready else 3
    except Exception as error:
        record.update(status='error', reason=type(error).__name__ + ': ' + str(error))
        return 2
    finally:
        record['source_mutated'] = before != {p.name: digest(p) for p in sources}
        if record['source_mutated']:
            record.update(status='reject', reason='source changed during native export')
        record['artifacts'] = {p.name: digest(p) for p in sorted(out.iterdir()) if p.is_file()}
        (out/'record.json').write_text(json.dumps(record, indent=2, sort_keys=True))
        print(('PASS' if record.get('status') == 'candidate' else 'STUCK') + ': native export ' +
              record.get('status', 'error') + '; ' + record.get('reason', 'proposal inputs only; full gates required'))
        if record['source_mutated']:
            return 3


if __name__ == '__main__':
    raise SystemExit(main())
