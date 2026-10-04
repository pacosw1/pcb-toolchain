#!/usr/bin/env python3
"""Remove the tracks of a board copy but keep the copper that belongs to a block.

  $PY tools/strip_keep_blocks.py IN.kicad_pcb OUT.kicad_pcb [--keep 'PATTERN,PATTERN'] [--layer User.1]

A block (CLAUDE.md section 4) has a fixed layout from its datasheet: a switch node, a bootstrap capacitor, an
input capacitor at its pin, a pair. That copper is not for the autorouter (MC-MAIN 2026-10-04: the router could
not make the LM5164 SW and BST links again at the 0.8 mm / 0.6 mm class rules).
Block = a rectangle on --layer (the block borders). Block copper = a group of connected tracks and vias of one net
that is wholly inside one block rectangle and touches 2 or more pads of the parts in that block.
Also kept: each track and via of a net that matches --keep (fnmatch), for example a pair between two blocks.
All other tracks and vias go. Kept copper is locked. Prints the counts.
"""
import argparse
import fnmatch

import pcbnew


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('out')
    ap.add_argument('--keep', default='')
    ap.add_argument('--layer', default='User.1')
    a = ap.parse_args()
    keep_pat = [k for k in a.keep.split(',') if k]
    b = pcbnew.LoadBoard(a.src)
    lid = b.GetLayerID(a.layer)
    boxes = [d.GetBoundingBox() for d in b.GetDrawings() if d.GetLayer() == lid and d.GetClass() == 'PCB_SHAPE']
    tracks = list(b.GetTracks())

    def pts(t):
        return [t.GetPosition()] if t.GetClass() == 'PCB_VIA' else [t.GetStart(), t.GetEnd()]

    keep = set()
    for i, t in enumerate(tracks):
        if t.IsLocked() or any(fnmatch.fnmatchcase(t.GetNetname(), k) for k in keep_pat):
            keep.add(i)  # a locked track is fixed copper (for example POE-ETHERNET)
    block_kept = 0
    for box in boxes:
        pads = [p for fp in b.GetFootprints() if box.Contains(fp.GetPosition()) for p in fp.Pads() if p.GetNetCode() > 0]
        inside = [i for i, t in enumerate(tracks) if all(box.Contains(p) for p in pts(t))]
        parent = {i: i for i in inside}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        by_point = {}
        for i in inside:
            for p in pts(tracks[i]):
                key = (tracks[i].GetNetCode(), p.x // 1000, p.y // 1000)
                if key in by_point:
                    parent[find(i)] = find(by_point[key])
                else:
                    by_point[key] = i
        # A track that ends on the body of another track of its net (a T junction) is in the same group.
        segs = [i for i in inside if tracks[i].GetClass() != 'PCB_VIA']
        for i in inside:
            for p in pts(tracks[i]):
                for j in segs:
                    if j != i and tracks[j].GetNetCode() == tracks[i].GetNetCode() and find(i) != find(j) and tracks[j].HitTest(p):
                        parent[find(i)] = find(j)
        groups = {}
        for i in inside:
            groups.setdefault(find(i), []).append(i)
        for members in groups.values():
            net = tracks[members[0]].GetNetCode()
            touched = set()
            for i in members:
                for p in pts(tracks[i]):
                    for pad in pads:
                        if pad.GetNetCode() == net and pad.HitTest(p):
                            touched.add(pad.m_Uuid.AsString())
            if len(touched) >= 2:
                for i in members:
                    if i not in keep:
                        block_kept += 1
                    keep.add(i)
    removed = 0
    for i, t in enumerate(tracks):
        if i in keep:
            t.SetLocked(True)
        else:
            b.Remove(t)
            removed += 1
    pcbnew.SaveBoard(a.out, b)
    print(f'strip_keep_blocks: {len(boxes)} blocks, removed {removed}, kept {len(keep)} ({block_kept} block copper)')


if __name__ == '__main__':
    main()
