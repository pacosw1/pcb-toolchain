"""TypeScript types from the engine models: pydantic JSON schema (serialization mode) -> TS interfaces.

    python -m pcbstudio.model.tsgen OUT.ts           write
    python -m pcbstudio.model.tsgen OUT.ts --check   exit 1 if OUT.ts differs from what the models give

Every property is emitted as required (`model_dump()` always has every field), except a field marked
`json_schema_extra={'ts_optional': True}`, which the parser leaves out of some items: it becomes `name?: T`.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from pydantic.json_schema import models_json_schema

from . import EXPORTED

HEADER = ('// GENERATED from engine/src/pcbstudio/model by `npm run types:gen` (python -m pcbstudio.model.tsgen).\n'
          '// Do not edit. `npm run types:check` fails when this file is stale.\n')
EXTRA = 'export type Pt = [number, number]\n'


def _lit(v: Any) -> str:
    """A literal in the app's prettier style (single quotes)."""
    if isinstance(v, str):
        return "'" + v.replace('\\', '\\\\').replace("'", "\\'") + "'"
    return json.dumps(v)


def _ts(s: dict[str, Any]) -> str:
    if '$ref' in s:
        return s['$ref'].rsplit('/', 1)[-1]
    if 'const' in s:
        return _lit(s['const'])
    if 'enum' in s:
        return ' | '.join(_lit(v) for v in s['enum'])
    if 'anyOf' in s:
        parts = [_ts(x) for x in s['anyOf']]
        return ' | '.join(dict.fromkeys(parts))
    t = s.get('type')
    if isinstance(t, list):
        return ' | '.join(_ts({**s, 'type': x}) for x in t)
    if t == 'string':
        return 'string'
    if t in ('number', 'integer'):
        return 'number'
    if t == 'boolean':
        return 'boolean'
    if t == 'null':
        return 'null'
    if t == 'array':
        if 'prefixItems' in s:
            items = [_ts(x) for x in s['prefixItems']]
            return 'Pt' if items == ['number', 'number'] else '[' + ', '.join(items) + ']'
        inner = _ts(s.get('items', {}))
        return f'({inner})[]' if '|' in inner else f'{inner}[]'
    if t == 'object':
        ap = s.get('additionalProperties')
        if 'properties' not in s:
            return f'Record<string, {_ts(ap) if isinstance(ap, dict) else "unknown"}>'
    return 'unknown'


def _doc(text: str | None, indent: str) -> str:
    if not text:
        return ''
    lines = text.strip().splitlines()
    if len(lines) == 1:
        return f'{indent}/** {lines[0].strip()} */\n'
    return indent + '/**\n' + ''.join(f'{indent} * {ln.strip()}\n' for ln in lines) + indent + ' */\n'


def generate() -> str:
    _, top = models_json_schema([(m, 'serialization') for m in EXPORTED], ref_template='#/$defs/{model}')
    defs = top.get('$defs', {})
    order = [m.__name__ for m in EXPORTED] + sorted(set(defs) - {m.__name__ for m in EXPORTED})
    out = [HEADER, '\n', EXTRA]
    for name in order:
        d = defs[name]
        out.append('\n' + _doc(d.get('description'), ''))
        if 'properties' not in d:
            out.append(f'export type {name} = {_ts(d)}\n')
            continue
        out.append(f'export interface {name} {{\n')
        for prop, ps in d['properties'].items():
            out.append(_doc(ps.get('description'), '  '))
            if ps.get('ts_optional'):             # left out of some items by the parser
                out.append(f'  {prop}?: {_ts(ps)}\n')
            else:
                out.append(f'  {prop}: {_ts(ps)}\n')
        out.append('}\n')
    return ''.join(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='pcbstudio.model.tsgen')
    ap.add_argument('out')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args(argv)
    text = generate()
    out = Path(a.out)
    if a.check:
        cur = out.read_text() if out.is_file() else ''
        if cur != text:
            print(f'types:check FAIL: {out} is stale; run npm run types:gen', file=sys.stderr)
            return 1
        print(f'types:check PASS: {out} matches the engine models')
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f'wrote {out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
