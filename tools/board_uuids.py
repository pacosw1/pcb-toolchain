#!/usr/bin/env python3
"""Duplicate item UUIDs in a native KiCad board: check and deterministic repair (W9, 2026-10-10).

A board whose zones (or other items) share one UUID stops the routing step: tools/thermal_repair.immutable_board
rejects "duplicate native immutable item identity" in the import replay guard (seen on IO-6X6, DOOR-RELAY, RELAY-4
and PWR-24V-5V, each with a zone UUID used two or three times; the generator scripts copy a zone with its UUID).
The first occurrence keeps its UUID; each repeat gets uuid5(NAMESPACE, "<uuid>#<ordinal>"), so a repair is the same
on every host and run. Only the uuid tokens change: no copper, no geometry, no other text.

CLI: board_uuids.py BOARD... [--repair]   (reports; --repair rewrites the file in place, atomically)
"""
import json
import os
import sys
import uuid

NAMESPACE = uuid.UUID('7b6f2c8e-5d1a-4d0e-9f3b-2a6c4e8d1b05')   # fixed for this repository


def replacement(old, ordinal):
    return str(uuid.uuid5(NAMESPACE, f'{old}#{ordinal}'))


def _uuid_tokens(text):
    """[(start, end, uuid, kind)] of every (uuid "...") token with the kind of the enclosing item, quote-aware."""
    out, stack, i, n = [], [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == '\\' else 1
            i = j + 1
            continue
        if c == '(':
            j = i + 1
            while j < n and not text[j].isspace() and text[j] not in '()':
                j += 1
            word = text[i + 1:j]
            if word == 'uuid':
                k = text.find('"', j)
                e = text.find('"', k + 1)
                out.append((k + 1, e, text[k + 1:e], stack[-1] if stack else ''))
            stack.append(word)
            i = j
            continue
        if c == ')':
            if stack:
                stack.pop()
        i += 1
    return out


def duplicates(text):
    """Rows (kind, uuid, ordinal, start, end) of every repeated uuid token after its first occurrence."""
    seen, rows = {}, []
    for start, end, u, kind in _uuid_tokens(text):
        seen[u] = seen.get(u, 0) + 1
        if seen[u] > 1:
            rows.append(dict(kind=kind, uuid=u, ordinal=seen[u] - 1, start=start, end=end))
    return rows


def repair(text):
    """(new text, rows with the new uuid). Repeats get their deterministic replacement; a replacement that would
    itself collide with an existing uuid takes the next ordinal."""
    rows = duplicates(text)
    if not rows:
        return text, []
    used = {u for _, _, u, _ in _uuid_tokens(text)}
    out = text
    for r in reversed(rows):
        k = r['ordinal']
        new = replacement(r['uuid'], k)
        while new in used:
            k += 1000
            new = replacement(r['uuid'], k)
        used.add(new)
        r['new'] = new
        out = out[:r['start']] + new + out[r['end']:]
    for r in rows:
        r.pop('start'); r.pop('end')
    return out, rows


def repair_file(path, write=True):
    """Report dict; with write, the repaired board replaces the file (atomic rename)."""
    text = open(path).read()
    new, rows = repair(text)
    if rows and write:
        tmp = path + '.uuidfix'
        with open(tmp, 'w') as f:
            f.write(new)
        os.replace(tmp, path)
    return dict(board=os.path.abspath(path), replaced=len(rows) if write else 0,
                duplicates=len(rows), rows=rows, written=bool(rows and write))


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    fix = '--repair' in argv
    boards = [a for a in argv if a != '--repair']
    if not boards:
        sys.exit(__doc__)
    bad = 0
    for p in boards:
        rep = repair_file(p, write=fix)
        kinds = {}
        for r in rep['rows']:
            kinds[r['kind']] = kinds.get(r['kind'], 0) + 1
        print(f"UUIDS {os.path.basename(p)}: {rep['duplicates']} duplicate item UUID{'s' if rep['duplicates'] != 1 else ''}"
              f"{' ' + json.dumps(kinds) if kinds else ''}{' repaired' if rep['written'] else ''}")
        bad += bool(rep['duplicates'] and not rep['written'])
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
