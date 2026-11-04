#!/usr/bin/env python3
"""Move footprint reference designators off the silkscreen (user 2026-09-27).

Each footprint "Reference" property on F.SilkS / B.SilkS moves to F.Fab / B.Fab.
The references stay in the assembly (Fab) drawings. Free silk texts (port names,
pin labels) and footprint silk graphics do not change.

  python3 tools/silk_refs.py BOARD.kicad_pcb [BOARD2 ...] [--dry-run]
"""
import re
import sys

REF = re.compile(r'(\(property "Reference" "[^"]*"\n(?:\t+\(at [^\n]*\)\n)?\t+\(layer ")([FB])\.SilkS"')


def refs_off_silk(text):
    """Return (new text, number of references moved)."""
    return REF.subn(lambda m: f'{m.group(1)}{m.group(2)}.Fab"', text)


def main(argv):
    dry = '--dry-run' in argv
    files = [a for a in argv if a != '--dry-run']
    if not files:
        sys.exit(__doc__)
    for f in files:
        text = open(f).read()
        out, n = refs_off_silk(text)
        if not dry and n:
            open(f, 'w').write(out)
        print(f'{f}: {n} references moved to Fab' + (' (dry run)' if dry else ''))


if __name__ == '__main__':
    main(sys.argv[1:])
