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
def test_corpus_round_trip():
    files = _corpus('kicad_pcb', 'kicad_sch', 'kicad_sym', 'kicad_mod', 'kicad_dru')
    assert len(files) > 1500
    failures = []
    for p in files:
        text = p.read_text(encoding='utf-8', errors='strict')
        try:
            if p.suffix == '.kicad_dru':
                a = parse_many(text)
                ok = same(parse_many(dumps_many(a)), a)
            else:
                a = parse(text)
                ok = same(parse(dumps(a)), a)
        except (SexprError, UnicodeDecodeError) as e:
            failures.append(f'{p}: {e}')
            continue
        if not ok:
            failures.append(f'{p}: round trip differs')
    assert not failures, f'{len(failures)} of {len(files)} failed:\n' + '\n'.join(failures[:20])
