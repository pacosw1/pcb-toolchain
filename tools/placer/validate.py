"""Validation helpers: DRC JSON counts and a track strip for router scoring.

count_drc(drc_json, subset) -> {errors, parity, unconnected, subset_unconnected, open_nets, error_types}
  The net of an unconnected item is the [NET] in its first item description.
strip_tracks(board, out, keep) -> removed count   (pcbnew; tracks and vias of nets not in keep go;
  zones stay). Used to give the baseline and each candidate the same start for a router job.

Command line (KiCad Python):
  $PY tools/placer/validate.py strip BOARD OUT [--keep=NET,NET,...]
  $PY tools/placer/validate.py count DRC.json [--nets NETS.txt]   (NETS.txt: comma list)
"""
import argparse
import fnmatch
import json
import re
import sys

NET = re.compile(r'\[([^\]]*)\]')


def count_drc(d, subset=()):
    subset = set(subset)
    open_nets = {}
    for u in d.get('unconnected_items', []):
        m = NET.search(u['items'][0]['description']) if u.get('items') else None
        n = m.group(1) if m else '?'
        open_nets[n] = open_nets.get(n, 0) + 1
    errs = [v for v in d.get('violations', []) if v.get('severity') == 'error']
    kinds = {}
    for v in errs:
        kinds[v['type']] = kinds.get(v['type'], 0) + 1
    return {'errors': len(errs), 'parity': len(d.get('schematic_parity', [])),
            'unconnected': sum(open_nets.values()),
            'subset_unconnected': sum(v for k, v in open_nets.items() if k in subset),
            'open_nets': open_nets, 'error_types': kinds}


def strip_tracks(path, out, keep=(), only=None):
    """Remove all tracks and vias except the nets matching `keep`; with `only` (exact net names), remove only those."""
    import pcbnew
    b = pcbnew.LoadBoard(path)
    if only is not None:
        only = set(only)
        gone = [t for t in b.GetTracks() if t.GetNetname() in only]
    else:
        gone = [t for t in b.GetTracks() if not any(fnmatch.fnmatchcase(t.GetNetname(), k) for k in keep)]
    for t in gone:
        b.Delete(t)
    pcbnew.SaveBoard(out, b)
    return len(gone)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('strip')
    s.add_argument('board')
    s.add_argument('out')
    s.add_argument('--keep', default='')
    s.add_argument('--only', help='file with comma-separated net names: remove only the tracks of these nets')
    c = sub.add_parser('count')
    c.add_argument('drc')
    c.add_argument('--nets')
    a = ap.parse_args(argv)
    if a.cmd == 'strip':
        only = open(a.only).read().strip().split(',') if a.only else None
        print('removed', strip_tracks(a.board, a.out, [k for k in a.keep.split(',') if k], only))
    else:
        nets = open(a.nets).read().strip().split(',') if a.nets else []
        r = count_drc(json.load(open(a.drc)), nets)
        print('UNROUTED %d SUBSET %d ERRORS %d' % (r['unconnected'], r['subset_unconnected'], r['errors']))
        print(json.dumps(r))


if __name__ == '__main__':
    sys.exit(main())
