"""Measure complete run outcomes; never substitute proxy route scores for gates."""
import json
from pathlib import Path


def summarize(folders):
    rows = []
    for folder in map(Path, folders):
        manifest = json.loads((folder / 'run.json').read_text())
        result = json.loads((folder / 'result.json').read_text())
        events = []
        path = folder / 'events.jsonl'
        if path.exists():
            events = [json.loads(line) for line in path.read_text().splitlines() if line]
        notes = []
        path = folder / 'notes.jsonl'
        if path.exists():
            notes = [json.loads(line) for line in path.read_text().splitlines() if line]
        completed = result.get('status') == 'passed' and result.get('cleanup', {}).get('complete') is True
        verified_evidence = False
        try:
            from pcb_evidence import verify
            verify(folder)
            verified_evidence = True
        except (OSError, ValueError):
            pass
        gate_scope = result.get('scope') in ('configured_board_gate', 'candidate_board_gate')
        gate_valid = False
        gate = folder / 'gate/result.json'
        if gate.exists():
            receipt = json.loads(gate.read_text())
            gate_valid = (receipt.get('exit') == 0 and receipt.get('changedDuringRun') is False and
                          receipt.get('provenance', {}).get('input_sha256') == result.get('input_sha256'))
        comparable_input = result.get('source_sha256') or result.get('input_sha256')
        row = dict(run_id=folder.name, board=manifest['board'], operation=manifest.get('operation', 'check'),
                   scope=result.get('scope'), status=result['status'], input_sha256=comparable_input,
                   elapsed_s=result.get('elapsed_s'), child_cpu_s=result.get('child_cpu_s'),
                   cpu_scope=result.get('cpu_scope'), evidence_verified=verified_evidence,
                   time_to_configured_targets_s=(result.get('elapsed_s') if completed and gate_scope and gate_valid and verified_evidence else None),
                   cache_hits=sum(e.get('type') == 'cache.hit' for e in events),
                   completed_checks=sum(e.get('type') == 'check.end' and e.get('status') in ('passed','failed') for e in events),
                   blocked_checks=sum(e.get('type') == 'check.end' and e.get('status') == 'blocked' for e in events),
                   error_checks=sum(e.get('type') == 'check.end' and e.get('status') == 'error' for e in events),
                   recorded_interventions=sum(n.get('kind') == 'intervention' for n in notes),
                   recorded_rework=sum(n.get('kind') == 'rework' for n in notes),
                   intervention_coverage='explicit_notes_only', evidence=str(folder))
        rows.append(row)
    comparable = (len(rows) > 1 and all(r['input_sha256'] and r['input_sha256'] == rows[0]['input_sha256']
                                     and r['scope'] == rows[0]['scope'] and r['board'] == rows[0]['board'] for r in rows))
    return dict(schema_version=1, runs=rows, comparable=comparable,
                comparison_reason=('matching recorded source and compliance scope' if comparable else
                                   'comparison requires at least two runs with matching source fingerprints, board and scope'),
                qualification='observed_run_metrics; no whole-board speed or bench qualification inferred')
