"""Isolated native/SRJ round trips for explicitly selected two-layer nets.

Keeps all other copper and all placements. Conservative obstacle envelopes may
overconstrain the solver. This experimental adapter is not a release gate.
Run each export/import in a fresh process: detached-object cleanup in the tested
legacy SWIG runtime can invalidate subsequent native calls in that process.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil

from .contracts import fingerprint, number, xy


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def source_set(board):
    files = [board.with_suffix(x) for x in ('.kicad_pcb', '.kicad_pro', '.kicad_dru', '.kicad_sch')]
    if any(not p.is_file() for p in files):
        raise ValueError('complete native project sidecars required')
    return {p.name: digest(p) for p in files}


def geometry_digest(path, omit_ids=()):
    """Hash all native board forms except explicitly named routing items.

    Only writer identity metadata is ignored. Placements, pads, nets, rules,
    zones, drawings, copper and board setup remain in the protected payload.
    """
    from placer.dru import _tree, _tokens
    forms = _tree(_tokens(Path(path).read_text()))
    if len(forms) != 1 or forms[0][0] != 'kicad_pcb':
        raise ValueError('unexpected native board root')
    remaining, seen, hashes = set(omit_ids), set(), []
    for form in forms[0][1:]:
        uid = next((v[1] for v in form[1:] if isinstance(v, list) and v[0] == 'uuid'), None)
        if uid in remaining:
            if form[0] not in ('segment', 'arc', 'via') or uid in seen:
                raise ValueError('only uniquely identified routing items may change')
            seen.add(uid)
            continue
        if form[0] not in ('generator', 'generator_version'):
            hashes.append(fingerprint(form))
    if seen != remaining:
        raise ValueError('specified routing item absent from native board')
    return fingerprint(sorted(hashes))


def netclass_rules(project, names):
    """Use native-resolved names and exact project values; no implicit defaults.

    pcbnew 10.0.6 GetNetClass returns an untyped proxy in our runtime. Composite
    classes need native priority resolution, so this limited adapter abstains.
    """
    rows = project['net_settings']['classes']
    by_name = {c['name']: c for c in rows}
    if len(by_name) != len(rows) or any(n not in by_name for n in names):
        raise ValueError('unresolved, composite or duplicate netclass')
    result = {n: by_name[n] for n in names}
    for c in result.values():
        for field in ('track_width', 'via_diameter', 'via_drill'):
            number(c[field], field, positive=True)
        number(c['clearance'], 'netclass clearance')
        if c['via_drill'] >= c['via_diameter']:
            raise ValueError('invalid source netclass via geometry')
    return result


def native_connected_groups(board, pads, labels, nets):
    """Native physical pad components, never inferred from a shared net name.

    Only retained tracks/vias may establish this contract. Filled-zone topology
    can be stale after removal and is not represented by this narrow SRJ export.
    """
    if any(not z.GetIsRuleArea() and z.GetNetname() in nets for z in board.Zones()):
        raise ValueError('selected-net zone connectivity requires fresh fill and a richer adapter')
    board.BuildConnectivity()
    conn = board.GetConnectivity()
    result = {}
    for net in nets:
        native = {p.m_Uuid.AsString(): p for p in pads if p.GetNetname() == net}
        root = {uid: uid for uid in native}
        def find(uid):
            while root[uid] != uid:
                root[uid] = root[root[uid]]
                uid = root[uid]
            return uid
        for uid, pad in native.items():
            for item in conn.GetConnectedItems(pad):
                other = item.m_Uuid.AsString()
                if other in root:
                    root[find(other)] = find(uid)
        groups = {}
        for uid in native:
            groups.setdefault(find(uid), []).append(labels[uid])
        result[net] = sorted(sorted(group) for group in groups.values() if len(group) > 1)
    return result


def selected_route_proposal(srj, result, selected_nets):
    """Take only requested new copper from an unqualified solver response.

    The topology solver can nudge preloaded traces. Those edits cannot enter
    our native board. Discard them explicitly, restore the exact original
    traces, and require independent DRC against that unchanged copper.
    """
    import copy
    if (result.get('input_sha256') != fingerprint(srj) or result.get('qualified') is not False
            or result.get('status') not in ('candidate', 'model_mismatch')):
        raise ValueError('no completed matching route proposal to restrict')
    changes = result.get('changed_fields', [])
    if any(not c.startswith('preserved trace:') for c in changes):
        raise ValueError('solver changed non-copper model fields')
    preserved = {t['pcb_trace_id'] for t in srj.get('traces', [])}
    traces = result['output']['traces']
    new = [t for t in traces if t.get('pcb_trace_id') not in preserved]
    if not new or any(t.get('connection_name') not in selected_nets for t in new):
        raise ValueError('new copper outside requested nets or no new copper')
    proposal = copy.deepcopy(result)
    proposal.update(status='candidate', qualified=False, native_validation_required=True,
                    reason='selected new routes only; original copper restored; native checks required',
                    parent_response_sha256=fingerprint(result), discarded_backend_changes=changes,
                    changed_fields=[], selected_nets=list(selected_nets))
    proposal['output'] = dict(copy.deepcopy(srj), traces=copy.deepcopy(srj.get('traces', [])) + new)
    from .capacity import route_crossings
    conflicts = route_crossings(srj, proposal['output']['traces'])
    if conflicts:
        proposal.update(status='geometry_reject', reason='new copper crosses protected or other-net routing',
                        conflicts=conflicts)
    return proposal


def frozen_srj(folder):
    folder = Path(folder)
    manifest = json.loads((folder/'record.json').read_text())
    srj = json.loads((folder/'srj.json').read_text())
    if (manifest['input_files'] != source_set(folder/'input.kicad_pcb')
            or manifest['srj_sha256'] != fingerprint(srj)):
        raise ValueError('native project or SRJ changed before proposal scoping')
    return manifest, srj


def scope_routes(folder, result_path, output, *, repair_budget=None):
    output = Path(output)
    if output.exists():
        raise ValueError('proposal output must be new')
    manifest, srj = frozen_srj(folder)
    result = json.loads(Path(result_path).read_text())
    if repair_budget is None:
        proposal = selected_route_proposal(srj, result, manifest['selected_nets'])
    else:
        from .repair import prune_crossing_excursion
        proposal = prune_crossing_excursion(srj, result, budget_s=repair_budget)
    output.write_text(json.dumps(proposal, indent=2))
    return dict(status=proposal['status'], qualified=False, reason=proposal['reason'],
                conflicts=len(proposal.get('conflicts', [])),
                discarded_backend_changes=len(proposal.get('discarded_backend_changes', [])))


def export(board, out, nets):
    import pcbnew as pcb
    from placer.dru import _tree, _tokens
    board, out = Path(board).resolve(), Path(out).resolve()
    if not nets or len(set(nets)) != len(nets):
        raise ValueError('explicit unique reroute nets required')
    before = source_set(board)
    b = pcb.LoadBoard(str(board))
    if b.GetCopperLayerCount() != 2:
        raise ValueError('this adapter currently requires a two-layer stack')
    known = b.GetNetsByName()
    if any(n not in known for n in nets):
        raise ValueError('unknown selected net')
    project = json.loads(board.with_suffix('.kicad_pro').read_text())
    rules = project['board']['design_settings']['rules']
    custom = _tree(_tokens(board.with_suffix('.kicad_dru').read_text()))
    # Keep native proxies alive for the whole transformation. In the supported
    # 10.0.6 runtime, collecting detached track proxies invalidates later SWIG
    # accessors; retain detached items instead of discarding their owners.
    footprints = list(b.GetFootprints())
    tracks = list(b.GetTracks())
    pads = [p for f in footprints for p in f.Pads()]
    if any(p.GetAttribute() == pcb.PAD_ATTRIB_PTH for p in pads):
        raise ValueError('PTH drill constraints require a richer adapter')
    # The only accepted custom constraints here apply exclusively to PTH pads,
    # proven absent above. Never silently ignore a rule because it was not parsed.
    for form in custom:
        if form == ['version', '1']:
            continue
        if not form or form[0] != 'rule':
            raise ValueError('unrepresented custom-rule form')
        conditions = [x[1] for x in form[2:] if x[0] == 'condition']
        constraints = [x for x in form[2:] if x[0] == 'constraint']
        allowed = {
            "A.Pad_Type == 'Through-hole' && B.Pad_Type == 'Through-hole'": 'hole_to_hole',
            "A.Pad_Type == 'Through-hole' || B.Pad_Type == 'Through-hole'": 'hole_clearance',
        }
        if (len(conditions) != 1 or conditions[0] not in allowed or len(constraints) != 1
                or constraints[0][1] != allowed[conditions[0]]):
            raise ValueError('unrepresented custom rule: ' + str(form[1]))
    layers = {pcb.F_Cu: 'top', pcb.B_Cu: 'bottom'}
    def ls(item):
        return [name for layer, name in layers.items() if item.IsOnLayer(layer)]
    def rect(item, label, connected, hole=False):
        bb = item.GetBoundingBox()
        return dict(type='rect', obstacleId=label, layers=ls(item),
                    center=dict(x=pcb.ToMM(bb.GetX()+bb.GetWidth()/2), y=pcb.ToMM(bb.GetY()+bb.GetHeight()/2)),
                    width=pcb.ToMM(bb.GetWidth()), height=pcb.ToMM(bb.GetHeight()), connectedTo=connected,
                    **({'isNonPlatedHole': True} if hole else {}))
    removed = []
    for t in tracks:
        if t.GetNetname() in nets and not t.IsLocked():
            removed.append(t.m_Uuid.AsString())
            b.Remove(t)
    obstacles, points, labels = [], {n: [] for n in nets}, {}
    for f in footprints:
        for p in f.Pads():
            label = f.GetReference()+'.'+p.GetNumber()+':'+p.m_Uuid.AsString()
            labels[p.m_Uuid.AsString()] = label
            hole = p.GetAttribute() == pcb.PAD_ATTRIB_NPTH
            net = p.GetNetname()
            ob = rect(p, label, [net] if net else [], hole)
            if hole:
                ob['layers'] = ['top', 'bottom']
            if ob['layers']:
                obstacles.append(ob)
            if net in points:
                q = p.GetPosition()
                if not ob['layers']:
                    raise ValueError('selected pad has no copper access')
                points[net].append(dict(x=pcb.ToMM(q.x), y=pcb.ToMM(q.y), layers=ob['layers'], pointId=label))
    preloaded = []
    for t in b.GetTracks():
        if type(t) is pcb.PCB_TRACK and t.GetNetname():
            # A diagonal segment's AABB can cover unrelated, valid terminals.
            # Pipeline 9 has an explicit retained-trace graph; preserve the
            # centerline and physical width instead of making it an obstacle box.
            preloaded.append(dict(type='pcb_trace', pcb_trace_id=t.m_Uuid.AsString(),
                                  connection_name=t.GetNetname(), route=[
                dict(route_type='wire', x=pcb.ToMM(q.x), y=pcb.ToMM(q.y),
                     layer=layers[t.GetLayer()], width=pcb.ToMM(t.GetWidth()))
                for q in (t.GetStart(), t.GetEnd())]))
        elif type(t) is pcb.PCB_VIA:
            if not t.GetNetname() or ls(t) != ['top', 'bottom'] or t.GetViaType() != pcb.VIATYPE_THROUGH:
                raise ValueError('retained via requires an assigned net and through-board layer pair')
            ob = rect(t, t.m_Uuid.AsString(), [t.GetNetname()] if t.GetNetname() else [])
            ob['shape'] = 'circle'
            obstacles.append(ob)
            # A multilayer obstacle reserves space; it does not create a via
            # primitive in Pipeline 9's preloaded route graph. Preserve both the
            # physical envelope and the exact existing inter-layer transition.
            q = t.GetPosition()
            preloaded.append(dict(type='pcb_trace', pcb_trace_id=t.m_Uuid.AsString(),
                connection_name=t.GetNetname(), route=[dict(route_type='via',
                    x=pcb.ToMM(q.x), y=pcb.ToMM(q.y), from_layer='top', to_layer='bottom',
                    layers=['top', 'bottom'], via_diameter=pcb.ToMM(t.GetWidth()),
                    via_hole_diameter=pcb.ToMM(t.GetDrillValue()))]))
        else:
            raise ValueError('unsupported retained arc or unassigned copper')
    for z in b.Zones():
        if z.GetIsRuleArea() and (z.GetDoNotAllowTracks() or z.GetDoNotAllowVias()):
            obstacles.append(rect(z, 'keepout:'+z.m_Uuid.AsString(), []))
    outline = pcb.SHAPE_POLY_SET()
    if not b.GetBoardPolygonOutlines(outline, False) or outline.OutlineCount() != 1 or outline.HoleCount(0):
        raise ValueError('unsupported disjoint board or internal cutout representation')
    poly = outline.Outline(0)
    boundary = [dict(x=pcb.ToMM(poly.CPoint(i).x), y=pcb.ToMM(poly.CPoint(i).y)) for i in range(poly.PointCount())]
    names = {n: known[n].GetNetClassName() for n in nets}
    all_names = {p.GetNetClassName() for p in pads if p.GetNetname()}
    class_rules = netclass_rules(project, all_names | set(names.values()))
    classes = [class_rules[names[n]] for n in nets]
    clearance = max([rules['min_clearance']] + [c['clearance'] for c in class_rules.values()]
                    + [pcb.ToMM(p.GetOwnClearance(pcb.F_Cu)) for p in pads
                       if p.GetAttribute() != pcb.PAD_ATTRIB_NPTH])
    # An NPTH's local clearance applies to its hole, not every copper obstacle.
    # Hole constraints remain explicit below; inflating all copper to the hole
    # clearance can falsely seal a valid SMD escape near a rule-area boundary.
    hole_clearance = max([rules['min_hole_clearance']]
                         + [pcb.ToMM(p.GetOwnClearance(pcb.F_Cu)) for p in pads
                            if p.GetAttribute() == pcb.PAD_ATTRIB_NPTH])
    via_drill = max(c['via_drill'] for c in classes)
    via_diameter = max([rules['min_via_diameter'], via_drill + 2 * rules['min_via_annular_width']]
                       + [c['via_diameter'] for c in classes])
    connected = native_connected_groups(b, pads, labels, nets)
    srj = dict(layerCount=2, minTraceWidth=rules['min_track_width'],
               minViaPadDiameter=via_diameter, minViaHoleDiameter=via_drill,
               defaultObstacleMargin=clearance, minTraceToPadEdgeClearance=clearance,
               minPadEdgeToPadEdgeClearance=clearance, minViaEdgeToPadEdgeClearance=clearance,
               minTraceToHoleEdgeClearance=hole_clearance,
               minViaHoleEdgeToViaHoleEdgeClearance=rules['min_hole_to_hole'],
               minBoardEdgeClearance=rules['min_copper_edge_clearance'],
               allowViaInPad=False, allowJumpers=False, allowBlindAndBuriedVias=False,
               bounds=dict(minX=min(p['x'] for p in boundary), maxX=max(p['x'] for p in boundary),
                           minY=min(p['y'] for p in boundary), maxY=max(p['y'] for p in boundary)),
               outline=boundary, obstacles=obstacles, traces=preloaded,
               connections=[dict(name=n, nominalTraceWidth=class_rules[names[n]]['track_width'],
                                 pointsToConnect=points[n], externallyConnectedPointIds=connected[n]) for n in nets])
    if any(len(c['pointsToConnect']) < 2 for c in srj['connections']):
        raise ValueError('selected net needs at least two physical terminals')
    out.mkdir(parents=True, exist_ok=False)
    target = out/'input.kicad_pcb'
    pcb.SaveBoard(str(target), b)
    for ext in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
        shutil.copy2(board.with_suffix(ext), target.with_suffix(ext))
    protected = geometry_digest(board, removed)
    if protected != geometry_digest(target):
        raise ValueError('export changed native content outside selected tracks')
    (out/'srj.json').write_text(json.dumps(srj, indent=2))
    record = dict(schema='iot-lab.native-srj.v1', qualified=False, sources=before,
                  input_files=source_set(target), srj_sha256=fingerprint(srj), selected_nets=nets,
                  removed_items=removed, kicad_version=pcb.GetBuildVersion(),
                  protected_geometry_sha256=protected,
                  approximation='pad/keepout envelopes; exact retained track centerlines; native validation required',
                  native_and_board_specific_gates_required=True)
    if source_set(board) != before:
        raise ValueError('source project changed during export')
    (out/'record.json').write_text(json.dumps(record, indent=2))
    return dict(status='candidate', selected_nets=nets, removed=len(removed), obstacles=len(obstacles),
                terminals=sum(len(v) for v in points.values()), qualified=False)


def import_routes(folder, result_path, out):
    import pcbnew as pcb
    folder, out = Path(folder).resolve(), Path(out).resolve()
    native = folder/'input.kicad_pcb'
    manifest = json.loads((folder/'record.json').read_text())
    srj = json.loads((folder/'srj.json').read_text())
    result = json.loads(Path(result_path).read_text())
    if (manifest['input_files'] != source_set(native) or manifest['srj_sha256'] != fingerprint(srj)
            or result.get('input_sha256') != fingerprint(srj) or result.get('status') != 'candidate'
            or result.get('qualified') is not False):
        raise ValueError('native inputs or route response changed/mismatch')
    from .capacity import route_crossings
    if route_crossings(srj, result['output']['traces']):
        raise ValueError('new copper crosses protected or other-net routing')
    b = pcb.LoadBoard(str(native)); nets = b.GetNetsByName()
    layer_ids = {'top': pcb.F_Cu, 'bottom': pcb.B_Cu}
    preserved = {t['pcb_trace_id']: t for t in srj.get('traces', [])}
    original_vias = {t.m_Uuid.AsString(): t for t in b.GetTracks() if type(t) is pcb.PCB_VIA}
    added_items, trace_ids, reused_vias = [], set(), set()
    # Keep newly created native proxies alive through SaveBoard as well.
    new_objects = []
    for trace in result['output']['traces']:
        name = trace.get('connection_name')
        tid = trace.get('pcb_trace_id')
        if not tid or tid in trace_ids:
            raise ValueError('route net or identity mismatch')
        trace_ids.add(tid)
        if tid in preserved:
            from .capacity import retains_fields
            if not retains_fields(trace, preserved[tid]):
                raise ValueError('retained copper changed')
            continue
        if name not in manifest['selected_nets']:
            raise ValueError('new route is outside selected nets')
        route = trace['route']
        wires = [p for p in route if p['route_type'] == 'wire']
        if len({pcb.FromMM(number(p['width'], 'width', True)) for p in wires}) > 1:
            raise ValueError('variable-width segment semantics require a verified importer')
        last = None
        for p in route:
            x, y = xy([p['x'], p['y']])
            bounds = srj['bounds']
            if not (bounds['minX'] <= x <= bounds['maxX'] and bounds['minY'] <= y <= bounds['maxY']):
                raise ValueError('route point outside board bounds')
            point = pcb.VECTOR2I(pcb.FromMM(x), pcb.FromMM(y))
            if p['route_type'] == 'via':
                pair = {p['from_layer'], p['to_layer']}
                if pair != set(layer_ids):
                    raise ValueError('unsupported via layer pair')
                diameter = number(p.get('via_diameter', srj['minViaPadDiameter']), 'via diameter', True)
                drill = number(p.get('via_hole_diameter', srj['minViaHoleDiameter']), 'via drill', True)
                if last and (last[0].x != point.x or last[0].y != point.y or last[1] != p['from_layer']):
                    raise ValueError('via is not at the current route endpoint')
                reuse_id = p.get('reuse_via_id')
                if reuse_id is not None:
                    v = original_vias.get(reuse_id)
                    if (reuse_id not in preserved or v is None or v.GetNetname() != name
                            or v.GetViaType() != pcb.VIATYPE_THROUGH
                            or not v.IsOnLayer(pcb.F_Cu) or not v.IsOnLayer(pcb.B_Cu)
                            or v.GetPosition() != point or v.GetWidth() != pcb.FromMM(diameter)
                            or v.GetDrillValue() != pcb.FromMM(drill)):
                        raise ValueError('reused via does not match original native copper')
                    last = (point, p['to_layer'], None)
                    reused_vias.add(reuse_id)
                    continue
                if (pcb.FromMM(diameter) != pcb.FromMM(srj['minViaPadDiameter'])
                        or pcb.FromMM(drill) != pcb.FromMM(srj['minViaHoleDiameter'])):
                    raise ValueError('via geometry differs from sourced policy')
                v = pcb.PCB_VIA(b); v.SetPosition(point); v.SetWidth(pcb.FromMM(diameter)); v.SetDrill(pcb.FromMM(drill))
                v.SetViaType(pcb.VIATYPE_THROUGH); v.SetLayerPair(pcb.F_Cu, pcb.B_Cu); v.SetNetCode(nets[name].GetNetCode())
                b.Add(v); new_objects.append(v); added_items.append(v.m_Uuid.AsString()); last = (point, p['to_layer'], None)
            elif p['route_type'] == 'wire':
                layer = p['layer']; width = number(p['width'], 'trace width', True)
                if layer not in layer_ids or pcb.FromMM(width) < pcb.FromMM(srj['minTraceWidth']):
                    raise ValueError('unsupported layer or undersized trace')
                if last and last[1] != layer:
                    raise ValueError('wire changed layer without a via')
                if last and (last[0].x != point.x or last[0].y != point.y):
                    t = pcb.PCB_TRACK(b); t.SetStart(last[0]); t.SetEnd(point); t.SetWidth(pcb.FromMM(width))
                    t.SetLayer(layer_ids[layer]); t.SetNetCode(nets[name].GetNetCode()); b.Add(t)
                    new_objects.append(t); added_items.append(t.m_Uuid.AsString())
                last = (point, layer, width)
            else:
                raise ValueError('unsupported route element: ' + p['route_type'])
    if not set(preserved) <= trace_ids:
        raise ValueError('retained copper missing from response')
    if not added_items:
        raise ValueError('proposal adds no routing')
    out.mkdir(parents=True, exist_ok=False)
    target = out/'candidate.kicad_pcb'
    pcb.SaveBoard(str(target), b)
    for ext in ('.kicad_pro', '.kicad_dru', '.kicad_sch'):
        shutil.copy2(native.with_suffix(ext), target.with_suffix(ext))
    protected = geometry_digest(native)
    if protected != geometry_digest(target, added_items) or manifest['input_files'] != source_set(native):
        raise ValueError('import changed protected native geometry or its source')
    record = dict(status='candidate', qualified=False, added=len(added_items), added_items=added_items,
                  reused_via_ids=sorted(reused_vias),
                  protected_geometry_sha256=protected, input_files=manifest['input_files'],
                  route_sha256=digest(result_path), output_files=source_set(target),
                  native_and_board_specific_gates_required=True)
    (out/'record.json').write_text(json.dumps(record, indent=2))
    return record


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    subs = ap.add_subparsers(dest='mode', required=True)
    e = subs.add_parser('export'); e.add_argument('board'); e.add_argument('out'); e.add_argument('--net', action='append', required=True)
    i = subs.add_parser('import'); i.add_argument('folder'); i.add_argument('result'); i.add_argument('out')
    s = subs.add_parser('scope'); s.add_argument('folder'); s.add_argument('result'); s.add_argument('out')
    r = subs.add_parser('repair'); r.add_argument('folder'); r.add_argument('result'); r.add_argument('out')
    r.add_argument('--budget-s', type=float, required=True)
    a = ap.parse_args()
    try:
        if a.mode == 'export':
            result = export(a.board, a.out, a.net)
        elif a.mode == 'scope':
            result = scope_routes(a.folder, a.result, a.out)
        elif a.mode == 'repair':
            result = scope_routes(a.folder, a.result, a.out, repair_budget=a.budget_s)
        else:
            result = import_routes(a.folder, a.result, a.out)
        success = result['status'] == 'candidate'
        print(('PASS' if success else 'STUCK') + ': native/SRJ proposal step; native validation required; ' + json.dumps(result))
        return 0 if success else 3
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('STUCK: ' + str(error))
        return 3


if __name__ == '__main__':
    raise SystemExit(main())
