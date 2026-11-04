import os
from pathlib import Path

import pytest

from pcbstudio.kicad.sexpr import Sym, SexprError, child, dumps, dumps_many, parse, parse_many, value

CORPUS = Path(os.environ.get('PCBSTUDIO_CORPUS', '/Users/pacosw/code/iot-lab'))
SKIP = ('node_modules', '/.claude/', '/.gate/')


def same(a, b):
    """Structural equality that also keeps quoted (str) and unquoted (Sym) apart."""
    if isinstance(a, list) or isinstance(b, list):
        return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(map(same, a, b))
    return type(a) is type(b) and a == b


def test_atoms_strings_and_escapes():
    t = parse('(kicad_pcb (version 20260101) (net "A \\"q\\" \\\\ b") (at 1.50 -2) (layer F.Cu) (x "#PWR01"))')
    assert t[0] == 'kicad_pcb' and isinstance(t[0], Sym)
    assert value(t, 'version') == '20260101' and isinstance(value(t, 'version'), Sym)
    assert value(t, 'net') == 'A "q" \\ b' and type(value(t, 'net')) is str
    assert child(t, 'at') == ['at', '1.50', '-2']            # numbers keep their exact text
    assert value(t, 'x') == '#PWR01'
    assert same(parse(dumps(t)), t)


def test_hash_is_text_outside_rule_files():
    t = parse('(lib (sym #PWR (a b)) (c d))')
    assert t[1] == ['sym', '#PWR', ['a', 'b']]


def test_rule_file_comments_and_many_forms():
    forms = parse_many('(version 1)\n# comment (with parens)\n(rule "x" (condition "A.NetClass == \'USB\'")) # tail\n')
    assert [f[0] for f in forms] == ['version', 'rule']
    assert same(parse_many(dumps_many(forms)), forms)


@pytest.mark.parametrize('bad', ['(a (b)', '(a))', '(a "unterminated)'])
def test_errors(bad):
    with pytest.raises(SexprError):
        parse(bad)


def _corpus(*exts):
    if not CORPUS.is_dir():
        return []
    return sorted(p for e in exts for p in CORPUS.rglob(f'*.{e}') if not any(s in str(p) for s in SKIP))


@pytest.mark.skipif(not CORPUS.is_dir(), reason='iot-lab corpus not present')
def test_corpus_round_trip_is_byte_identical():
    files = _corpus('kicad_pcb', 'kicad_sch', 'kicad_sym', 'kicad_mod', 'kicad_dru')
    assert len(files) > 1500
    failures = []
    for p in files:
        raw = p.read_bytes()
        try:
            text = raw.decode('utf-8')
            a = parse_many(text) if p.suffix == '.kicad_dru' else parse(text)
            out = dumps_many(a) if p.suffix == '.kicad_dru' else dumps(a)
        except (SexprError, UnicodeDecodeError) as e:
            failures.append(f'{p}: {e}')
            continue
        if out.encode('utf-8') != raw:
            failures.append(f'{p}: round trip differs')
    assert not failures, f'{len(failures)} of {len(files)} failed:\n' + '\n'.join(failures[:20])


PCB = """(kicad_pcb
\t(version 20260206)
\t(footprint "R_0603"
\t\t(layer "F.Cu")
\t\t(at 10.5 20.25 90)
\t\t(property "Reference" "R1" (at 0 -1.43 90))
\t\t(pad "1" smd roundrect (at -0.79 0 90) (size 0.9 0.95) (layers "F.Cu"))
\t)
\t# not a comment in a board file
)
"""


def test_unchanged_dump_is_identical_and_one_edit_changes_one_line():
    root = parse(PCB)
    assert dumps(root) == PCB
    fp = child(root, 'footprint')
    at = child(fp, 'at')
    at[1], at[2] = 12.0, Sym('21.5')
    out = dumps(root)
    diff = [(a, b) for a, b in zip(PCB.splitlines(), out.splitlines()) if a != b]
    assert len(out.splitlines()) == len(PCB.splitlines())
    assert diff == [('\t\t(at 10.5 20.25 90)', '\t\t(at 12 21.5 90)')]


def test_insert_and_delete_keep_neighbour_formatting():
    root = parse(PCB)
    fp = child(root, 'footprint')
    fp.remove(child(fp, 'property'))
    fp.insert(3, [Sym('attr'), Sym('smd')])
    out = dumps(root)
    assert '\t\t(attr smd)\n\t\t(at 10.5 20.25 90)\n\t\t(pad "1"' in out
    assert 'Reference' not in out
    assert same(parse(out), root)
    # a new nested list is laid out at the depth where it goes
    root.append([Sym('gr_line'), [Sym('start'), 0, 0], [Sym('end'), 1.25, 0]])
    assert dumps(root).endswith('\t# not a comment in a board file\n\t(gr_line\n\t\t(start 0 0)\n\t\t(end 1.25 0)\n\t)\n)\n')


def test_rule_file_keeps_comments():
    text = '(version 1)\n# comment (with parens)\n(rule "x"\n  (condition "A.NetClass == \'USB\'")) # tail\n'
    forms = parse_many(text)
    assert dumps_many(forms) == text
    child(forms[1], 'condition')[1] = 'B'
    assert dumps_many(forms) == text.replace("\"A.NetClass == 'USB'\"", '"B"')
