#!/usr/bin/env python3
"""Helpers of tools/route_bench.sh (2026-10-09).

  $PY tools/route_bench_report.py collect BOARD CONFIG REP SECS RC RUNDIR      one JSON line for results.jsonl
  python3 tools/route_bench_report.py report results.jsonl                    Markdown tables (board x config)

collect reads RUNDIR/gate-metrics.json (node tools/gate.mjs of the routed board), RUNDIR/gate-out/kicad_happy.log
(RP-001 lines), RUNDIR/routed.kicad_pcb (vias, track length; pcbnew) and the feature lines of the route logs
(ESCAPE, TRIAGE, RULES, VIAKEEP, VIA_HALO).
"""
import glob
import json
import os
import re
import statistics
import sys

KEYS = ['drc_unconnected', 'drc_errors', 'drc_parity', 'vias', 'viapads', 'rp001', 'kicad_happy_findings',
        'planes_failures', 'pairs_failures', 'paths_low', 'secs']
SHORT = {'drc_unconnected': 'unconn', 'drc_errors': 'DRC err', 'drc_parity': 'parity', 'vias': 'vias',
         'viapads': 'via-in-pad', 'rp001': 'RP-001', 'kicad_happy_findings': 'k-h total', 'planes_failures': 'planes',
         'pairs_failures': 'pairs', 'paths_low': 'paths', 'secs': 'time s'}


def collect(board, config, rep, secs, rc, d):
    row = {'board': board, 'config': config, 'rep': int(rep), 'secs': int(secs), 'rc': int(rc)}
    gm = os.path.join(d, 'gate-metrics.json')
    if os.path.isfile(gm):
        row.update(json.load(open(gm))['metrics'])
    kh = os.path.join(d, 'gate-out', 'kicad_happy.log')
    if os.path.isfile(kh):
        row['rp001'] = sum(1 for l in open(kh) if l.startswith('FAIL RP-001'))
    pcb = os.path.join(d, 'routed.kicad_pcb')
    if os.path.isfile(pcb):
        import pcbnew
        b = pcbnew.LoadBoard(pcb)
        row['vias'] = sum(1 for t in b.GetTracks() if t.GetClass() == 'PCB_VIA')
        row['track_mm'] = round(sum(t.GetLength() for t in b.GetTracks() if t.GetClass() != 'PCB_VIA') / 1e6)
    lines = {}
    for f in glob.glob(os.path.join(d, '**', '*.log'), recursive=True):
        for l in open(f, errors='replace'):
            m = re.match(r'(ESCAPE|TRIAGE|RULES|VIAKEEP|VIA_HALO) (.*)', l)
            if m:
                lines.setdefault(m.group(1), []).append(m.group(2).strip())
    row['features'] = {k: sorted(set(v)) for k, v in lines.items()}
    print(json.dumps(row))


def fmt(v):
    if v is None:
        return '-'
    return f'{v:g}' if isinstance(v, (int, float)) else str(v)


def report(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    boards = []
    for r in rows:
        if r['board'] not in boards:
            boards.append(r['board'])
    out = []
    for bd in boards:
        rs = [r for r in rows if r['board'] == bd]
        keys = [k for k in KEYS if any(k in r for r in rs)]
        configs = []
        for r in rs:
            if r['config'] not in configs:
                configs.append(r['config'])
        mean = {}
        for c in configs:
            for k in keys:
                vals = [r.get(k) for r in rs if r['config'] == c and r.get(k) is not None]
                mean[(c, k)] = statistics.mean(vals) if vals else None
        out.append(f'### {bd}\n')
        out.append('Each cell: run 1 / run 2 (delta of the mean vs base). ' +
                   'Lower is better for every column.\n')
        out.append('| config | ' + ' | '.join(SHORT[k] for k in keys) + ' |')
        out.append('|' + ' --- |' * (len(keys) + 1))
        for c in configs:
            cells = []
            for k in keys:
                vals = [fmt(r.get(k)) for r in sorted(rs, key=lambda x: x['rep']) if r['config'] == c]
                cell = ' / '.join(vals)
                if c != 'base' and mean.get((c, k)) is not None and mean.get(('base', k)) is not None and k != 'secs':
                    dlt = mean[(c, k)] - mean[('base', k)]
                    if abs(dlt) > 1e-9:
                        cell += f' ({dlt:+g})'
                cells.append(cell)
            rc = [r['rc'] for r in rs if r['config'] == c]
            out.append(f'| {c}{" (rc " + ",".join(map(str, rc)) + ")" if any(rc) else ""} | ' + ' | '.join(cells) + ' |')
        out.append('')
        feats = {}
        for r in rs:
            for k, v in r.get('features', {}).items():
                feats.setdefault((r['config'], k), set()).update(v[:6])
        if feats:
            out.append('Feature lines (from the route logs):\n')
            for (c, k), v in sorted(feats.items()):
                out.append(f'- {c} / {k}: ' + '; '.join(sorted(v))[:400])
            out.append('')
    print('\n'.join(out))


if __name__ == '__main__':
    if sys.argv[1] == 'collect':
        collect(*sys.argv[2:8])
    else:
        report(sys.argv[2])
