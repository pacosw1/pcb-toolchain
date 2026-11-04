"""Parts index: C-number -> datasheets (with sha256), MPN, manufacturer, CAD asset and catalog evidence.

SQLite file in the engine cache folder (`<cache>/index/<root-hash>.sqlite`), never in the project. Sources, in
preference order for a part's main datasheet:
1. filename      `<datasheets_dir>/<anything>_<C-number>.pdf`
2. source_json   `<pdf>.source.json` next to a PDF (catalog_url / catalog_snapshot name the C-number)
3. cad_manifest  `<cad_assets_dir>/<C>/MANIFEST.json` (any nested "datasheet" key)
4. components_json  `components.json` candidates (lcsc + datasheet)
5. bom_csv       board BOM CSVs (`<boards_dir>/*/*.csv`, LCSC + Datasheet columns)

A source path that does not exist is counted (missing_paths) and ignored. The index is rebuilt only when the
input fingerprint (path, size, mtime of every source file) changes; PDF hashes are reused while size and mtime stay.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path
from typing import Any, Iterator

from .. import bomcsv
from ..model import DatasheetRef, PartRecord, PartsIndexStats
from . import cache_dir

SCHEMA = 2
SOURCES = ('filename', 'source_json', 'cad_manifest', 'components_json', 'bom_csv')
NAME_C = re.compile(r'_(C\d{3,})\.pdf$', re.IGNORECASE)
URL_C = re.compile(r'/(C\d{3,})(?:$|[/?#.])')
FILE_C = re.compile(r'^(C\d{3,})\.json$')


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _walk(o: Any) -> Iterator[dict]:
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


def _json(p: Path) -> Any:
    try:
        return json.loads(p.read_text(encoding='utf-8', errors='replace'))
    except (OSError, ValueError):
        return None


class PartsIndex:
    def __init__(self, project, db_path: Path | None = None) -> None:
        self.project = project
        lay = project.layout
        self.ds_dir = project.path(lay.datasheets_dir)
        self.assets_dir = project.path(lay.cad_assets_dir)
        self.components = project.path(lay.components)
        key = hashlib.sha256(str(project.root).encode()).hexdigest()[:16]
        self.db_path = db_path or cache_dir() / 'index' / f'parts-{key}.sqlite'

    # --- inputs

    def _inputs(self) -> list[Path]:
        files: list[Path] = []
        if self.ds_dir.is_dir():
            files += sorted(p for p in self.ds_dir.iterdir() if p.name.endswith(('.pdf', '.source.json')))
        if self.components.is_file():
            files.append(self.components)
        if self.assets_dir.is_dir():
            files += sorted(self.assets_dir.glob('*/MANIFEST.json'))
        files += sorted(self.project.boards_path.glob('*/*.csv'))
        return files

    def fingerprint(self) -> str:
        h = hashlib.sha256(f'schema {SCHEMA}\n'.encode())
        for p in self._inputs():
            try:
                st = p.stat()
            except OSError:
                continue
            h.update(f'{p.relative_to(self.project.root)}\t{st.st_size}\t{st.st_mtime_ns}\n'.encode())
        return h.hexdigest()

    # --- db

    def _connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.db_path)
        db.executescript('''
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, size INTEGER, mtime_ns INTEGER, sha256 TEXT);
            CREATE TABLE IF NOT EXISTS datasheets (c_number TEXT, path TEXT, source TEXT, recorded_sha256 TEXT,
                                                   PRIMARY KEY (c_number, path, source));
            CREATE TABLE IF NOT EXISTS parts (c_number TEXT PRIMARY KEY, mpn TEXT, manufacturer TEXT, cad_asset TEXT,
                                              evidence TEXT);
        ''')
        return db

    def ensure(self) -> PartsIndexStats:
        fp = self.fingerprint()
        db = self._connect()
        try:
            row = dict(db.execute("SELECT key, value FROM meta").fetchall())
            if row.get('fingerprint') == fp and row.get('stats'):
                return PartsIndexStats.model_validate({**json.loads(row['stats']), 'rebuilt': False})
            stats = self._build(db, fp)
            db.commit()
            return stats
        finally:
            db.close()

    def _build(self, db: sqlite3.Connection, fp: str) -> PartsIndexStats:
        root = self.project.root
        old = {r[0]: (r[1], r[2], r[3]) for r in db.execute('SELECT path, size, mtime_ns, sha256 FROM files')}
        maps: list[tuple[str, str, str, str | None]] = []      # c, rel path, source, recorded sha
        info: dict[str, dict[str, Any]] = {}
        missing = 0

        def meta(c: str, **kw: Any) -> None:
            d = info.setdefault(c, {'evidence': set()})
            for k, v in kw.items():
                if k == 'evidence':
                    if v:
                        d['evidence'].add(v)
                elif v and not d.get(k):
                    d[k] = v

        def pdf(raw: str | None, *bases: Path) -> str | None:
            nonlocal missing
            if not raw or raw.startswith(('http://', 'https://')):
                return None
            for b in bases:
                p = (b / raw).resolve()
                if p.is_file() and root in p.parents:
                    return str(p.relative_to(root))
            missing += 1
            return None

        def evidence(raw: str | None, *bases: Path) -> str | None:
            for b in bases:
                if raw:
                    p = (b / raw).resolve()
                    if p.is_file() and root in p.parents:
                        return str(p.relative_to(root))
            return None

        pdfs = sorted(self.ds_dir.glob('*.pdf')) if self.ds_dir.is_dir() else []
        for p in pdfs:
            rel = str(p.relative_to(root))
            m = NAME_C.search(p.name)
            if m:
                maps.append((m.group(1).upper(), rel, 'filename', None))
            src = _json(Path(str(p) + '.source.json'))
            if isinstance(src, dict):
                cs = set()
                for k in ('catalog_url', 'catalog_identity_url'):
                    v = src.get(k)
                    mm = URL_C.search(v) if isinstance(v, str) else None
                    if mm:
                        cs.add(mm.group(1).upper())
                if isinstance(src.get('part'), str) and bomcsv.c_number(src['part']):
                    cs.add(bomcsv.c_number(src['part']))
                snap = src.get('catalog_snapshot')
                if isinstance(snap, str):
                    mm = FILE_C.match(Path(snap).name)
                    if mm:
                        cs.add(mm.group(1).upper())
                for c in cs:
                    maps.append((c, rel, 'source_json', src.get('sha256')))
                    meta(c, evidence=evidence(snap if isinstance(snap, str) else None, root))

        if self.assets_dir.is_dir():
            for man in sorted(self.assets_dir.glob('*/MANIFEST.json')):
                data = _json(man)
                if not isinstance(data, dict):
                    continue
                c = bomcsv.c_number(data.get('lcsc')) or bomcsv.c_number(man.parent.name)
                if not c:
                    continue
                meta(c, mpn=data.get('mpn'), manufacturer=data.get('manufacturer'))
                for d in _walk(data):
                    v = d.get('datasheet')
                    if isinstance(v, str):
                        rel = pdf(v, root, man.parent, self.ds_dir)
                        if rel:
                            maps.append((c, rel, 'cad_manifest', d.get('datasheet_sha256')))

        comp = _json(self.components) if self.components.is_file() else None
        for cand in (comp or {}).get('candidates', []) if isinstance(comp, dict) else []:
            c = bomcsv.c_number(cand.get('lcsc'))
            if not c:
                continue
            meta(c, mpn=cand.get('mpn'), manufacturer=cand.get('manufacturer'),
                 evidence=evidence(cand.get('evidence'), self.components.parent, root))
            rel = pdf(cand.get('datasheet'), self.components.parent, root)
            if rel:
                maps.append((c, rel, 'components_json', None))

        for f in sorted(self.project.boards_path.glob('*/*.csv')):
            try:
                b = bomcsv.read(f)
            except (OSError, UnicodeError):
                continue
            if 'lcsc' not in b.columns:
                continue
            for row in b.rows:
                c = bomcsv.c_number(row.get('lcsc'))
                if not c:
                    continue
                meta(c, mpn=row.get('mpn'), manufacturer=row.get('manufacturer'),
                     evidence=evidence(row.get('evidence'), f.parent, root))
                rel = pdf(row.get('datasheet'), f.parent, root)
                if rel:
                    maps.append((c, rel, 'bom_csv', row.get('datasheet_sha256') or None))

        # Hash every mapped PDF (reuse hashes while size + mtime are unchanged).
        files = {}
        for rel in sorted({m[1] for m in maps} | {str(p.relative_to(root)) for p in pdfs}):
            st = (root / rel).stat()
            prev = old.get(rel)
            sha = prev[2] if prev and prev[0] == st.st_size and prev[1] == st.st_mtime_ns else _sha256(root / rel)
            files[rel] = (st.st_size, st.st_mtime_ns, sha)

        db.execute('DELETE FROM files')
        db.executemany('INSERT INTO files VALUES (?,?,?,?)', [(k, *v) for k, v in files.items()])
        db.execute('DELETE FROM datasheets')
        db.executemany('INSERT OR IGNORE INTO datasheets VALUES (?,?,?,?)', maps)
        db.execute('DELETE FROM parts')
        assets = {p.name.upper() for p in self.assets_dir.iterdir() if p.is_dir()} if self.assets_dir.is_dir() else set()
        cs = {m[0] for m in maps} | set(info) | assets
        db.executemany('INSERT INTO parts VALUES (?,?,?,?,?)', [
            (c, info.get(c, {}).get('mpn'), info.get(c, {}).get('manufacturer'),
             str((self.assets_dir / c).relative_to(root)) if c in assets else None,
             json.dumps(sorted(info.get(c, {}).get('evidence', set())))) for c in sorted(cs)])

        best = self._preferred(db)
        by_source = {s: 0 for s in SOURCES}
        for ref in best.values():
            by_source[ref.sources[0]] += 1
        mism = sum(1 for c, rel, s, rec in maps if rec and len(rec) == 64 and rec.lower() != files[rel][2])
        ds_rel = {str(p.relative_to(root)) for p in pdfs}
        stats = PartsIndexStats(
            path=str(self.db_path), fingerprint=fp, rebuilt=True, pdfs=len(pdfs),
            pdfs_c_in_name=sum(1 for p in pdfs if NAME_C.search(p.name)),
            pdfs_mapped=len({m[1] for m in maps} & ds_rel), c_numbers=len(best), by_source=by_source,
            missing_paths=missing, hash_mismatches=mism)
        db.execute('DELETE FROM meta')
        db.executemany('INSERT INTO meta VALUES (?,?)', [('fingerprint', fp), ('built_at', str(time.time())),
                                                         ('stats', stats.model_dump_json())])
        return stats

    # --- queries

    def _refs(self, db: sqlite3.Connection, c: str | None = None) -> dict[str, list[DatasheetRef]]:
        q = ('SELECT d.c_number, d.path, d.source, d.recorded_sha256, f.sha256 FROM datasheets d '
             'JOIN files f ON f.path = d.path')
        rows = db.execute(q + (' WHERE d.c_number = ?' if c else ''), (c,) if c else ()).fetchall()
        grouped: dict[str, dict[str, dict[str, Any]]] = {}
        for cn, path, source, rec, sha in rows:
            g = grouped.setdefault(cn, {}).setdefault(path, {'path': path, 'sha256': sha, 'recorded_sha256': None,
                                                             'sources': []})
            g['sources'].append(source)
            if rec and not g['recorded_sha256']:
                g['recorded_sha256'] = rec
        out: dict[str, list[DatasheetRef]] = {}
        for cn, paths in grouped.items():
            refs = [DatasheetRef(**{**v, 'sources': sorted(set(v['sources']), key=SOURCES.index)}) for v in paths.values()]
            refs.sort(key=lambda r: (SOURCES.index(r.sources[0]), r.path))
            out[cn] = refs
        return out

    def _preferred(self, db: sqlite3.Connection) -> dict[str, DatasheetRef]:
        return {c: refs[0] for c, refs in self._refs(db).items()}

    def datasheets(self) -> dict[str, DatasheetRef]:
        """C-number -> preferred datasheet, for every indexed part."""
        self.ensure()
        db = self._connect()
        try:
            return self._preferred(db)
        finally:
            db.close()

    def part(self, c: str) -> PartRecord | None:
        c = c.strip().upper()
        self.ensure()
        db = self._connect()
        try:
            row = db.execute('SELECT mpn, manufacturer, cad_asset, evidence FROM parts WHERE c_number = ?', (c,)).fetchone()
            refs = self._refs(db, c).get(c, [])
        finally:
            db.close()
        if row is None and not refs:
            return None
        mpn, mfr, asset, ev = row or (None, None, None, '[]')
        return PartRecord(c_number=c, mpn=mpn, manufacturer=mfr, datasheet=refs[0] if refs else None, datasheets=refs,
                          cad_asset=asset, evidence=json.loads(ev or '[]'))


_open: dict[str, PartsIndex] = {}


def index_for(project) -> PartsIndex:
    key = str(project.root)
    if key not in _open or _open[key].project.layout != project.layout:
        _open[key] = PartsIndex(project)
    return _open[key]
