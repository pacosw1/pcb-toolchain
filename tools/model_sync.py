#!/usr/bin/env python3
"""Copy the 3D model entries of the library footprints into a board or block PCB.

For each footprint "iot-lab:<C-number>", the (model ...) path, offset, scale and
rotate come from hardware-design/blocks/iot-lab.pretty/<C-number>.kicad_mod.
No other text changes. A value that is numerically equal keeps the board text.
A footprint with no library file is reported and not changed.

  python3 tools/model_sync.py BOARD.kicad_pcb [BOARD2 ...] [--lib DIR] [--dry-run]
"""
import os
import re
import sys

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hardware-design', 'blocks', 'iot-lab.pretty')
KEYS = ('offset', 'scale', 'rotate')


def close(t, i):
    """Index after the s-expression that opens at t[i] (strings are skipped)."""
    d, s = 0, False
    while i < len(t):
        ch = t[i]
        if s:
            if ch == '\\':
                i += 1
            elif ch == '"':
                s = False
        elif ch == '"':
            s = True
        elif ch == '(':
            d += 1
        elif ch == ')':
            d -= 1
            if d == 0:
                return i + 1
        i += 1
    raise ValueError('unbalanced s-expression')


def models(t):
    """(start, end) of each (model ...) in t."""
    return [(m.start(), close(t, m.start())) for m in re.finditer(r'\(model\s', t)]


def xyz(model, key):
    """Span (start, end) of the numbers in (key (xyz ...)), or None."""
    m = re.search(r'\(%s\s*\(xyz\s+([^)]*)\)' % key, model)
    return m.span(1) if m else None


def lib_fields(text, c):
    ms = models(text)
    if len(ms) != 1:
        raise ValueError(f'{c}: library has {len(ms)} model entries')
    b = text[ms[0][0]:ms[0][1]]
    path = re.match(r'\(model\s+"([^"]*)"', b).group(1)
    vals = {}
    for k in KEYS:
        sp = xyz(b, k)
        if sp is None:
            raise ValueError(f'{c}: library model has no {k}')
        vals[k] = b[sp[0]:sp[1]].split()
    return path, vals


def same(a, b):
    return len(a) == len(b) and all(float(x) == float(y) for x, y in zip(a, b))


def sync_model(b, path, vals, c):
    """Return the board model text with the library values."""
    m = re.match(r'(\(model\s+")([^"]*)"', b)
    if m.group(2) != path:
        b = m.group(1) + path + b[m.end(2):]
    for k in KEYS:
        sp = xyz(b, k)
        if sp is None:
            raise ValueError(f'{c}: board model has no {k}')
        if not same(b[sp[0]:sp[1]].split(), vals[k]):
            b = b[:sp[0]] + ' '.join(vals[k]) + b[sp[1]:]
    return b


def sync(text, lib):
    """lib(c) -> library footprint text or None. Return (text, changed C-numbers, missing C-numbers)."""
    out, pos, changed, missing = [], 0, [], set()
    for m in re.finditer(r'\(footprint "iot-lab:(C\d+)"', text):
        c = m.group(1)
        src = lib(c)
        if src is None:
            missing.add(c)
            continue
        path, vals = lib_fields(src, c)
        end = close(text, m.start())
        fp = text[m.start():end]
        ms = models(fp)
        if len(ms) != 1:
            raise ValueError(f'{c}: board footprint has {len(ms)} model entries')
        s, e = ms[0]
        nb = sync_model(fp[s:e], path, vals, c)
        if nb != fp[s:e]:
            changed.append(c)
        out += [text[pos:m.start() + s], nb]
        pos = m.start() + e
    out.append(text[pos:])
    return ''.join(out), changed, sorted(missing)


def main(argv):
    dry = '--dry-run' in argv
    argv = [a for a in argv if a != '--dry-run']
    lib_dir = LIB
    if '--lib' in argv:
        i = argv.index('--lib')
        lib_dir = argv[i + 1]
        del argv[i:i + 2]
    if not argv:
        sys.exit(__doc__)

    def lib(c):
        p = os.path.join(lib_dir, c + '.kicad_mod')
        return open(p).read() if os.path.exists(p) else None

    for f in argv:
        text = open(f).read()
        out, changed, missing = sync(text, lib)
        if not dry and out != text:
            open(f, 'w').write(out)
        print(f'{f}: {len(changed)} models changed' + (' (dry run)' if dry else '')
              + (f': {", ".join(sorted(set(changed)))}' if changed else '')
              + (f'; no library file: {", ".join(missing)}' if missing else ''))


if __name__ == '__main__':
    main(sys.argv[1:])
