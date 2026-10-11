"""Reject or remove exact protected SES replays of explicitly preserved copper.

No approximate geometry, net-name-only ownership, or source-policy relaxation.
The caller chooses preserved UUIDs before import from its actual keep/lock policy.
"""
import collections
from decimal import Decimal
from pathlib import Path
import re

import route_features


def section(text, name):
    """Read one complete section without parsing the DSN bare string_quote header."""
    matches = list(re.finditer(r'\('+re.escape(name)+r'(?=\s|[()])', text))
    if len(matches) != 1:
        raise ValueError('missing/ambiguous Specctra '+name)
    start = matches[0].start()
    depth, quoted, escaped = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if quoted:
            if escaped: escaped = False
            elif c == '\\': escaped = True
            elif c == '"': quoted = False
        elif c == '"': quoted = True
        elif c == '(': depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                return route_features.sexpr(text[start:i+1])[0]
    raise ValueError('unterminated Specctra '+name)


def child(node, tag):
    found = [x for x in node if isinstance(x, list) and x and x[0] == tag]
    if len(found) != 1:
        raise ValueError('missing/ambiguous '+tag)
    return found[0]


def number(value, scale):
    n = Decimal(value)*scale
    if not n.is_finite() or n != n.to_integral_value():
        raise ValueError('noninteger native geometry')
    return int(n)


def records(text, session=False):
    """Exact nm geometry -> modes. Supported straight segments/through padstacks."""
    if session:
        root = section(text, 'routes')
        resolution = child(root, 'resolution')
        if resolution[1] != 'um': raise ValueError('unsupported unit')
        divisor = int(resolution[2])
        if divisor <= 0 or 1000 % divisor: raise ValueError('unsupported resolution')
        scale = Decimal(1000)/divisor
        library = child(root, 'library_out')
        wires = [(net[1], node) for net in child(root, 'network_out')[1:]
                 if isinstance(net, list) and net[0] == 'net' for node in net[2:]
                 if isinstance(node, list) and node and node[0] in ('wire', 'via')]
    else:
        if re.findall(r'\(unit\s+(\w+)\s*\)', text) != ['um']:
            raise ValueError('unsupported/ambiguous DSN unit')
        resolutions=re.findall(r'\(resolution\s+(\w+)\s+(\d+)\s*\)',text)
        if len(resolutions)!=1 or resolutions[0][0]!='um':
            raise ValueError('unsupported/ambiguous DSN resolution')
        divisor=int(resolutions[0][1])
        if divisor<=0 or 1000 % divisor: raise ValueError('unsupported DSN resolution')
        # DSN coordinates are in its explicit unit (um), with decimal precision
        # declared by resolution. SES network_out integers are resolution ticks.
        # Do not divide DSN coordinates by the resolution divisor a second time.
        scale = Decimal(1000)
        library = section(text, 'library')
        wires = [(child(node, 'net')[1], node) for node in section(text, 'wiring')[1:]
                 if isinstance(node, list) and node and node[0] in ('wire', 'via')]
    stacks = {}
    for stack in library[1:]:
        if not isinstance(stack, list) or not stack or stack[0] != 'padstack': continue
        name = stack[1]
        match = re.fullmatch(r'Via\[0-(\d+)\]_(\d+):(\d+)_um', name)
        if not match: continue
        shapes = []
        for row in stack[2:]:
            if isinstance(row, list) and row and row[0] == 'shape':
                if len(row) != 2 or row[1][0] != 'circle': continue
                shape = row[1]
                if len(shape) not in (3, 5) or (len(shape) == 5 and any(Decimal(x) for x in shape[3:])):
                    raise ValueError('unsupported padstack origin')
                shapes.append((shape[1], number(shape[2], scale)))
        if match:
            diameter, drill = int(match[2])*1000, int(match[3])*1000
            if (len(shapes) != int(match[1])+1 or len({layer for layer,_ in shapes}) != len(shapes)
                    or not {'F.Cu','B.Cu'} <= {layer for layer,_ in shapes}
                    or any(w != diameter for _, w in shapes)):
                raise ValueError('inconsistent via padstack')
            if name in stacks: raise ValueError('duplicate padstack')
            stacks[name] = (tuple(sorted(shapes)), drill, 'F.Cu', 'B.Cu', 4)
    out = collections.defaultdict(list)
    for net, node in wires:
        modes=[x for x in node if isinstance(x,list) and x and x[0]=='type']
        if len(modes)>1: raise ValueError('ambiguous record type')
        mode=modes[0][1] if modes else 'unspecified'
        if node[0] == 'wire':
            path = child(node, 'path')
            if len(path) == 5: continue   # a one-point wire: no segment, KiCad imports no track for it
            if len(path) < 7 or (len(path)-3) % 2: raise ValueError('unsupported path')
            width = number(path[2], scale)
            points = [(number(path[i], scale), -number(path[i+1], scale)) for i in range(3,len(path),2)]
            for a, b in zip(points, points[1:]):
                out[('segment', net, path[1], width, tuple(sorted((a,b))))].append(mode)
        else:
            if node[1] not in stacks: raise ValueError('unsupported via padstack')
            widths, drill, top, bottom, typ = stacks[node[1]]
            q = (number(node[2],scale), -number(node[3],scale))
            out[('via', net, q, widths, drill, top, bottom, typ)].append(mode)
    return dict(out)


def describe(geometry):
    """One line of a geometry record for an error message (nm)."""
    if geometry[0] == 'segment':
        return f"segment {geometry[1]} {geometry[2]} w{geometry[3]} {geometry[4][0]}-{geometry[4][1]}"
    if geometry[0] == 'via':
        return f"via {geometry[1]} at {geometry[2]}"
    return str(geometry[:2])


def dsn_offer(dsn, geometry, unit=1000):
    """The DSN record of an unlocked source: exact, else the same net, layer, width (and drill) with every coordinate
    within one DSN unit (KiCad 10 ExportSpecctraDSN writes whole um; a router result imported at 0.1 um, for example
    y = 111972.5 um of a BASE-PWR repair pass, is offered as 111972). None when the DSN holds no such record."""
    if geometry in dsn:
        return geometry
    kind = geometry[0]
    def near(p, q):
        return abs(p[0] - q[0]) <= unit and abs(p[1] - q[1]) <= unit
    for cand in dsn:
        if cand[0] != kind or cand[1] != geometry[1]:
            continue
        if kind == 'segment' and cand[2:4] == geometry[2:4]:
            (a, b), (c, d) = geometry[4], cand[4]
            if (near(a, c) and near(b, d)) or (near(a, d) and near(b, c)):
                return cand
        elif kind == 'via' and cand[3:] == geometry[3:] and near(geometry[2], cand[2]):
            return cand
    return None


def removal_plan(before, after, preserved, dsn, ses, unlocked=(), deduplicated=None):
    """Validate everything before mutation. Rows contain geometry and full policy.

    unlocked: the source UUIDs this job handed to the router as wiring it may rip up (--unlock-nets, the repair
    pass). KiCad's SES import deletes that copper and adds the router's wiring again (KiCad 10.0.6, checked on a
    POE-ETHERNET copy), so copper the router kept unchanged comes back as a new item coincident with the source.
    That is accepted when the job's own DSN offered the geometry as unlocked wiring (type route) and the SES
    returned it; a coincidence with copper the job did not unlock is still a replay of a foreign result.
    deduplicated: {geometry: n} identical new copies the caller already deleted (Fastroute writes a wire twice now
    and then); they count in the SES multiplicity."""
    deduplicated = deduplicated or {}
    if not set(preserved) <= before.keys(): raise ValueError('unknown preserved UUID')
    unlocked = set(unlocked) - set(preserved)
    if not unlocked <= before.keys(): raise ValueError('unknown unlocked UUID')
    baseline = collections.defaultdict(list)
    for uid in preserved:
        row = before[uid]
        if row['geometry'][0]=='unsupported':
            raise ValueError('unsupported preserved source copper; arc replay not proved')
        if uid not in after or after[uid] != row:
            raise ValueError('preserved source missing/altered: '+uid)
        baseline[row['geometry']].append(uid)
    additions = collections.defaultdict(list)
    for uid, row in after.items():
        if uid not in before: additions[row['geometry']].append(uid)
    plan = []
    for geometry, ids in additions.items():
        if geometry not in baseline:
            if len(ids) > 1: raise ValueError('new-new duplicate without preserved source')
            sources = [uid for uid, r in before.items() if r['geometry'] == geometry]
            if not sources:
                continue
            # A coincident source outside the unlocked set is not eligible: foreign replay.
            if not set(sources) <= unlocked:
                raise ValueError('source coincidence outside preserved policy: ' + describe(geometry))
            if len(sources) != 1: raise ValueError('ambiguous unlocked source geometry')
            offered = dsn_offer(dsn, geometry)
            if offered is None or geometry not in ses:
                raise ValueError('missing source DSN/SES provenance: ' + describe(geometry) +
                                 f" (DSN offered {offered is not None}, SES returned {geometry in ses})")
            if any(m != 'route' for m in dsn[offered]):
                raise ValueError('unlocked source was not offered as unlocked wiring')
            if len(ses[geometry]) != len(ids) + deduplicated.get(geometry, 0):
                raise ValueError('SES replay multiplicity does not match import: ' + describe(geometry))
            source = sources[0]
            if source not in after:
                continue   # the import removed the unlocked copper; the router's copy is the copper now
            if after[source] != before[source]:
                raise ValueError('unlocked source altered: '+source)
            plan.append(dict(removed_uuid=ids[0],retained_uuid=source,geometry=geometry,
                             dsn_modes=dsn[geometry],ses_modes=ses[geometry],unlocked=True))
            continue
        originals = baseline[geometry]
        if len(originals) != 1 or sum(r['geometry']==geometry for r in before.values()) != 1:
            raise ValueError('ambiguous preserved source geometry')
        # The DSN offers a preserved source at whole um too (POE-ETHERNET wide_exempt stage, 2026-10-11: source and
        # SES y = 110801.7 um, DSN -110802): the same one-unit match as for unlocked copper.
        offered = dsn_offer(dsn, geometry)
        if offered is None or geometry not in ses:
            raise ValueError('missing source DSN/SES provenance (preserved): ' + describe(geometry) +
                             f" (DSN offered {offered is not None}, SES returned {geometry in ses})")
        if any(m not in ('fix','protect','route') for m in dsn[offered]):
            raise ValueError('unsupported DSN source mode')
        if any(m not in ('fix','protect') for m in ses[geometry]):
            raise ValueError('unprotected SES coincidence: ' + describe(geometry) + f' (SES modes {ses[geometry]})')
        if len(ses[geometry]) != len(ids) + deduplicated.get(geometry, 0):
            raise ValueError('SES replay multiplicity does not match import')
        for uid in ids:
            plan.append(dict(removed_uuid=uid,retained_uuid=originals[0],geometry=geometry,
                             dsn_modes=dsn[offered],ses_modes=ses[geometry]))
    return plan


def snapshot(board, path):
    """Native full-node policy snapshot, independent of live item objects."""
    import pcbnew
    import thermal_repair
    pcbnew.SaveBoard(str(path),board)
    nodes = thermal_repair.immutable_board(path)
    out = {}
    for t in board.GetTracks():
        uid=t.m_Uuid.AsString();kind=t.GetClass();net=t.GetNetname()
        xy=lambda p:(p.x,p.y)
        if kind == 'PCB_TRACK':
            geom=('segment',net,t.GetLayerName(),t.GetWidth(),tuple(sorted((xy(t.GetStart()),xy(t.GetEnd())))))
            tag='segment'
        elif kind == 'PCB_VIA':
            widths=tuple(sorted((board.GetLayerName(l),t.GetWidth(l)) for l in board.GetEnabledLayers().CuStack() if t.IsOnLayer(l)))
            geom=('via',net,xy(t.GetPosition()),widths,t.GetDrillValue(),board.GetLayerName(t.TopLayer()),board.GetLayerName(t.BottomLayer()),int(t.GetViaType()))
            tag='via'
        else:
            # No approximate arc replay matching; untouched originals still checked.
            geom=('unsupported',uid);tag='arc'
        key=(tag,'"'+uid+'"')
        if key not in nodes: raise ValueError('missing native source policy')
        out[uid]=dict(geometry=geom,policy=nodes[key])
    return out


def restore(board, before, preserved, dsn_path, ses_path, snapshot_path, unlocked=(), deduplicated=None):
    dsn=records(Path(dsn_path).read_text());ses=records(Path(ses_path).read_text(),True)
    after=snapshot(board,snapshot_path)
    plan=removal_plan(before,after,preserved,dsn,ses,unlocked,deduplicated)
    items={t.m_Uuid.AsString():t for t in board.GetTracks()}
    # Delete owns native item destruction; Remove only detaches and leaves the
    # lifetime of orphaned SWIG pointers to the Python binding.
    for row in plan: board.Delete(items[row['removed_uuid']])
    expected={uid:row for uid,row in after.items() if uid not in {r['removed_uuid'] for r in plan}}
    if snapshot(board,snapshot_path) != expected: raise ValueError('replay transaction changed other copper')
    return plan
