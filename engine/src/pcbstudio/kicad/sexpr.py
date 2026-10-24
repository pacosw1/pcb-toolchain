"""The one KiCad s-expression reader/writer (replaces the 14 hand-written readers in iot-lab tools/).

Model: a list is a Python list; a quoted string is `str`; an unquoted token (keyword, number, yes/no) is `Sym`,
which keeps its exact text so numbers round-trip unchanged. `.kicad_dru` files hold several top-level forms and
`#` comments; `parse_many` returns all forms.

Format preserving: `parse` returns `SList` nodes that remember their source text. `dumps` writes every part of the
tree that was not changed as the original bytes (whitespace, comments, string escapes, number text), so
`dumps(parse(t)) == t` and `dumps_many(parse_many(t)) == t`. Edit the tree as plain lists (set an item, insert,
delete, append): only the changed tokens are written new. A new list (not from a parse) gets KiCad-like layout,
indented to fit where it goes. Numbers may be set as int/float; they are written in KiCad's short form.
"""
from __future__ import annotations

import re
from typing import Iterator, Union


class Sym(str):
    """An unquoted token. Compare with plain strings: Sym('segment') == 'segment'."""
    __slots__ = ()

    def __repr__(self) -> str:
        return f'Sym({str.__repr__(self)})'


class SList(list):
    """A parsed list. `_src` is the whole source text, `_open`/`_close` the offsets of its parens, `_spans` the
    (start, end) offsets of each original child (flat), `_orig` the original children (for change detection).
    `_lead`/`_trail` are the text before/after a top-level form from `parse` (None elsewhere)."""
    __slots__ = ('_src', '_open', '_close', '_spans', '_orig', '_lead', '_trail')


class Forms(SList):
    """The result of parse_many: top-level forms and the text between them (comments in rule files)."""
    __slots__ = ()


Node = Union[list, str, Sym]

_BODY = r'''
  | (?P<open>\()
  | (?P<close>\))
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<atom>[^\s()"]+)
'''
_TOKEN_RULES = re.compile(r'(?P<ws>\s+) | (?P<comment>\#[^\n]*)' + _BODY, re.VERBOSE | re.DOTALL)
_TOKEN_PLAIN = re.compile(r'(?P<ws>\s+)' + _BODY, re.VERBOSE | re.DOTALL)

_UNESCAPE = {'n': '\n', 't': '\t', 'r': '\r', '"': '"', '\\': '\\'}


class SexprError(ValueError):
    pass


def _unquote(s: str) -> str:
    body = s[1:-1]
    if '\\' not in body:
        return body
    return re.sub(r'\\(.)', lambda m: _UNESCAPE.get(m.group(1), '\\' + m.group(1)), body, flags=re.DOTALL)


def _tokens(text: str, comments: bool) -> Iterator[tuple[str, str, int, int]]:
    """`#` starts a comment only in rule files (comments=True); elsewhere it is ordinary token text."""
    rx = _TOKEN_RULES if comments else _TOKEN_PLAIN
    pos, n = 0, len(text)
    while pos < n:
        m = rx.match(text, pos)
        if not m:
            raise SexprError(f'unexpected character {text[pos]!r} at offset {pos}')
        kind = m.lastgroup
        end = m.end()
        if kind not in ('ws', 'comment'):
            yield kind, m.group(), pos, end
        pos = end


def parse_many(text: str, comments: bool = True) -> Forms:
    top = Forms()
    top._src, top._open, top._lead, top._trail = text, -1, None, None
    stack: list[tuple[SList, list[int]]] = [(top, [])]
    for kind, tok, pos, end in _tokens(text, comments):
        if kind == 'open':
            node = SList()
            node._src, node._open, node._lead, node._trail = text, pos, None, None
            stack[-1][1].append(pos)
            stack.append((node, []))
        elif kind == 'close':
            if len(stack) == 1:
                raise SexprError(f'unbalanced ) at offset {pos}')
            node, spans = stack.pop()
            node._close, node._spans, node._orig = pos, spans, tuple(node)
            stack[-1][0].append(node)
            stack[-1][1].append(end)
        else:
            stack[-1][0].append(_unquote(tok) if kind == 'string' else Sym(tok))
            stack[-1][1].extend((pos, end))
    if len(stack) != 1:
        raise SexprError('unbalanced (: missing ) at end of input')
    top._close, top._spans, top._orig = len(text), stack[0][1], tuple(top)
    return top


def parse(text: str) -> SList:
    """One top-level form (a .kicad_pcb / .kicad_sch / .kicad_sym / .kicad_mod file). '#' is ordinary text here."""
    forms = parse_many(text, comments=False)
    if len(forms) != 1 or not isinstance(forms[0], list):
        raise SexprError(f'expected one top-level list, got {len(forms)} forms')
    root = forms[0]
    root._lead, root._trail = text[:root._open], text[root._close + 1:]
    return root


# ---------------------------------------------------------------- writer
def _quote(s: str) -> str:
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def fmt_num(v: float) -> str:
    """KiCad's number form: at most 6 decimals, no trailing zeros, no '-0'."""
    if isinstance(v, bool):
        return 'yes' if v else 'no'
    if isinstance(v, int):
        return str(v)
    s = f'{v:.6f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def _atom(x) -> str:
    if isinstance(x, Sym):
        return str(x)
    if isinstance(x, str):
        return _quote(x)
    if isinstance(x, (int, float)):
        return fmt_num(x)
    raise TypeError(f'cannot write {type(x).__name__} {x!r}')


class _Out:
    """Output pieces; adjacent source ranges merge, so an unchanged subtree costs one slice."""
    __slots__ = ('parts', 'src', 'a', 'b')

    def __init__(self):
        self.parts: list[str] = []
        self.src, self.a, self.b = None, 0, 0

    def span(self, src: str, a: int, b: int) -> None:
        if a >= b:
            return
        if self.src is src and self.b == a:
            self.b = b
            return
        self.flush()
        self.src, self.a, self.b = src, a, b

    def text(self, s: str) -> None:
        if s:
            self.flush()
            self.parts.append(s)

    def flush(self) -> None:
        if self.src is not None:
            self.parts.append(self.src[self.a:self.b])
            self.src = None

    def value(self) -> str:
        self.flush()
        return ''.join(self.parts)


def _indent_of(gap: str, fallback: int) -> int:
    return gap.rsplit('\n', 1)[1].count('\t') if '\n' in gap else fallback


def _write(node, indent: int, out: _Out) -> None:
    if not isinstance(node, list):
        out.text(_atom(node))
    elif isinstance(node, SList) and hasattr(node, '_orig'):
        _write_src(node, indent, out)
    else:
        _write_new(node, indent, out)


def _write_new(node: list, indent: int, out: _Out) -> None:
    """KiCad-like layout: a list whose children are all atoms stays on one line; otherwise each child list goes on
    its own line, indented by one tab."""
    if not any(isinstance(c, list) for c in node):
        out.text('(' + ' '.join(_atom(c) for c in node) + ')')
        return
    i = 0
    head_atoms = []
    while i < len(node) and not isinstance(node[i], list):
        head_atoms.append(_atom(node[i]))
        i += 1
    out.text('(' + ' '.join(head_atoms))
    pad = '\n' + '\t' * (indent + 1)
    for c in node[i:]:
        out.text(pad)
        _write(c, indent + 1, out)
    out.text('\n' + '\t' * indent + ')')


def _write_src(node: SList, indent: int, out: _Out) -> None:
    src, spans, orig = node._src, node._spans, node._orig
    doc = isinstance(node, Forms)
    o, c = node._open, node._close
    if len(node) == len(orig) and all(a is b for a, b in zip(node, orig)):
        # the same children in the same places: source text, recursing only into child lists
        if not any(isinstance(x, list) for x in node):
            out.span(src, o + 1 if doc else o, c if doc else c + 1)
            return
        if not doc:
            out.span(src, o, o + 1)
        prev = o + 1
        for k, x in enumerate(node):
            start, end = spans[2 * k], spans[2 * k + 1]
            if isinstance(x, list):
                out.span(src, prev, start)
                _write(x, _indent_of(src[prev:start], indent + 1), out)
            else:
                out.span(src, prev, end)
            prev = end
        out.span(src, prev, c if doc else c + 1)
        return
    # structure changed: match each child to an original one (lists by identity, atoms by position)
    starts, ends = spans[0::2], spans[1::2]
    gaps = [src[(ends[j - 1] if j else o + 1):starts[j]] for j in range(len(orig))]
    by_id = {id(x): j for j, x in enumerate(orig) if isinstance(x, list)}
    last_list_gap = next((gaps[j] for j, x in enumerate(orig) if isinstance(x, list)), None)
    if not doc:
        out.text('(')
    for i, x in enumerate(node):
        if isinstance(x, list):
            j = by_id.get(id(x))
            if j is not None and orig[j] is x:
                gap = last_list_gap = gaps[j]
            else:
                gap = last_list_gap if last_list_gap is not None else ('\n' if doc else ' ')
            out.text(gap)
            _write(x, _indent_of(gap, indent + 1), out)
        elif i < len(orig) and not isinstance(orig[i], list):
            out.text(gaps[i])
            y = orig[i]
            if y is x or (type(y) is type(x) and y == x):
                out.span(src, starts[i], ends[i])
            else:
                out.text(_atom(x))
        else:
            out.text('' if i == 0 and not doc else ' ')
            out.text(_atom(x))
    out.text(src[(ends[-1] if orig else o + 1):c])
    if not doc:
        out.text(')')


def dumps(node: Node, indent: int = 0) -> str:
    """Text of a node. A top-level form from `parse` also gets back the text around it in its file, so
    `dumps(parse(t)) == t`."""
    out = _Out()
    lead = getattr(node, '_lead', None) if isinstance(node, SList) else None
    if lead is not None:
        out.text(lead)
    _write(node, indent, out)
    if lead is not None:
        out.text(node._trail)
    return out.value()


def dumps_many(forms: list[Node]) -> str:
    if isinstance(forms, Forms):
        return dumps(forms)
    return '\n'.join(dumps(f) for f in forms) + '\n'


# ---------------------------------------------------------------- queries
def head(node: Node) -> str | None:
    return str(node[0]) if isinstance(node, list) and node and isinstance(node[0], str) else None


def children(node: list, name: str) -> list[list]:
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def child(node: list, name: str) -> list | None:
    for c in node:
        if isinstance(c, list) and c and c[0] == name:
            return c
    return None


def value(node: list, name: str, default: Node | None = None) -> Node | None:
    """(name v) -> v."""
    c = child(node, name)
    return c[1] if c is not None and len(c) > 1 else default
