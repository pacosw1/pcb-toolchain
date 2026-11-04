"""Independent check: our board geometry against KiCad's own pcbnew (in the isolated worker) on every iot-lab board.

Compared per board: pad position, orientation, size, shape, drill (both dimensions and shape), custom pad extent;
track/via counts; zone count, rule-area flag, keepout flags, outline polygon count, filled polygon count per layer;
board outline loops. Set PCBSTUDIO_CORPUS to point at another checkout.
"""
import math
import os
import time
from pathlib import Path

import pytest

from pcbstudio.kicad import board
from pcbstudio.kicad.pcbnew_worker import PcbnewWorker, WorkerError, find_kicad_python

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
BOARDS = sorted(p.relative_to(CORPUS / 'hardware-design/boards').as_posix()
                for p in (CORPUS / 'hardware-design/boards').glob('*/cad/*/*.kicad_pcb')
                if p.parent.name != 'backups') if CORPUS.is_dir() else []
TOL = 1e-3            # mm and degrees
needs_kicad = pytest.mark.skipif(not find_kicad_python() or not BOARDS, reason='KiCad Python or corpus missing')


@pytest.fixture(scope='module')
def worker():
    w = PcbnewWorker()
    yield w
    w.close()


def _angle_diff(a: float, b: float) -> float:
    d = (a - b) % 360.0
    return min(d, 360.0 - d)


def _custom_extent(p: dict) -> list[float]:
    """Extent of a custom pad: its anchor plus every primitive, strokes included."""
    pts = []
    if p['anchor'] == 'circle':
        r = p['w'] / 2
        pts += [(p['x'] - r, p['y'] - r), (p['x'] + r, p['y'] + r)]
    else:
        a = math.radians(p['rot'])
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x, y = sx * p['w'] / 2, sy * p['h'] / 2
            pts.append((p['x'] + x * math.cos(a) + y * math.sin(a), p['y'] - x * math.sin(a) + y * math.cos(a)))
    for prim in p['prims']:
        r = prim['w'] / 2
        for x, y in prim['pts']:
            pts += [(x - r, y - r), (x + r, y + r)]
    xs, ys = [q[0] for q in pts], [q[1] for q in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


def compare(path: Path, w: PcbnewWorker) -> dict[str, list[str]]:
    """Mismatches by kind ({} = agrees with pcbnew)."""
    bad: dict[str, list[str]] = {}

    def miss(kind, msg):
        bad.setdefault(kind, []).append(msg)
    bid = w.call('load', path=str(path))['board']
    try:
        ref_pads = w.call('query', board=bid, what='pads')
        counts = w.call('query', board=bid, what='counts')
        ref_zones = w.call('query', board=bid, what='zones')
        ref_outline = w.call('query', board=bid, what='outline')
    finally:
        w.call('close', board=bid)
    geo = board.load(path)

    # pads
    ours: dict[str, list[dict]] = {}
    for fp in geo['footprints']:
        for p in fp['pads']:
            ours.setdefault(f"{fp['ref']}.{p['num']}", []).append(p)
    theirs: dict[str, list[dict]] = {}
    for p in ref_pads:
        theirs.setdefault(f"{p['ref']}.{p['num']}", []).append(p)
    if set(ours) != set(theirs):
        miss('pad_keys', f'{sorted(set(ours) ^ set(theirs))[:5]}')
    for key in set(ours) & set(theirs):
        a_list = sorted(ours[key], key=lambda p: (round(p['x'], 3), round(p['y'], 3)))
        b_list = sorted(theirs[key], key=lambda p: (round(p['x'], 3), round(p['y'], 3)))
        if len(a_list) != len(b_list):
            miss('pad_keys', f'{key}: {len(a_list)} vs {len(b_list)}')
            continue
        for a, b in zip(a_list, b_list):
            if abs(a['x'] - b['x']) > TOL or abs(a['y'] - b['y']) > TOL:
                miss('pad_position', f"{key}: ({a['x']}, {a['y']}) vs ({b['x']}, {b['y']})")
            if _angle_diff(a['rot'], b['rot']) > TOL:
                miss('pad_rotation', f"{key}: {a['rot']} vs {b['rot']}")
            if abs(a['w'] - b['w']) > TOL or abs(a['h'] - b['h']) > TOL:
                miss('pad_size', f"{key}: {a['w']}x{a['h']} vs {b['w']}x{b['h']}")
            if a['shape'] != b['shape']:
                miss('pad_shape', f"{key}: {a['shape']} vs {b['shape']}")
            if (a['drill'] is None) != (b['drill'] is None):
                miss('pad_drill', f"{key}: {a['drill']} vs {b['drill']}")
            elif b['drill'] is not None:
                if abs(a['drill'] - b['drill'][0]) > TOL or abs(a['drill_h'] - b['drill'][1]) > TOL \
                        or a['drill_shape'] != b['drill_shape']:
                    miss('pad_drill', f"{key}: {a['drill_shape']} {a['drill']}x{a['drill_h']} vs "
                                      f"{b['drill_shape']} {b['drill'][0]}x{b['drill'][1]}")
            if a['shape'] == 'custom':
                ext = _custom_extent(a)
                if max(abs(u - v) for u, v in zip(ext, b['bbox'])) > 0.01:
                    miss('pad_custom', f'{key}: extent {[round(v, 3) for v in ext]} vs {b["bbox"]}')

    # copper counts
    n_seg = len(geo['tracks']) - counts['arcs'] * 8           # arcs are drawn as 8 chords
    if n_seg != counts['segments']:
        miss('tracks', f"{n_seg} segments vs {counts['segments']}")
    if len(geo['vias']) != counts['vias']:
        miss('vias', f"{len(geo['vias'])} vs {counts['vias']}")

    # zones (file order = pcbnew order)
    if len(geo['zones']) != len(ref_zones):
        miss('zones', f"{len(geo['zones'])} vs {len(ref_zones)}")
    for i, (a, b) in enumerate(zip(geo['zones'], ref_zones)):
        tag = f"zone {i} {a['name'] or a['net']}"
        if a['rule_area'] != b['rule_area']:
            miss('zone_rule_area', f"{tag}: {a['rule_area']} vs {b['rule_area']}")
        if b['rule_area'] and a['allow'] != b['keepout']:
            miss('zone_keepout', f"{tag}: {a['allow']} vs {b['keepout']}")
        n_ref = sum(1 + o['holes'] for o in b['outline'])
        if len(a['polygons']) != n_ref:
            miss('zone_polygons', f'{tag}: {len(a["polygons"])} vs {n_ref} ({b["outline"]})')
        ours_f: dict[str, int] = {}
        for fpoly in a['filled']:
            ours_f[fpoly['layer']] = ours_f.get(fpoly['layer'], 0) + 1
        if {k: v for k, v in ours_f.items() if v} != {k: v for k, v in b['filled'].items() if v}:
            miss('zone_filled', f'{tag}: {ours_f} vs {b["filled"]}')

    # outline
    closed = sum(1 for c in geo['outline'] if c[0] == c[-1] and len(c) > 2)
    n_ref = sum(1 + o['holes'] for o in ref_outline['outlines'])
    if geo['outline_open'] or closed != n_ref:
        miss('outline', f"{closed} closed + {geo['outline_open']} open vs pcbnew {n_ref} (ok={ref_outline['ok']})")
    return bad


@needs_kicad
@pytest.mark.parametrize('rel', BOARDS)
def test_geometry_matches_pcbnew(rel, worker):
    t0 = time.time()
    bad = compare(CORPUS / 'hardware-design/boards' / rel, worker)
    summary = {k: len(v) for k, v in bad.items()}
    detail = '\n'.join(f'  {k}: {v[:4]}' for k, v in bad.items())
    assert not bad, f'{rel} ({time.time() - t0:.1f} s): {summary}\n{detail}'


@needs_kicad
def test_worker_crash_is_an_error_and_the_next_call_works(worker):
    with pytest.raises(WorkerError, match='stopped'):
        worker.call('crash')
    with pytest.raises(WorkerError, match='unknown op'):
        worker.call('nope')                 # an op error is a reply, the worker lives
    assert worker.call('ping')['pcbnew']


def test_empty_board_has_a_bbox(tmp_path):
    p = tmp_path / 'empty.kicad_pcb'
    p.write_text('(kicad_pcb (version 20260206) (generator "test"))\n')
    geo = board.load(p)
    assert board.bbox(geo) == (0.0, 0.0, 0.0, 0.0)
    assert geo['outline'] == [] and geo['outline_open'] == 0


def test_outline_pieces_join_into_one_loop(tmp_path):
    p = tmp_path / 'o.kicad_pcb'
    lines = [((0, 0), (10, 0)), ((10, 5), (10, 0)), ((10, 5), (0, 5)), ((0, 0), (0, 5))]   # mixed directions
    body = ''.join(f'(gr_line (start {a[0]} {a[1]}) (end {b[0]} {b[1]}) (layer "Edge.Cuts"))' for a, b in lines)
    p.write_text(f'(kicad_pcb (version 20260206) {body})\n')
    geo = board.load(p)
    assert len(geo['outline']) == 1 and geo['outline_open'] == 0
    assert len(geo['outline'][0]) == 5 and geo['outline'][0][0] == geo['outline'][0][-1]
    assert board.bbox(geo) == (0.0, 0.0, 10.0, 5.0)


def test_pad_without_angle_is_not_rotated_with_its_footprint(tmp_path):
    p = tmp_path / 'r.kicad_pcb'
    p.write_text('(kicad_pcb (version 20260206) (footprint "X" (layer "F.Cu") (at 10 10 90)'
                 ' (property "Reference" "U1")'
                 ' (pad "1" smd rect (at 1 0) (size 1 2) (layers "F.Cu"))'
                 ' (pad "2" thru_hole oval (at -1 0 90) (size 1 2) (drill oval 0.4 0.8) (layers "*.Cu"))))\n')
    p1, p2 = board.load(p)['footprints'][0]['pads']
    assert p1['rot'] == 0.0 and (p1['x'], p1['y']) == (10.0, 9.0)
    assert p2['rot'] == 90.0 and (p2['drill'], p2['drill_h'], p2['drill_shape']) == (0.4, 0.8, 'oval')
