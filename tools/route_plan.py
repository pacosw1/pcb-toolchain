"""Route plan: the pure core of tools/route.py. No pcbnew, no subprocess.

<board>/route.json (schema iot-lab.route.v1) replaces the per-board *_route.py scripts:

  {"schema": "iot-lab.route.v1", "about": "...", "backend": "fastroute" | "tracemaker",
   "layers": ["F.Cu", "B.Cu"],                      signal layers of every stage unless the stage sets its own
   "budget": {"passes": 60, "time_s": 300, "threads": 0},
   "stages": [{                                     run in order; the copper of a stage is locked for the next
       "name": "mains",
       "only_nets": [...] | "skip_nets": [...],     not both; skip_nets are fnmatch patterns (Fastroute --skip-net)
       "layers": [...], "passes": N, "time_s": N, "threads": N,
       "plane_nets": [...], "route_planes": false,  plane nets get pad vias and are not routed (unless route_planes)
       "neck_um": 0, "unlock_nets": [...], "via_skip": ["U2", "R7.1"],
       "remove_zones": ["BARRIER_BAND"],            zones taken out for this stage only, then put back
       "keepouts": [{"name": "SELV", "inside" | "outside": [x0, y0, x1, y1], "layers": [...]}],   this stage only;
                                                    no tracks, vias or fills; default layers: all copper
       "require": {"open": 0, "vias": null}}],     fail the run above these counts on the stage nets
   "pours": [{"name", "net", "layer", "shape": "board" | "around", "grow_mm", "priority", "connection"}],
   "features": {"via_off_small_pads": true}}        Fastroute only: tools/route-features.json switches

Boxes are in mm, board coordinates. "around" pours cover the pads and copper of the net grown by grow_mm.
"""
import copy
import fnmatch
import re

SCHEMA = 'iot-lab.route.v1'
DRC_UNCONNECTED_CAP = 499
NET_RE = re.compile(r'\[([^\]]+)\]')
BACKENDS = ('fastroute', 'tracemaker')
TOP_KEYS = {'schema', 'about', 'backend', 'layers', 'budget', 'stages', 'pours', 'features'}
BUDGET_KEYS = {'passes', 'time_s', 'threads'}
STAGE_KEYS = {'name', 'only_nets', 'skip_nets', 'layers', 'plane_nets', 'route_planes', 'neck_um', 'unlock_nets',
              'via_skip', 'remove_zones', 'keepouts', 'require'} | BUDGET_KEYS
KEEPOUT_KEYS = {'name', 'inside', 'outside', 'layers'}
REQUIRE_KEYS = {'open', 'vias'}
POUR_KEYS = {'name', 'net', 'layer', 'shape', 'grow_mm', 'priority', 'connection'}
DEFAULT_BUDGET = {'passes': 60, 'time_s': 300, 'threads': 0}


def _count(value, where, errors, allow_none=False):
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        errors.append(f'{where} must be an integer >= 0')
        return None
    return value


def _names(value, where, errors):
    if not isinstance(value, list) or not all(isinstance(n, str) and n for n in value):
        errors.append(f'{where} must be a list of non-empty strings')
        return []
    return list(value)


def _keys(obj, allowed, where, errors):
    if not isinstance(obj, dict):
        errors.append(f'{where} must be an object')
        return False
    for key in sorted(set(obj) - allowed):
        errors.append(f'{where}: unknown key {key}')
    return True


def _layers(value, copper, where, errors):
    names = _names(value, where, errors)
    for name in names:
        if name not in copper:
            errors.append(f'{where}: {name} is not a copper layer of the board')
    if value is not None and not names:
        errors.append(f'{where} must name at least one layer')
    return names


def _box(value, where, errors):
    if (not isinstance(value, list) or len(value) != 4
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in value)):
        errors.append(f'{where} must be [x0, y0, x1, y1] in mm')
        return None
    x0, y0, x1, y1 = value
    if not (x0 < x1 and y0 < y1):
        errors.append(f'{where} needs x0 < x1 and y0 < y1')
        return None
    return [float(v) for v in value]


def _budget(obj, base, where, errors):
    out = dict(base)
    for key in BUDGET_KEYS & set(obj):
        out[key] = _count(obj[key], f'{where}.{key}', errors)
    return out


def load(cfg, copper, known_features=None):
    """Validate a route.json object against the board copper layers (and the known route feature names, which
    fastroute_job would otherwise ignore); return the normalized plan or raise ValueError with every error found."""
    cfg = copy.deepcopy(cfg)
    errors = []
    if not _keys(cfg, TOP_KEYS, 'route.json', errors):
        raise ValueError('; '.join(errors))
    if cfg.get('schema') != SCHEMA:
        errors.append(f'schema must be {SCHEMA}')
    if cfg.get('backend') not in BACKENDS:
        errors.append(f'backend must be one of {", ".join(BACKENDS)}')
    layers = _layers(cfg.get('layers'), copper, 'layers', errors)
    budget = dict(DEFAULT_BUDGET)
    if 'budget' in cfg and _keys(cfg['budget'], BUDGET_KEYS, 'budget', errors):
        budget = _budget(cfg['budget'], budget, 'budget', errors)
    stages_in = cfg.get('stages')
    if not isinstance(stages_in, list) or not stages_in:
        errors.append('stages must be a non-empty list')
        stages_in = []
    stages, seen = [], set()
    for i, raw in enumerate(stages_in):
        where = f'stages[{i}]'
        if not _keys(raw, STAGE_KEYS, where, errors):
            continue
        name = raw.get('name')
        if not isinstance(name, str) or not name:
            errors.append(f'{where}.name is required')
        elif name in seen:
            errors.append(f'duplicate stage name {name}')
        seen.add(name)
        if 'only_nets' in raw and 'skip_nets' in raw:
            errors.append(f'{where}: only_nets and skip_nets cannot both be set')
        stage_layers = _layers(raw['layers'], copper, f'{where}.layers', errors) if 'layers' in raw else layers
        stage = {
            'name': name,
            'only_nets': _names(raw.get('only_nets', []), f'{where}.only_nets', errors),
            'skip_nets': _names(raw.get('skip_nets', []), f'{where}.skip_nets', errors),
            'layers': stage_layers,
            'plane_nets': _names(raw.get('plane_nets', []), f'{where}.plane_nets', errors),
            'route_planes': raw.get('route_planes', False),
            'neck_um': _count(raw.get('neck_um', 0), f'{where}.neck_um', errors),
            'unlock_nets': _names(raw.get('unlock_nets', []), f'{where}.unlock_nets', errors),
            'via_skip': _names(raw.get('via_skip', []), f'{where}.via_skip', errors),
            'remove_zones': _names(raw.get('remove_zones', []), f'{where}.remove_zones', errors),
            'keepouts': [],
        }
        stage.update(_budget(raw, budget, where, errors))
        if not isinstance(stage['route_planes'], bool):
            errors.append(f'{where}.route_planes must be true or false')
        require = raw.get('require', {})
        if _keys(require, REQUIRE_KEYS, f'{where}.require', errors):
            stage['require_open'] = _count(require.get('open', 0), f'{where}.require.open', errors)
            stage['max_vias'] = _count(require.get('vias'), f'{where}.require.vias', errors, allow_none=True)
        keepouts = raw.get('keepouts', [])
        if not isinstance(keepouts, list):
            errors.append(f'{where}.keepouts must be a list')
            keepouts = []
        for k, ko in enumerate(keepouts):
            kw = f'{where}.keepouts[{k}]'
            if not _keys(ko, KEEPOUT_KEYS, kw, errors):
                continue
            if not isinstance(ko.get('name'), str) or not ko.get('name'):
                errors.append(f'{kw}.name is required')
            if ('inside' in ko) == ('outside' in ko):
                errors.append(f'{kw} needs exactly one of inside or outside')
                continue
            mode = 'inside' if 'inside' in ko else 'outside'
            stage['keepouts'].append({
                'name': ko.get('name'), 'mode': mode, 'box': _box(ko[mode], f'{kw}.{mode}', errors),
                'layers': _layers(ko['layers'], copper, f'{kw}.layers', errors) if 'layers' in ko else list(copper)})
        stages.append(stage)
    pours = []
    pours_in = cfg.get('pours', [])
    if not isinstance(pours_in, list):
        errors.append('pours must be a list')
        pours_in = []
    for i, raw in enumerate(pours_in):
        where = f'pours[{i}]'
        if not _keys(raw, POUR_KEYS, where, errors):
            continue
        for key in ('name', 'net', 'layer'):
            if not isinstance(raw.get(key), str) or not raw.get(key):
                errors.append(f'{where}.{key} is required')
        if raw.get('layer') and raw['layer'] not in copper:
            errors.append(f'{where}: {raw["layer"]} is not a copper layer of the board')
        if raw.get('shape') not in ('board', 'around'):
            errors.append(f'{where}.shape must be board or around')
        grow = raw.get('grow_mm')
        if raw.get('shape') == 'around' and (isinstance(grow, bool) or not isinstance(grow, (int, float)) or grow <= 0):
            errors.append(f'{where}.grow_mm must be > 0 for an around pour')
        if raw.get('connection', 'full') not in ('full', 'thermal'):
            errors.append(f'{where}.connection must be full or thermal')
        pours.append({'name': raw.get('name'), 'net': raw.get('net'), 'layer': raw.get('layer'),
                      'shape': raw.get('shape'), 'grow_mm': grow,
                      'priority': _count(raw.get('priority', 0), f'{where}.priority', errors),
                      'connection': raw.get('connection', 'full')})
    features = cfg.get('features', {})
    if not isinstance(features, dict):
        errors.append('features must be an object')
        features = {}
    for key, value in sorted(features.items()):
        if known_features is not None and key not in known_features:
            errors.append(f'unknown feature {key}')
        elif not isinstance(value, bool):
            errors.append(f'features.{key} must be true or false')
    if errors:
        raise ValueError('; '.join(errors))
    return {'backend': cfg['backend'], 'about': cfg.get('about', ''), 'layers': layers, 'stages': stages,
            'pours': pours, 'features': dict(features)}


def feature_env(p):
    """ROUTE_FEATURES value for tools/fastroute_job.py."""
    return ','.join(f'{k}={int(v)}' for k, v in sorted(p['features'].items()))


def fastroute_args(stage):
    """tools/fastroute_job.py options for one stage (after BOARD OUTDIR)."""
    args = ['--layers', ','.join(stage['layers']), '--passes', str(stage['passes']),
            '--max-time', str(stage['time_s']), '--threads', str(stage['threads']),
            '--skip-net', ','.join(stage['skip_nets']), '--plane-nets', ','.join(stage['plane_nets'])]
    if stage['only_nets']:
        args += ['--only-nets', ','.join(stage['only_nets'])]
    if stage['route_planes']:
        args.append('--route-planes')
    if stage['neck_um']:
        args += ['--neck-um', str(stage['neck_um'])]
    if stage['unlock_nets']:
        args += ['--unlock-nets', ','.join(stage['unlock_nets'])]
    if stage['via_skip']:
        args.append('--via-args=--skip ' + ' '.join(stage['via_skip']))
    return args


def tracemaker_args(stage, copper, binary, source, output, summary):
    """TraceMaker routes every open connection; the runner keeps only the new copper of kept_nets() afterwards."""
    args = [binary, 'route', source, '-o', output, '--time', str(stage['time_s']), '--json', summary]
    if stage['threads']:
        args += ['--threads', str(stage['threads'])]
    blocked = [layer for layer in copper if layer not in stage['layers']]
    if blocked:
        args += ['--no-tracks-on', ','.join(blocked)]
    if stage['plane_nets']:
        args.append('--soft-zones')
    if stage['only_nets']:
        args += ['--first-nets', ','.join(stage['only_nets'])]
    return args


def kept_nets(stage, nets):
    """Nets whose new copper a stage keeps."""
    if stage['only_nets']:
        return set(stage['only_nets']) & set(nets)
    return {n for n in nets if not any(fnmatch.fnmatchcase(n, p) for p in stage['skip_nets'])}


def tracemaker_kept(stage, nets):
    """Nets whose new TraceMaker copper a stage keeps: kept_nets() plus the plane nets of the stage, because
    TraceMaker connects plane-net pads with its own copper where Fastroute gives them pad vias."""
    if stage['only_nets']:
        return kept_nets(stage, nets)
    return kept_nets(stage, nets) | (set(stage['plane_nets']) & set(nets))


def stage_failures(stage, open_nets, vias):
    """open_nets: the net of each open connection after the stage; vias: vias on the stage nets."""
    own = kept_nets(stage, open_nets)
    out = []
    n_open = sum(1 for n in open_nets if n in own)
    if n_open > stage['require_open']:
        out.append(f'stage {stage["name"]}: {n_open} open connections on its nets (limit {stage["require_open"]})')
    if stage['max_vias'] is not None and vias > stage['max_vias']:
        out.append(f'stage {stage["name"]}: {vias} vias on its nets (limit {stage["max_vias"]})')
    return out


def open_nets(drc):
    """The net of each open connection in a kicad-cli DRC JSON report. KiCad 10 stops the list at
    DRC_UNCONNECTED_CAP items, so a full list cannot prove that a net is connected."""
    items = drc.get('unconnected_items', [])
    if len(items) >= DRC_UNCONNECTED_CAP:
        raise ValueError(f'DRC lists {len(items)} open connections (cap {DRC_UNCONNECTED_CAP}): count unknown')
    out = []
    for item in items:
        nets = {m.group(1) for i in item.get('items', []) for m in [NET_RE.search(i.get('description', ''))] if m}
        if len(nets) != 1:
            raise ValueError('open connection without one net: ' + str(item)[:200])
        out.append(nets.pop())
    return out


def _block_end(text, start):
    """Index after the s-expression that opens at text[start] == '('. Strings may hold parentheses."""
    depth, i, quoted = 0, start, False
    while i < len(text):
        c = text[i]
        if quoted:
            if c == '\\':
                i += 1
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError('unbalanced s-expression')


def _top_blocks(text, head):
    """(start, end) of each depth-1 block that starts with head, for example '(zone'."""
    out, depth, i, quoted = [], 0, 0, False
    while i < len(text):
        c = text[i]
        if quoted:
            if c == '\\':
                i += 1
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
        elif c == '(':
            if depth == 1 and text.startswith(head, i) and not text[i + len(head)].isalnum():
                end = _block_end(text, i)
                out.append((i, end))
                i = end
                continue
            depth += 1
        elif c == ')':
            depth -= 1
        i += 1
    return out


def split_zones(text, names):
    """Remove the top-level zones with these exact names. Returns (text, removed blocks). A missing name is an error."""
    keep, blocks, found = [], [], set()
    last = 0
    for start, end in _top_blocks(text, '(zone'):
        block = text[start:end]
        hit = next((n for n in names if f'(name "{n}")' in block), None)
        if hit is None:
            continue
        found.add(hit)
        line = text.rfind('\n', 0, start) + 1
        keep.append(text[last:line])
        blocks.append(text[line:end])
        last = end + 1 if text[end:end + 1] == '\n' else end
    missing = [n for n in names if n not in found]
    if missing:
        raise ValueError('no zone named ' + ', '.join(missing))
    keep.append(text[last:])
    return ''.join(keep), [b if b.endswith('\n') else b + '\n' for b in blocks]


def add_blocks(text, blocks):
    """Insert blocks before the closing parenthesis of the board."""
    end = text.rstrip().rfind(')')
    return text[:end] + ''.join(blocks) + text[end:]


def copy_block(source, target, head):
    """Replace the first block that starts with head in target by the same block of source."""
    i, j = source.find(head), target.find(head)
    if i < 0 or j < 0:
        raise ValueError(f'{head} block missing')
    return target[:j] + source[i:_block_end(source, i)] + target[_block_end(target, j):]
