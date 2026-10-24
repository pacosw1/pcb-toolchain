"""The one KiCad s-expression reader/writer (replaces the 14 hand-written readers in iot-lab tools/).

Model: a list is a Python list; a quoted string is `str`; an unquoted token (keyword, number, yes/no) is `Sym`,
which keeps its exact text so numbers round-trip unchanged. `.kicad_dru` files hold several top-level forms and
`#` comments; `parse_many` returns all forms (comments dropped).
"""
from __future__ import annotations

import re
from typing import Iterator, Union


class Sym(str):
    """An unquoted token. Compare with plain strings: Sym('segment') == 'segment'."""
    __slots__ = ()

    def __repr__(self) -> str:
        return f'Sym({str.__repr__(self)})'


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


def _tokens(text: str, comments: bool) -> Iterator[tuple[str, str, int]]:
    """`#` starts a comment only in rule files (comments=True); elsewhere it is ordinary token text."""
    rx = _TOKEN_RULES if comments else _TOKEN_PLAIN
    pos, n = 0, len(text)
    while pos < n:
        m = rx.match(text, pos)
        if not m:
            raise SexprError(f'unexpected character {text[pos]!r} at offset {pos}')
        kind = m.lastgroup
        if kind not in ('ws', 'comment'):
            yield kind, m.group(), pos
        pos = m.end()


def parse_many(text: str, comments: bool = True) -> list[Node]:
    stack: list[list] = [[]]
    for kind, tok, pos in _tokens(text, comments):
        if kind == 'open':
            stack.append([])
        elif kind == 'close':
            if len(stack) == 1:
                raise SexprError(f'unbalanced ) at offset {pos}')
            done = stack.pop()
            stack[-1].append(done)
        elif kind == 'string':
            stack[-1].append(_unquote(tok))
        else:
            stack[-1].append(Sym(tok))
    if len(stack) != 1:
        raise SexprError('unbalanced (: missing ) at end of input')
    return stack[0]


def parse(text: str) -> list:
    """One top-level form (a .kicad_pcb / .kicad_sch / .kicad_sym / .kicad_mod file). '#' is ordinary text here."""
    forms = parse_many(text, comments=False)
    if len(forms) != 1 or not isinstance(forms[0], list):
        raise SexprError(f'expected one top-level list, got {len(forms)} forms')
    return forms[0]


def _quote(s: str) -> str:
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def _atom(x: Node) -> str:
    return str(x) if isinstance(x, Sym) else _quote(x)


def dumps(node: Node, indent: int = 0) -> str:
    """KiCad-like layout: a list whose children are all atoms stays on one line; otherwise each child list goes on
    its own line, indented by one tab."""
    if not isinstance(node, list):
        return _atom(node)
    if not any(isinstance(c, list) for c in node):
        return '(' + ' '.join(_atom(c) for c in node) + ')'
    pad = '\t' * (indent + 1)
    head = []
    i = 0
    while i < len(node) and not isinstance(node[i], list):
        head.append(_atom(node[i]))
        i += 1
    out = '(' + ' '.join(head)
    for c in node[i:]:
        out += '\n' + pad + (dumps(c, indent + 1) if isinstance(c, list) else _atom(c))
    return out + '\n' + '\t' * indent + ')'


def dumps_many(forms: list[Node]) -> str:
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
