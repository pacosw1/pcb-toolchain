#!/usr/bin/env python3
"""Design blocks and boards: live parsers and a local viewer. Nothing generated is stored in the repo.

  python3 tools/blocks.py serve [--port 8765]      viewer on http://127.0.0.1:8765
  python3 tools/blocks.py check [ID ...]           parts, datasheets and facts of blocks; exit 1 on an error
  python3 tools/blocks.py new ID "description" "keywords"   empty block folder (KiCad-native)

Sources of truth (read at request time, never copied):
  hardware-design/blocks/iot-lab.kicad_blocks/<ID>.kicad_block/
      <ID>.kicad_sch, <ID>.kicad_pcb, <ID>.json   KiCad 10 design block (json: description, keywords, fields)
      <ID>.kicad_pro, <ID>.kicad_dru              test-bed project: net classes and rules for DRC
      facts.json                                  what no parser can derive: validation level, datasheet
                                                  layout rules with their source (file + page)
  hardware-design/boards/<B>/cad/<B>/<B>.kicad_pcb/.kicad_sch     boards
  hardware-design/registry/datasheets/<file>.pdf + .source.json   datasheets (sha256 checked live)
  hardware-design/registry/evidence/<date>/<C-number>.json        dated JLC catalog snapshots
Renders (kicad-cli) go to a temp cache keyed by the sha256 of the source files, so a render is never stale.
Levels: 0 = draft, 1 = passes the board gates, 2 = worked on a built board at bring-up.
"""
import argparse
import glob
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
HD = os.path.join(ROOT, 'hardware-design')
LIB = os.path.join(HD, 'blocks', 'iot-lab.kicad_blocks')
REG = os.path.join(HD, 'registry')
CACHE = os.path.join(tempfile.gettempdir(), 'iot-lab-blocks')
C_NUMBER = re.compile(r'^C\d+$')

# ---------------------------------------------------------------- pure core (tested)

_PROP = re.compile(r'\(property "([^"]+)" "((?:[^"\\]|\\.)*)"')


def parse_footprints(pcb_text):
    """Top-level footprints of a .kicad_pcb text: ref, value, footprint, lcsc, mpn, description, datasheet
    (file name only), plus 'bom': False when the footprint is excluded from the BOM."""
    out = []
    for chunk in re.split(r'\n\t\((?=\S)', pcb_text)[1:]:
        if not chunk.startswith('footprint "'):
            continue
        props = {}
        for k, v in _PROP.findall(chunk):
            props.setdefault(k, v)
        ds = props.get('Datasheet', '')
        f = {'ref': props.get('Reference', ''), 'value': props.get('Value', ''),
             'footprint': chunk[len('footprint "'):chunk.index('"', len('footprint "'))],
             'lcsc': props.get('LCSC', ''), 'mpn': props.get('MPN', ''),
             'description': props.get('Description', ''),
             'datasheet': os.path.basename(ds) if ds.lower().endswith('.pdf') and '://' not in ds else '',
             'url': ds if '://' in ds else ''}
        if re.search(r'\(attr[^)]*exclude_from_bom', chunk):
            f['bom'] = False
        out.append(f)
    return out


def resolve_datasheet(fp, registry_names):
    """The registry file for a part: <MPN>.pdf when it exists, else the local file named in the footprint."""
    by_mpn = fp.get('mpn', '') + '.pdf'
    if fp.get('mpn') and by_mpn in registry_names:
        return by_mpn
    return fp.get('datasheet', '')


def used_in(board_texts, block_id):
    """Boards whose .kicad_pcb holds a group named after the block (KiCad keeps one group per placed block)."""
    pat = re.compile(r'\(group "(?:[^"]*:)?' + re.escape(block_id) + r'"')
    return sorted(b for b, t in board_texts.items() if pat.search(t))


def _natural(ref):
    return [int(t) if t.isdigit() else t for t in re.split(r'(\d+)', ref)]


def bom(fps):
    rows = {}
    for f in fps:
        if f.get('bom') is False:
            continue
        k = (f['value'], f['footprint'], f['lcsc'], f.get('mpn', ''), f.get('datasheet', ''))
        rows.setdefault(k, []).append(f['ref'])
    desc = {}
    for f in sorted(fps, key=lambda f: _natural(f['ref'])):
        desc.setdefault(f['ref'], f.get('description', ''))
    out = [{'refs': sorted(r, key=_natural), 'value': k[0], 'footprint': k[1], 'lcsc': k[2], 'mpn': k[3],
            'datasheet': k[4], 'qty': len(r),
            'description': next((desc[x] for x in sorted(r, key=_natural) if desc[x]), '')} for k, r in rows.items()]
    return sorted(out, key=lambda r: _natural(r['refs'][0]))


def check_parts(fps, ds_index):
    """ds_index: {file name: (actual sha256, sha256 in .source.json)} for the files that exist."""
    errs = []
    for f in fps:
        if f.get('bom') is False:
            continue
        r = f['ref']
        if not C_NUMBER.match(f['lcsc']):
            errs.append(f'{r}: no JLC C-number')
        if not f['datasheet'] and f.get('url'):
            errs.append(f'{r}: datasheet is only a URL, not in registry/datasheets')
        elif not f['datasheet']:
            errs.append(f'{r}: no datasheet')
        elif f['datasheet'] not in ds_index:
            errs.append(f"{r}: {f['datasheet']} not in registry/datasheets")
        elif ds_index[f['datasheet']][0] != ds_index[f['datasheet']][1]:
            errs.append(f"{r}: {f['datasheet']} sha256 does not match its .source.json")
    return errs


def validate_facts(facts):
    errs = []
    if facts.get('level') not in (0, 1, 2):
        errs.append('level must be 0, 1 or 2')
    for i, r in enumerate(facts.get('layout_rules', []), 1):
        if not r.get('rule'):
            errs.append(f'layout rule {i} has no text')
        if not r.get('source'):
            errs.append(f'layout rule {i} has no source')
    return errs


def kicad_meta(description, keywords):
    """KiCad design block metadata: three keys, no indent, no trailing newline."""
    return '{\n"description": %s,\n"keywords": %s,\n"fields": {}\n}' % (json.dumps(description), json.dumps(keywords))


def cache_key(paths, variant):
    h = hashlib.sha256(variant.encode())
    for p in paths:
        with open(p, 'rb') as fh:
            h.update(hashlib.sha256(fh.read()).digest())
    return h.hexdigest()[:24]


def revision(roots):
    """Short hash of (path, size, mtime) of every file under roots: changes when a source changes."""
    h = hashlib.sha256()
    for r in roots:
        for dp, dn, fn in sorted(os.walk(r)):
            dn.sort()
            for n in sorted(fn):
                p = os.path.join(dp, n)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                h.update(f'{p}|{st.st_size}|{st.st_mtime_ns}\n'.encode())
    return h.hexdigest()[:16]


def safe_path(root, rel):
    if not rel or os.path.isabs(rel):
        return None
    root = os.path.realpath(root)
    p = os.path.realpath(os.path.join(root, rel))
    return p if p.startswith(root + os.sep) else None

# ---------------------------------------------------------------- sources (read live)


def items():
    """{(kind, id): {'dir', 'pcb', 'sch'}} for every block and board."""
    out = {}
    for d in sorted(glob.glob(os.path.join(LIB, '*.kicad_block'))):
        i = os.path.basename(d)[:-len('.kicad_block')]
        out[('block', i)] = {'dir': d, 'pcb': os.path.join(d, i + '.kicad_pcb'), 'sch': os.path.join(d, i + '.kicad_sch')}
    for pcb in sorted(glob.glob(os.path.join(HD, 'boards', '*', 'cad', '*', '*.kicad_pcb'))):
        b = os.path.basename(pcb)[:-len('.kicad_pcb')]
        if b != os.path.basename(os.path.dirname(pcb)):
            continue  # scratch copies next to the board
        out[('board', b)] = {'dir': os.path.dirname(pcb), 'pcb': pcb, 'sch': pcb[:-len('.kicad_pcb')] + '.kicad_sch'}
    return out


def _read(p, default=''):
    try:
        with open(p, encoding='utf-8') as fh:
            return fh.read()
    except OSError:
        return default


_sha_memo = {}


def ds_index(names):
    out = {}
    for n in names:
        p = safe_path(os.path.join(REG, 'datasheets'), n)
        if not p or not os.path.exists(p):
            continue
        st = os.stat(p)
        key = (p, st.st_mtime, st.st_size)
        if key not in _sha_memo:
            with open(p, 'rb') as fh:
                _sha_memo[key] = hashlib.sha256(fh.read()).hexdigest()
        rec = json.loads(_read(p + '.source.json', '{}') or '{}').get('sha256', '')
        out[n] = (_sha_memo[key], rec)
    return out


def evidence(lcsc):
    """Newest dated JLC snapshot for a C-number: date, stock, verified flag, path."""
    files = sorted(glob.glob(os.path.join(REG, 'evidence', '*', lcsc + '.json'))) if C_NUMBER.match(lcsc or '') else []
    if not files:
        return None
    d = json.loads(_read(files[-1], '{}') or '{}')
    src = _read(os.path.join(REG, 'cad-assets', lcsc, 'easyeda-bridge-source.json'), '')
    cls = re.search(r'"JLCPCB Part Class"\s*:\s*"([^"]+)"', src)
    return {'date': d.get('fetched_at_utc', '')[:10], 'stock': (d.get('purchase_record') or {}).get('overseasStockCount'),
            'verified': d.get('stock_verified'), 'file': os.path.relpath(files[-1], REG),
            'price': (d.get('purchase_record') or {}).get('initialPrice'), 'jlc_class': cls.group(1) if cls else None}


JLC_EXTENDED_FEE_USD = 3.0  # JLC PCBA loading fee per unique Extended part per order; recheck at order time


def cost(rows):
    """Parts cost estimate: unit price at the smallest quantity (JLC evidence) x qty, per block.
    Extended parts are listed because JLC adds a per-order fee for each unique Extended part."""
    total, ext, missing, unknown = 0.0, [], [], []
    for r in rows:
        ev = r.get('evidence') or {}
        if ev.get('price') is None:
            missing += r['refs']; continue
        total += ev['price'] * r['qty']
        if (ev.get('jlc_class') or '').startswith('Extended'):
            ext.append(r['lcsc'])
        elif not ev.get('jlc_class'):
            unknown.append(r['lcsc'])
    fee = len(set(ext)) * JLC_EXTENDED_FEE_USD
    return {'parts_usd': round(total, 4), 'extended': sorted(set(ext)), 'missing': missing, 'unknown_class': sorted(set(unknown)),
            'extended_fee_usd': fee, 'first_board_usd': round(total + fee, 4)}


def detail(kind, iid):
    it = items().get((kind, iid))
    if not it:
        return None
    fps = parse_footprints(_read(it['pcb']))
    reg = set(os.listdir(os.path.join(REG, 'datasheets')))
    for f in fps:
        f['datasheet'] = resolve_datasheet(f, reg)
    names = sorted({f['datasheet'] for f in fps if f['datasheet']})
    idx = ds_index(names)
    rows = bom(fps)
    for r in rows:
        r['evidence'] = evidence(r['lcsc'])
    d = {'kind': kind, 'id': iid, 'bom': rows, 'cost': cost(rows), 'part_errors': check_parts(fps, idx),
         'datasheets': [{'name': n, 'ok': n in idx and idx[n][0] == idx[n][1], 'present': n in idx} for n in names],
         'files': sorted(f for f in os.listdir(it['dir']) if f.endswith(('.kicad_sch', '.kicad_pcb', '.kicad_pro', '.kicad_dru', '.json'))),
         'has_sch': os.path.exists(it['sch']), 'has_pcb': os.path.exists(it['pcb'])}
    if kind == 'block':
        meta = json.loads(_read(os.path.join(it['dir'], iid + '.json'), '{}') or '{}')
        facts = json.loads(_read(os.path.join(it['dir'], 'facts.json'), '{}') or '{}')
        boards = {b: _read(v['pcb']) for (k, b), v in items().items() if k == 'board'}
        d.update(description=meta.get('description', ''), keywords=meta.get('keywords', ''), facts=facts,
                 fact_errors=validate_facts(facts), used_in=used_in(boards, iid))
    else:
        d.update(blocks=[b for (k, b) in items() if k == 'block' and used_in({iid: _read(it['pcb'])}, b)])
    return d

# ---------------------------------------------------------------- renders (kicad-cli, temp cache)


def recolor_svg(text, color):
    """Paint every fill and stroke color of a one-layer SVG with one color ('none' stays)."""
    text = re.sub(r'((?:fill|stroke):\s*)#[0-9A-Fa-f]{6}', lambda m: m.group(1) + color, text)
    return re.sub(r'((?:fill|stroke)=")#[0-9A-Fa-f]{6}(")', lambda m: m.group(1) + color + m.group(2), text)


# Overlay layers: User.1 = block borders and labels, User.2 = component borders and labels.
OVERLAYS = {'blocks': ('User.1', '#00B8D4'), 'components': ('User.2', '#D500F9')}
_svg_layer = lambda layer: (lambda src, out: ['kicad-cli', 'pcb', 'export', 'svg', '--mode-single', '--page-size-mode', '2',
                                             '--exclude-drawing-sheet', '--drill-shape-opt', '0', '-l', layer, '-o', out, src])

VIEWS = {
    'sch': ('svg', lambda src, out: ['kicad-cli', 'sch', 'export', 'svg', '-e', '-o', os.path.dirname(out), src]),
    'top': ('png', lambda src, out: ['kicad-cli', 'pcb', 'render', '--side', 'top', '--quality', 'high', '-w', '1800', '-h', '1200', '-o', out, src]),
    'bottom': ('png', lambda src, out: ['kicad-cli', 'pcb', 'render', '--side', 'bottom', '--quality', 'high', '-w', '1800', '-h', '1200', '-o', out, src]),
    'iso': ('png', lambda src, out: ['kicad-cli', 'pcb', 'render', '--rotate', '-45,0,45', '--perspective', '--quality', 'high', '-w', '1800', '-h', '1200', '-o', out, src]),
    'front': ('svg', lambda src, out: ['kicad-cli', 'pcb', 'export', 'svg', '--mode-single', '--page-size-mode', '2', '--exclude-drawing-sheet',
                                       '-l', 'F.Cu,F.Mask,F.SilkS,Edge.Cuts', '-o', out, src]),
    'back': ('svg', lambda src, out: ['kicad-cli', 'pcb', 'export', 'svg', '--mode-single', '--page-size-mode', '2', '--exclude-drawing-sheet',
                                      '-m', '-l', 'B.Cu,B.Mask,B.SilkS,Edge.Cuts', '-o', out, src]),
    'blocks': ('svg', _svg_layer(OVERLAYS['blocks'][0])),
    'components': ('svg', _svg_layer(OVERLAYS['components'][0])),
    'glb': ('glb', lambda src, out: ['kicad-cli', 'pcb', 'export', 'glb', '-f', '--subst-models', '--include-tracks', '--include-pads',
                                     '--include-zones', '--include-silkscreen', '--include-soldermask', '-o', out, src]),
}
_locks = {}
_locks_guard = threading.Lock()


def view_variant(view):
    """Cache variant: the view name plus its export command, so a changed command gives a new render."""
    return view + ' ' + ' '.join(VIEWS[view][1]('SRC', 'OUT'))


def render(kind, iid, view):
    it = items().get((kind, iid))
    if not it or view not in VIEWS:
        return None, 'unknown item or view'
    src = it['sch'] if view == 'sch' else it['pcb']
    if not os.path.exists(src):
        return None, f'no source {os.path.basename(src)}'
    ext, cmd = VIEWS[view]
    key = cache_key([src], view_variant(view))
    out_dir = os.path.join(CACHE, key)
    out = os.path.join(out_dir, f'{iid}-{view}.{ext}')
    with _locks_guard:
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        if view == 'sch':
            done = sorted(glob.glob(os.path.join(out_dir, '*.svg')))
            if done:
                return done[0], None
        elif os.path.exists(out):
            return out, None
        os.makedirs(out_dir, exist_ok=True)
        r = subprocess.run(cmd(src, out), capture_output=True, text=True, timeout=600)
        if view == 'sch':
            done = sorted(glob.glob(os.path.join(out_dir, '*.svg')))
            return (done[0], None) if done else (None, (r.stdout + r.stderr)[-800:])
        if view in OVERLAYS and os.path.exists(out):
            text = recolor_svg(open(out).read(), OVERLAYS[view][1])
            open(out, 'w').write(text)
        return (out, None) if os.path.exists(out) else (None, (r.stdout + r.stderr)[-800:])


def drc(kind, iid):
    """Live DRC with schematic parity on the source (cached by source hash)."""
    it = items().get((kind, iid))
    if not it or not os.path.exists(it['pcb']):
        return {'error': 'no pcb'}
    base = it['pcb'][:-len('.kicad_pcb')]
    srcs = [p for p in (it['pcb'], it['sch'], base + '.kicad_pro', base + '.kicad_dru') if os.path.exists(p)]
    key = cache_key(srcs, 'drc')
    out = os.path.join(CACHE, key, 'drc.json')
    if not os.path.exists(out):
        os.makedirs(os.path.dirname(out), exist_ok=True)
        subprocess.run(['kicad-cli', 'pcb', 'drc', '--schematic-parity', '--refill-zones', '--format', 'json', '-o', out, it['pcb']],
                       capture_output=True, text=True, timeout=900)
    d = json.loads(_read(out, '{}') or '{}')
    errs = [v for v in d.get('violations', []) if v.get('severity') == 'error']
    kinds = {}
    for v in errs:
        kinds[v['type']] = kinds.get(v['type'], 0) + 1
    return {'errors': len(errs), 'by_type': kinds, 'unconnected': len(d.get('unconnected_items', [])),
            'parity': len(d.get('schematic_parity', [])), 'warnings': len(d.get('violations', [])) - len(errs)}

# ---------------------------------------------------------------- CLI: check, new


def cmd_check(ids):
    bad = 0
    for (k, i) in items():
        if k != 'block' or (ids and i not in ids):
            continue
        d = detail(k, i)
        errs = d['part_errors'] + d['fact_errors']
        print(f"{i}: level {d['facts'].get('level', '?')}, {sum(r['qty'] for r in d['bom'])} parts, "
              f"used in {', '.join(d['used_in']) or 'none'}, {len(errs)} errors")
        for e in errs:
            print('  ' + e)
        bad += bool(errs)
    return 1 if bad else 0


def cmd_new(iid, desc, keywords):
    d = os.path.join(LIB, iid + '.kicad_block')
    if os.path.exists(d):
        sys.exit(f'blocks: {d} exists')
    os.makedirs(d)
    with open(os.path.join(d, iid + '.json'), 'w') as fh:
        fh.write(kicad_meta(desc, keywords))
    with open(os.path.join(d, 'facts.json'), 'w') as fh:
        json.dump({'level': 0, 'layout_rules': []}, fh, indent=1)
        fh.write('\n')
    print(f'blocks: new {d}; add {iid}.kicad_sch/.kicad_pcb/.kicad_pro/.kicad_dru')
    return 0

# ---------------------------------------------------------------- server


def cmd_serve(port):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import unquote
    types = {'svg': 'image/svg+xml', 'png': 'image/png', 'glb': 'model/gltf-binary', 'pdf': 'application/pdf',
             'json': 'application/json', 'html': 'text/html; charset=utf-8'}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, code, body, ctype):
            if isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def js(self, obj, code=200):
            self.send(code, json.dumps(obj), types['json'])

        def file(self, p, download=False):
            if not p or not os.path.isfile(p):
                return self.js({'error': 'not found'}, 404)
            with open(p, 'rb') as fh:
                self.send(200, fh.read(), types.get(p.rsplit('.', 1)[-1], 'application/octet-stream'))

        def do_GET(self):
            parts = [unquote(x) for x in self.path.split('?')[0].strip('/').split('/') if x]
            try:
                if not parts:
                    return self.send(200, PAGE, types['html'])
                if parts == ['api', 'rev']:
                    roots = [os.path.dirname(LIB)] + [v['dir'] for (k, _), v in items().items() if k == 'board']
                    return self.js({'rev': revision(roots)})
                if parts == ['api', 'items']:
                    out = []
                    for (k, i), v in items().items():
                        facts = json.loads(_read(os.path.join(v['dir'], 'facts.json'), '{}') or '{}') if k == 'block' else {}
                        out.append({'kind': k, 'id': i, 'level': facts.get('level')})
                    return self.js(out)
                if len(parts) == 4 and parts[:2] == ['api', 'item']:
                    d = detail(parts[2], parts[3])
                    return self.js(d) if d else self.js({'error': 'not found'}, 404)
                if len(parts) == 4 and parts[:2] == ['api', 'drc']:
                    return self.js(drc(parts[2], parts[3]))
                if len(parts) == 4 and parts[0] == 'render':
                    p, err = render(parts[1], parts[2], parts[3])
                    return self.file(p) if p else self.js({'error': err}, 500)
                if len(parts) >= 4 and parts[0] == 'file':
                    it = items().get((parts[1], parts[2]))
                    return self.file(safe_path(it['dir'], '/'.join(parts[3:])) if it else None)
                if len(parts) == 2 and parts[0] == 'datasheet':
                    return self.file(safe_path(os.path.join(REG, 'datasheets'), parts[1]))
                if len(parts) >= 2 and parts[0] == 'evidence':
                    return self.file(safe_path(REG, '/'.join(parts[1:])))
                return self.js({'error': 'not found'}, 404)
            except Exception as e:  # report, do not hide
                return self.js({'error': f'{type(e).__name__}: {e}'}, 500)

    srv = ThreadingHTTPServer(('127.0.0.1', port), H)
    print(f'blocks: serving http://127.0.0.1:{port}  (cache {CACHE})', flush=True)
    srv.serve_forever()


PAGE = r'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>iot-lab blocks</title>
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2330;--mute:#667085;--line:#e3e6eb;--acc:#2f6fed;--ok:#1a7f37;--bad:#c62828;--warn:#b26a00;--code:#f0f2f5}
@media (prefers-color-scheme:dark){:root{--bg:#12151b;--panel:#1a1e26;--ink:#e6e9ef;--mute:#98a2b3;--line:#2a303b;--acc:#6c9cff;--ok:#4ac26b;--bad:#ff6b6b;--warn:#f0a93b;--code:#232833}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--ink);display:flex;height:100vh}
nav{width:250px;border-right:1px solid var(--line);background:var(--panel);overflow:auto;padding:12px 0;flex:none}
nav h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:14px 16px 6px}
nav a{display:flex;justify-content:space-between;padding:6px 16px;color:var(--ink);text-decoration:none;cursor:pointer}
nav a:hover{background:var(--code)}nav a.on{background:var(--acc);color:#fff}
main{flex:1;overflow:auto;padding:20px 28px}h1{margin:0 0 4px;font-size:22px}.sub{color:var(--mute);margin-bottom:14px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin:10px 0 16px;flex-wrap:wrap}
.tabs button{border:0;background:none;color:var(--mute);padding:8px 12px;cursor:pointer;font:inherit;border-bottom:2px solid transparent}
.tabs button.on{color:var(--ink);border-color:var(--acc)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:14px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;background:var(--code)}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}code{background:var(--code);padding:1px 5px;border-radius:4px}
.view{background:#fff;border:1px solid var(--line);border-radius:8px;overflow:hidden;position:relative;height:72vh;cursor:grab}
.view img{position:absolute;transform-origin:0 0;max-width:none;user-select:none;-webkit-user-drag:none}
.imgs img{max-width:100%;border:1px solid var(--line);border-radius:8px;background:#fff}
model-viewer{width:100%;height:72vh;background:var(--panel);border:1px solid var(--line);border-radius:8px}
.btn{border:1px solid var(--line);background:var(--panel);color:var(--ink);padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit}
.muted{color:var(--mute)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
</style></head><body>
<nav id="nav"></nav><main id="main"><p class="muted">Select a block or a board.</p></main>
<script>
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const LV={0:'draft',1:'gates pass',2:'bring-up proven'};let cur=null,tab='overview';
async function j(u){const r=await fetch(u);return r.json()}
async function nav(){const it=await j('/api/items');let h='';for(const k of ['block','board']){h+=`<h3>${k}s</h3>`;
 const l=it.filter(x=>x.kind==k);if(!l.length)h+='<a class="muted">none yet</a>';
 for(const x of l)h+=`<a data-k="${x.kind}" data-i="${esc(x.id)}">${esc(x.id)}${x.kind=='block'?`<span class="pill">L${x.level??'?'}</span>`:''}</a>`}
 $('#nav').innerHTML=h;document.querySelectorAll('nav a[data-k]').forEach(a=>a.onclick=()=>open_(a.dataset.k,a.dataset.i));
 const m=location.hash.slice(1).split('/');if(m.length>=2)open_(m[0],decodeURIComponent(m[1]),m[2])}
async function open_(k,i,t){document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('on',a.dataset.k==k&&a.dataset.i==i));
 $('#main').innerHTML='<p class="muted">Parsing sources…</p>';cur=await j(`/api/item/${k}/${encodeURIComponent(i)}`);tab=t||'overview';draw()}
function draw(){const d=cur,T=['overview','schematic','pcb','3d','bom','datasheets','rules','checks'].filter(t=>!(t=='rules'&&d.kind!='block'));
 location.hash=`${d.kind}/${encodeURIComponent(d.id)}/${tab}`;
 let h=`<h1>${esc(d.id)}</h1><div class="sub">${d.kind=='block'?esc(d.description)+' · level '+(d.facts.level??'?')+' ('+(LV[d.facts.level]||'?')+')':'board'}</div>
 <div class="tabs">${T.map(t=>`<button class="${t==tab?'on':''}" data-t="${t}">${t}</button>`).join('')}</div><div id="tab"></div>`;
 $('#main').innerHTML=h;document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{tab=b.dataset.t;draw()});T_[tab](d)}
const R=(v)=>`/render/${cur.kind}/${encodeURIComponent(cur.id)}/${v}`;
const T_={
overview(d){const n=d.bom.reduce((a,r)=>a+r.qty,0),e=d.part_errors.length+(d.fact_errors||[]).length;
 $('#tab').innerHTML=`<div class="card"><table>
 <tr><th>Parts</th><td>${n} in ${d.bom.length} lines</td></tr>
 <tr><th>Parts cost</th><td>${d.cost?d.kind=='block'?`<b>$${d.cost.parts_usd.toFixed(2)}</b> parts per copy (JLC unit price at the smallest quantity, dated snapshots). ${d.cost.extended.length} Extended parts: ${d.cost.extended.map(esc).join(', ')}. The Extended-part fee is paid once per unique part per order, so it is counted on the board, not here.`:`<b>$${d.cost.first_board_usd.toFixed(2)}</b> for one board = parts $${d.cost.parts_usd.toFixed(2)} (JLC unit price at the smallest quantity, dated snapshots) + Extended-part fee $${d.cost.extended_fee_usd.toFixed(2)} (${d.cost.extended.length} unique x $3.00, once per order: ${d.cost.extended.map(esc).join(', ')}). Each extra board adds only $${d.cost.parts_usd.toFixed(2)}.${d.cost.unknown_class.length?` <span class="bad">JLC class unknown (fee not counted): ${d.cost.unknown_class.map(esc).join(', ')}</span>`:''}${d.cost.missing.length?` · <span class="bad">no price: ${d.cost.missing.map(esc).join(', ')}</span>`:''}`:''}</td></tr>
 <tr><th>Part checks</th><td class="${e?'bad':'ok'}">${e?e+' errors':'all parts have a C-number and a checked datasheet'}</td></tr>
 ${d.kind=='block'?`<tr><th>Used in</th><td>${d.used_in.map(esc).join(', ')||'<span class="muted">no board yet</span>'}</td></tr><tr><th>Keywords</th><td>${esc(d.keywords)}</td></tr>`:`<tr><th>Blocks placed</th><td>${d.blocks.map(esc).join(', ')||'<span class="muted">none</span>'}</td></tr>`}
 <tr><th>Source files</th><td>${d.files.map(f=>`<a href="/file/${d.kind}/${encodeURIComponent(d.id)}/${encodeURIComponent(f)}">${esc(f)}</a>`).join(' · ')}</td></tr></table></div>
 ${(d.facts&&d.facts.ports||[]).length?`<div class="card"><b>Ports</b><table><tr><th>Port</th><th>Net</th><th>Where</th><th>Dir</th><th>Limits</th></tr>${d.facts.ports.map(p=>`<tr><td>${esc(p.name||'')}</td><td>${esc(p.net)}</td><td>${esc(p.at)}</td><td>${esc(p.dir||'')}</td><td>${esc(p.limits||p.note||'')}</td></tr>`).join('')}</table></div>`:''}
 <div class="card"><b>Parts and roles</b><table><tr><th>Refs</th><th>Value</th><th>What it does</th></tr>${d.bom.map(r=>`<tr><td>${r.refs.map(esc).join(', ')}</td><td>${esc(r.value)}</td><td>${esc(r.description||'')}</td></tr>`).join('')}</table></div>
 ${e?`<div class="card"><b class="bad">Errors</b><ul>${[...d.part_errors,...(d.fact_errors||[])].map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:''}
 <div class="imgs"><img src="${R('iso')}" alt="3D render (made live by kicad-cli)"></div>`},
schematic(d){pz(R('sch'))},
pcb(d){$('#tab').innerHTML=`<div class="row"><button class="btn" data-v="front">Front layers</button><button class="btn" data-v="back">Back layers</button><button class="btn" data-v="top">Top render</button><button class="btn" data-v="bottom">Bottom render</button>
 <label><input type="checkbox" id="ov-blocks"> <span style="color:#00B8D4">&#9632;</span> Blocks</label> <label><input type="checkbox" id="ov-components"> <span style="color:#D500F9">&#9632;</span> Components</label></div><div id="pv"></div>`;
 const ovs=['blocks','components'];ovs.forEach(o=>{const c=$('#ov-'+o);let on='1';try{on=localStorage.getItem('ov-'+o)??'1'}catch(e){}c.checked=on=='1';
  c.onchange=()=>{try{localStorage.setItem('ov-'+o,c.checked?'1':'0')}catch(e){}document.querySelectorAll('img[data-ov="'+o+'"]').forEach(i=>i.style.display=c.checked?'':'none')}});
 const go=v=>{$('#pv').innerHTML='';pz(R(v),'#pv',v=='front'?ovs.map(o=>({o,src:R(o),on:$('#ov-'+o).checked})):[])};document.querySelectorAll('[data-v]').forEach(b=>b.onclick=()=>go(b.dataset.v));go('front')},
'3d'(d){$('#tab').innerHTML=`<p class="muted">GLB made live by kicad-cli (first load takes a few seconds).</p><model-viewer src="${R('glb')}" camera-controls auto-rotate shadow-intensity="0.6" exposure="1.1"></model-viewer>`},
bom(d){$('#tab').innerHTML=`<div class="card"><table><tr><th>Refs</th><th>Qty</th><th>Value</th><th>MPN</th><th>C-number</th><th>JLC snapshot</th><th>Footprint</th><th>Datasheet</th></tr>
 ${d.bom.map(r=>`<tr><td>${r.refs.map(esc).join(', ')}</td><td>${r.qty}</td><td>${esc(r.value)}</td><td>${esc(r.mpn)}</td>
 <td>${r.lcsc?`<a href="https://jlcpcb.com/partdetail/${esc(r.lcsc)}" target="_blank">${esc(r.lcsc)}</a>`:'<span class="bad">none</span>'}</td>
 <td>${r.evidence?`<a href="/evidence/${esc(r.evidence.file)}" target="_blank">${esc(r.evidence.date)}</a> · stock ${r.evidence.stock??'?'} ${r.evidence.verified?'<span class="ok">verified</span>':''}`:'<span class="muted">no snapshot</span>'}</td>
 <td><code>${esc(r.footprint)}</code></td><td>${r.datasheet?`<a href="/datasheet/${encodeURIComponent(r.datasheet)}" target="_blank">${esc(r.datasheet)}</a>`:'<span class="bad">none</span>'}</td></tr>`).join('')}</table>
 <p class="muted">Stock is the value in the dated snapshot, not live stock. Recheck at each gate and before an order.</p></div>`},
datasheets(d){$('#tab').innerHTML=`<div class="card"><table><tr><th>File</th><th>sha256 vs .source.json</th></tr>${d.datasheets.map(x=>`<tr><td><a href="/datasheet/${encodeURIComponent(x.name)}" target="_blank">${esc(x.name)}</a></td><td class="${x.ok?'ok':'bad'}">${x.present?(x.ok?'match':'MISMATCH'):'missing'}</td></tr>`).join('')}</table></div>`},
rules(d){const r=d.facts.layout_rules||[];$('#tab').innerHTML=`<div class="card"><table><tr><th>#</th><th>Layout rule</th><th>Source</th></tr>${r.map((x,i)=>`<tr><td>${i+1}</td><td>${esc(x.rule)}</td><td>${esc(x.source)}</td></tr>`).join('')||'<tr><td colspan=3 class="muted">no rules yet</td></tr>'}</table></div>
 ${d.facts.level_note?`<div class="card"><b>Validation</b><p>${esc(d.facts.level_note)}</p></div>`:''}`},
async checks(d){$('#tab').innerHTML=`<div class="card"><div class="row"><button class="btn" id="run">Run DRC with schematic parity</button><span class="muted">Runs kicad-cli on the source now; cached by source hash.</span></div><div id="dr"></div></div>`;
 $('#run').onclick=async()=>{$('#dr').innerHTML='<p class="muted">Running…</p>';const r=await j(`/api/drc/${d.kind}/${encodeURIComponent(d.id)}`);
 $('#dr').innerHTML=r.error?`<p class="bad">${esc(r.error)}</p>`:`<table><tr><th>Errors</th><td class="${r.errors?'bad':'ok'}">${r.errors}</td></tr><tr><th>Unconnected</th><td class="${r.unconnected?'bad':'ok'}">${r.unconnected}</td></tr><tr><th>Parity</th><td class="${r.parity?'bad':'ok'}">${r.parity}</td></tr><tr><th>Warnings</th><td>${r.warnings}</td></tr><tr><th>Error types</th><td>${Object.entries(r.by_type).map(([k,v])=>esc(k)+' '+v).join(', ')||'-'}</td></tr></table>`}}};
function pz(src,sel='#tab',ovs=[]){const box=document.createElement('div');box.className='view';box.innerHTML='<p class="muted" style="padding:12px">Rendering from source…</p>';$(sel).appendChild(box);
 const im=new Image();im.onload=()=>{box.innerHTML='';const st=document.createElement('div');st.style.cssText='position:absolute;left:0;top:0;transform-origin:0 0';im.style.position='relative';st.appendChild(im);box.appendChild(st);
 ovs.forEach(v=>{const o=new Image();o.dataset.ov=v.o;o.style.cssText='position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none';if(!v.on)o.style.display='none';o.src=v.src;st.appendChild(o)});
 let s=Math.min(box.clientWidth/im.naturalWidth,box.clientHeight/im.naturalHeight),x=0,y=0;
 const ap=()=>st.style.transform=`translate(${x}px,${y}px) scale(${s})`;ap();
 box.onwheel=e=>{e.preventDefault();const r=box.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,f=e.deltaY<0?1.15:1/1.15;x=mx-(mx-x)*f;y=my-(my-y)*f;s*=f;ap()};
 let dr=null;box.onmousedown=e=>{dr=[e.clientX-x,e.clientY-y];box.style.cursor='grabbing'};onmouseup=()=>{dr=null;box.style.cursor='grab'};
 box.onmousemove=e=>{if(dr){x=e.clientX-dr[0];y=e.clientY-dr[1];ap()}}};
 im.onerror=async()=>{const r=await fetch(src);box.innerHTML=`<p class="bad" style="padding:12px">${esc((await r.json()).error)}</p>`};im.src=src}
nav();let rev=null;setInterval(async()=>{try{const r=(await j('/api/rev')).rev;if(rev&&r!=rev)await nav();rev=r}catch(e){}},3000);
</script></body></html>'''


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sp = ap.add_subparsers(dest='cmd', required=True)
    s = sp.add_parser('serve'); s.add_argument('--port', type=int, default=8765)
    s = sp.add_parser('check'); s.add_argument('ids', nargs='*')
    s = sp.add_parser('new'); s.add_argument('id'); s.add_argument('description'); s.add_argument('keywords')
    a = ap.parse_args()
    if a.cmd == 'serve':
        return cmd_serve(a.port)
    if a.cmd == 'check':
        return cmd_check(a.ids)
    return cmd_new(a.id, a.description, a.keywords)


if __name__ == '__main__':
    sys.exit(main())
