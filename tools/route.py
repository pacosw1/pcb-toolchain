#!/usr/bin/env python3
"""Route a board from its hardware-design/boards/<BOARD>/route.json (schema in tools/route_plan.py).

Run with KiCad's bundled Python (pcbnew), from the repo root:
  $PY tools/route.py BOARD OUTDIR [--input PLACED.kicad_pcb] [--backend fastroute|tracemaker] [--config route.json]

Each stage: copy the board, remove the stage's zones, add its keepouts, route (Fastroute: tools/fastroute_job.py;
TraceMaker: $TRACEMAKER_BIN, then only the new copper of the stage nets is kept), remove the keepouts, put the zones
back, and check the stage nets with kicad-cli DRC. The copper of a stage is locked for the next stage (both routers
keep existing copper). Then the pours are added and filled, and kicad-cli DRC with --schematic-parity runs.
Result: OUTDIR/<BOARD>.kicad_pcb with its sidecars, and OUTDIR/result.json. The input board is only read.
Exit 0 only when every stage check passes and DRC reports 0 errors, 0 unconnected and 0 parity.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pcbnew

import pcb_workflow
import route_plan as plan

ROOT = Path(__file__).resolve().parent.parent
KICAD_CLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
TRACEMAKER = os.environ.get('TRACEMAKER_BIN') or os.path.expanduser('~/opt/tracemaker/build/macos-metal/src/app/tracemaker')
TMP = 'TMP_ROUTE_'
SIDECARS = ('.kicad_pro', '.kicad_dru', '.kicad_sch')
STUCK_RC = 3


def copy_project(src, dst, sidecar_src=None):
    """Copy a board and the sidecars of sidecar_src (default: of src) next to dst."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(src, dst)
    base = Path(sidecar_src or src)
    for ext in SIDECARS:
        side = base.with_suffix(ext)
        if side.is_file():
            shutil.copy(side, dst.with_suffix(ext))


def copper_layers(board):
    return [board.GetLayerName(i) for i in board.GetEnabledLayers().CuStack()]


def net_names(board):
    return [str(n) for n in board.GetNetsByName().keys() if str(n)]


def rect(x0, y0, x1, y1):
    ps = pcbnew.SHAPE_POLY_SET()
    ps.NewOutline()
    for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        ps.Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
    return ps


def layer_set(board, names):
    ls = pcbnew.LSET()
    for name in names:
        ls.AddLayer(board.GetLayerID(name))
    return ls


def add_keepout(board, stage, ko):
    """Rule area: no tracks, vias or fills. 'outside' covers the board box grown by 5 mm minus the box."""
    if ko['mode'] == 'inside':
        ps = rect(*ko['box'])
    else:
        bb = board.GetBoardEdgesBoundingBox()
        ps = rect(pcbnew.ToMM(bb.GetX()) - 5, pcbnew.ToMM(bb.GetY()) - 5,
                  pcbnew.ToMM(bb.GetRight()) + 5, pcbnew.ToMM(bb.GetBottom()) + 5)
        ps.BooleanSubtract(rect(*ko['box']))
    z = pcbnew.ZONE(board)
    z.SetIsRuleArea(True)
    z.SetDoNotAllowTracks(True)
    z.SetDoNotAllowVias(True)
    z.SetDoNotAllowZoneFills(True)
    z.SetDoNotAllowPads(False)
    z.SetDoNotAllowFootprints(False)
    z.SetLayerSet(layer_set(board, ko['layers']))
    z.SetZoneName(f'{TMP}{stage["name"]}_{ko["name"]}')
    z.Outline().Append(ps)
    board.Add(z)


_REMOVED = []


def remove(board, item):
    """board.Remove() and keep the Python object alive: in KiCad 10.0.6, when Python frees a removed item, every
    later pcbnew call in the process returns a bare SwigPyObject (seen 2026-10-21 on FIELD-24V-BUS)."""
    board.Remove(item)
    _REMOVED.append(item)


def copper_ids(board):
    return {t.m_Uuid.AsString() for t in board.GetTracks()}


def vias_on(board, nets):
    return sum(1 for t in board.GetTracks() if t.GetClass() == 'PCB_VIA' and t.GetNetname() in nets)


def run(cmd, log, env=None):
    p = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, env=env)
    log.write_text(' '.join(str(c) for c in cmd) + '\n' + p.stdout + p.stderr)
    return p


def drc(pcb, out, parity):
    cmd = [KICAD_CLI, 'pcb', 'drc', '--refill-zones', '--severity-all', '--format', 'json', '--units', 'mm',
           '-o', out, pcb]
    if parity:
        cmd.insert(3, '--schematic-parity')
    run(cmd, Path(str(out) + '.log'))
    if not Path(out).is_file():
        raise SystemExit(f'route: kicad-cli DRC wrote no report for {pcb}')
    return json.loads(Path(out).read_text())


def route_fastroute(stage, src, work, board_id, features):
    env = dict(os.environ, ROUTE_BOARD=board_id, ROUTE_FEATURES=features)
    p = run([sys.executable, ROOT / 'tools/fastroute_job.py', src, work] + plan.fastroute_args(stage),
            work.parent / 'router.log', env)
    routed = work / 'routed.kicad_pcb'
    # Exit 3 = connections left open: the stage check below decides. Any other failure stops the run.
    if p.returncode not in (0, STUCK_RC) or not routed.is_file():
        raise SystemExit(f'route: stage {stage["name"]}: fastroute_job exit {p.returncode}, see {work.parent}/router.log')
    return routed


def route_tracemaker(stage, src, work, board_id, copper):
    if not Path(TRACEMAKER).is_file():
        raise SystemExit(f'route: TraceMaker binary not found: {TRACEMAKER} (set TRACEMAKER_BIN)')
    work.mkdir(parents=True, exist_ok=True)
    routed = work / 'routed.kicad_pcb'
    p = run(plan.tracemaker_args(stage, copper, TRACEMAKER, src, routed, work / 'summary.json'),
            work.parent / 'router.log')
    # TraceMaker exits non-zero when connections stay open; the stage check decides.
    if not routed.is_file():
        raise SystemExit(f'route: stage {stage["name"]}: TraceMaker exit {p.returncode}, no board written')
    return routed


def run_stage(i, stage, current, outdir, backend, board_id, name, features=''):
    d = outdir / f'{i + 1}-{stage["name"]}'
    src = d / 'in' / f'{name}.kicad_pcb'
    copy_project(current, src)
    text, removed = plan.split_zones(Path(current).read_text(), stage['remove_zones'])
    src.write_text(text)
    b = pcbnew.LoadBoard(str(src))
    copper = copper_layers(b)
    for ko in stage['keepouts']:
        add_keepout(b, stage, ko)
    pcbnew.SaveBoard(str(src), b)
    kept = plan.kept_nets(stage, net_names(b))
    tm_kept = plan.tracemaker_kept(stage, net_names(b))
    before_ids, before_vias = copper_ids(b), vias_on(b, kept)
    if backend == 'fastroute':
        routed = route_fastroute(stage, src, d / 'router', board_id, features)
    else:
        routed = route_tracemaker(stage, src, d / 'router', board_id, copper)
    b = pcbnew.LoadBoard(str(routed))
    for z in list(b.Zones()):
        if z.GetZoneName().startswith(TMP):
            remove(b, z)
    new_vias = vias_on(b, kept) - before_vias  # the removal below drops only copper of nets that are not kept
    dropped = 0
    if backend == 'tracemaker':
        for t in list(b.GetTracks()):
            if t.m_Uuid.AsString() not in before_ids and t.GetNetname() not in tm_kept:
                remove(b, t)
                dropped += 1
    out = d / f'{name}.kicad_pcb'
    copy_project(routed, out, sidecar_src=src)
    pcbnew.SaveBoard(str(out), b)
    out.write_text(plan.add_blocks(out.read_text(), removed))
    report = drc(out, d / 'drc.json', parity=False)
    opens = plan.open_nets(report)
    failures = plan.stage_failures(stage, opens, new_vias)
    return out, {'stage': stage['name'], 'open_on_stage_nets': sum(1 for n in opens if n in kept),
                 'open_total': len(opens), 'new_vias_on_stage_nets': new_vias, 'dropped_other_net_items': dropped,
                 'failures': failures}


def outline(board):
    ps = pcbnew.SHAPE_POLY_SET()
    if not board.GetBoardPolygonOutlines(ps, False):  # False: do not infer an outline
        raise SystemExit('route: the board outline (Edge.Cuts) is not closed')
    return ps


def add_pour(board, pour):
    layer = board.GetLayerID(pour['layer'])
    net = board.FindNet(pour['net'])
    if net is None:
        raise SystemExit(f'route: pour {pour["name"]}: no net {pour["net"]}')
    if pour['shape'] == 'board':
        ps = outline(board)
    else:
        ps = pcbnew.SHAPE_POLY_SET()
        for fp in board.GetFootprints():
            for p in fp.Pads():
                if p.GetNetname() == pour['net'] and p.IsOnLayer(layer):
                    p.TransformShapeToPolygon(ps, layer, 0, pcbnew.FromMM(0.01), pcbnew.ERROR_INSIDE)
        for t in board.GetTracks():
            if t.GetNetname() == pour['net'] and (t.GetLayer() == layer or t.GetClass() == 'PCB_VIA'):
                t.TransformShapeToPolygon(ps, layer, 0, pcbnew.FromMM(0.01), pcbnew.ERROR_INSIDE)
        if not ps.OutlineCount():
            return False  # the route put no copper of this net on this layer; result.json lists the pour
        ps.Inflate(pcbnew.FromMM(pour['grow_mm']), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, pcbnew.FromMM(0.05))
        ps.BooleanIntersection(outline(board))
        ps.Simplify()
    for x0, y0, x1, y1 in pour['minus']:
        box = pcbnew.SHAPE_POLY_SET()
        box.NewOutline()
        for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
            box.Append(pcbnew.FromMM(x), pcbnew.FromMM(y))
        ps.BooleanSubtract(box)
    z = pcbnew.ZONE(board)
    z.SetLayerSet(layer_set(board, [pour['layer']]))
    z.SetZoneName(pour['name'])
    z.SetAssignedPriority(pour['priority'])
    z.SetNet(net)
    z.SetMinThickness(pcbnew.FromMM(0.25))
    z.SetLocalClearance(pcbnew.FromMM(pour['clearance_mm']))
    z.SetThermalReliefGap(pcbnew.FromMM(pour['thermal_gap_mm']))
    z.SetThermalReliefSpokeWidth(pcbnew.FromMM(pour['spoke_mm']))
    z.SetPadConnection(pcbnew.ZONE_CONNECTION_FULL if pour['connection'] == 'full' else pcbnew.ZONE_CONNECTION_THERMAL)
    z.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    z.Outline().Append(ps)
    board.Add(z)
    return True


def set_widths(board, rules):
    """Count of tracks per width rule that get the rule width (route_plan.width_applies)."""
    counts = {r['name']: 0 for r in rules}
    for t in board.GetTracks():
        if t.GetClass() == 'PCB_VIA':
            continue
        ends = [(pcbnew.ToMM(p.x), pcbnew.ToMM(p.y)) for p in (t.GetStart(), t.GetEnd())]
        for r in rules:
            if plan.width_applies(r, *ends, board.GetLayerName(t.GetLayer()), pcbnew.ToMM(t.GetWidth())):
                t.SetWidth(pcbnew.FromMM(r['width_mm']))
                counts[r['name']] += 1
    return counts


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('board')
    ap.add_argument('outdir')
    ap.add_argument('--input', help='placed board to route (default: the project board from gate.json)')
    ap.add_argument('--config', default='route.json', help='file name in the board folder')
    ap.add_argument('--backend', choices=plan.BACKENDS, help='override the backend of route.json')
    a = ap.parse_args()
    folder, _, project = pcb_workflow.board_config(ROOT, a.board)
    source = Path(a.input).resolve() if a.input else project.with_suffix('.kicad_pcb')
    cfg = json.loads((folder / a.config).read_text())
    outdir = Path(a.outdir).resolve()
    if outdir.exists() and any(outdir.iterdir()):
        raise SystemExit(f'route: {outdir} is not empty')
    name = project.name
    start = outdir / 'input' / f'{name}.kicad_pcb'
    copy_project(source, start, sidecar_src=project.with_suffix('.kicad_pcb'))
    known = json.loads((ROOT / 'tools/route-features.json').read_text())['features']
    p = plan.load(cfg, copper_layers(pcbnew.LoadBoard(str(start))), known_features=set(known))
    if p['features'] and (a.backend or p['backend']) != 'fastroute':
        raise SystemExit('route: features are Fastroute switches; the tracemaker backend cannot apply them')
    backend = a.backend or p['backend']
    current, stages = start, []
    for i, stage in enumerate(p['stages']):
        current, record = run_stage(i, stage, current, outdir, backend, a.board, name, plan.feature_env(p))
        stages.append(record)
        print(json.dumps(record), flush=True)
        if record['failures']:
            break
    result = {'board': a.board, 'backend': backend, 'source': str(source), 'stages': stages}
    failures = [f for s in stages for f in s['failures']]
    if not failures:
        final = outdir / f'{name}.kicad_pcb'
        copy_project(current, final, sidecar_src=start)
        b = pcbnew.LoadBoard(str(final))
        result['widths'] = set_widths(b, p['widths'])
        skipped = [pour['name'] for pour in p['pours'] if not add_pour(b, pour)]
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
        pcbnew.SaveBoard(str(final), b)
        if '(stackup' in start.read_text():
            # pcbnew may rewrite the stackup on save; the input stackup is the design value.
            final.write_text(plan.copy_block(start.read_text(), final.read_text(), '(stackup'))
        for ext in SIDECARS:
            shutil.copy(start.with_suffix(ext), final.with_suffix(ext))
        d = drc(final, outdir / 'drc.json', parity=True)
        errors = [v for v in d.get('violations', []) if v.get('severity') == 'error']
        result.update(board_file=str(final), pours=len(p['pours']) - len(skipped), skipped_pours=skipped,
                      drc_errors=len(errors),
                      unconnected=len(plan.open_nets(d)), parity=len(d.get('schematic_parity', [])),
                      error_types=sorted({v['type'] for v in errors}))
        if result['drc_errors'] or result['unconnected'] or result['parity']:
            failures.append(f'final DRC: {result["drc_errors"]} errors, {result["unconnected"]} unconnected, '
                            f'{result["parity"]} parity')
    result['failures'] = failures
    (outdir / 'result.json').write_text(json.dumps(result, indent=1) + '\n')
    print(json.dumps({k: result.get(k) for k in ('board', 'backend', 'drc_errors', 'unconnected', 'parity', 'failures')}))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
