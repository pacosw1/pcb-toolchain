"""Conservative pre-solver coverage of native rules by the actual DSN model.

This is an admission check, not native acceptance. Unrepresented routing
semantics (including creepage and spatial selectors) block, even with the rule
compiler enabled. No flags bypass the check. Final native gates still apply.
"""
import ast
from decimal import Decimal, InvalidOperation
import fnmatch
import hashlib
import json
from pathlib import Path
import re

import route_features
import route_hole_coverage
import route_project_coverage

SCHEMA = 'iot-lab.route-rule-coverage.v1'
UNKNOWN = object()
UNITS = {'mm': Decimal(1), 'um': Decimal('0.001'),
         'mil': Decimal('0.0254'), 'in': Decimal('25.4')}


def _forms(text, *, dsn=False):
    if dsn:
        text = re.sub(r'\(string_quote\s+"\)', '(string_quote quote)', text)
    clean = re.sub(r'(?m)^\s*#.*$', '', text)
    tokens, end = [], 0
    for match in re.finditer(r'"(?:[^"\\]|\\.)*"|[()]|[^\s()"]+', clean):
        if clean[end:match.start()].strip():
            raise ValueError('invalid or unterminated rule/model token')
        tokens.append(match[0])
        end = match.end()
    if clean[end:].strip():
        raise ValueError('invalid or unterminated rule/model token')
    depth = 0
    for token in tokens:
        if token == '(':
            depth += 1
        elif token == ')':
            depth -= 1
            if depth < 0:
                raise ValueError('unbalanced rule/model parentheses')
    if depth:
        raise ValueError('unbalanced rule/model parentheses')
    return route_features.sexpr(clean)


def _children(form, name):
    return [v for v in form if isinstance(v, list) and v and v[0] == name]


def _number(value, unit='mm'):
    match = re.fullmatch(r'([+]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|um|mil|in)?', str(value))
    if not match or (match[2] or unit) not in UNITS:
        raise ValueError('unsupported numeric value or units: ' + str(value))
    result = Decimal(match[1]) * UNITS[match[2] or unit]
    if not result.is_finite():
        raise ValueError('nonfinite rule/model value')
    return result


def _condition(expression, a, b):
    """Three-valued, non-executing subset of KiCad's selector language."""
    if not isinstance(expression, str):
        return UNKNOWN
    # Translate operators only outside quoted literals (net names can contain
    # !, && or ||). This never executes the native selector as Python code.
    expression = re.sub(r'''"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|&&|\|\||!(?!=)''',
        lambda m: {'&&': ' and ', '||': ' or ', '!': ' not '}.get(m[0], m[0]), expression).strip()
    try:
        tree = ast.parse(expression, mode='eval')
    except (SyntaxError, ValueError):
        return UNKNOWN

    def evaluate(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, (str, bool)):
            return node.value
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            obj = {'A': a, 'B': b}.get(node.value.id)
            return obj.get(node.attr, UNKNOWN) if obj is not None else UNKNOWN
        if isinstance(node, ast.BoolOp):
            values = [evaluate(v) for v in node.values]
            values = [v if isinstance(v, bool) else UNKNOWN for v in values]
            if isinstance(node.op, ast.And):
                return False if any(v is False for v in values) else UNKNOWN if any(v is UNKNOWN for v in values) else all(values)
            if isinstance(node.op, ast.Or):
                return True if any(v is True for v in values) else UNKNOWN if any(v is UNKNOWN for v in values) else any(values)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            value = evaluate(node.operand)
            return UNKNOWN if value is UNKNOWN else not value
        if isinstance(node, ast.Compare) and len(node.ops) == len(node.comparators) == 1:
            lhs, rhs = node.left, node.comparators[0]
            if isinstance(lhs, ast.Constant) and isinstance(rhs, ast.Attribute):
                lhs, rhs = rhs, lhs
            if not isinstance(lhs, ast.Attribute) or not isinstance(rhs, ast.Constant) or not isinstance(rhs.value, str):
                return UNKNOWN
            if '[' in rhs.value or ']' in rhs.value:
                return UNKNOWN
            left, right = evaluate(lhs), evaluate(rhs)
            if left is UNKNOWN or right is UNKNOWN:
                return UNKNOWN
            if isinstance(node.ops[0], (ast.Eq, ast.NotEq)):
                equal = fnmatch.fnmatchcase(left, right) if isinstance(left, str) and isinstance(right, str) else left == right
                return not equal if isinstance(node.ops[0], ast.NotEq) else equal
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name) and node.func.attr == 'inDiffPair'
                and len(node.args) == 1 and not node.keywords):
            obj = {'A': a, 'B': b}.get(node.func.value.id)
            base = evaluate(node.args[0])
            if obj is not None and isinstance(base, str) and not any(x in base for x in '*?['):
                return obj.get('NetName') in {base + s for s in ('_P', '_N', '+', '-', 'P', 'N')}
        return UNKNOWN

    value = evaluate(tree.body)
    return value if isinstance(value, bool) else UNKNOWN


class Model:
    def __init__(self, text, layers):
        forms = _forms(text, dsn=True)
        if len(forms) != 1 or forms[0][:1] != ['pcb']:
            raise ValueError('expected one complete DSN PCB')
        root = forms[0]
        unit = _children(root, 'unit')
        if len(unit) != 1 or len(unit[0]) != 2 or unit[0][1] not in UNITS:
            raise ValueError('unknown or ambiguous DSN units')
        resolution = _children(root, 'resolution')
        if (len(resolution) != 1 or len(resolution[0]) != 3
                or resolution[0][1] != unit[0][1]
                or not re.fullmatch(r'[1-9][0-9]*', str(resolution[0][2]))
                or int(resolution[0][2]) > 2147483647):
            raise ValueError('DSN resolution and unit must agree unambiguously')
        self.unit = unit[0][1]
        networks, structures = _children(root, 'network'), _children(root, 'structure')
        if len(networks) != 1 or len(structures) != 1:
            raise ValueError('missing or ambiguous DSN network/structure')
        signal_layers, seen_layers = [], set()
        for layer in _children(structures[0], 'layer'):
            types = _children(layer, 'type')
            if len(layer) < 2 or layer[1] in seen_layers or len(types) != 1 or len(types[0]) != 2 or types[0][1] not in ('signal', 'power'):
                raise ValueError('unknown or ambiguous actual DSN layer type')
            seen_layers.add(layer[1])
            if types[0][1] == 'signal':
                signal_layers.append(layer[1])
        if not signal_layers or not set(layers) <= set(signal_layers):
            raise ValueError('requested layers absent from actual DSN signal layers')
        self.actual_layers = seen_layers
        self.classes, self.membership, self.pairs = {}, {}, {}
        self.defaults = self.clearances(structures[0])
        if not self.defaults:
            raise ValueError('no explicit DSN fallback clearance')
        self.all_clearances = []
        def gather(form):
            if not isinstance(form, list):
                return
            if form[:1] == ['clearance']:
                if form[2:] not in ([['type', 'smd_smd']], [['type', 'pin_pin']], [['type', 'pin_smd']]):
                    if len(form) < 2:
                        raise ValueError('invalid nested DSN clearance')
                    self.all_clearances.append(_number(form[1], self.unit))
            for item in form:
                if isinstance(item, list):
                    gather(item)
        gather(root)
        for form in _children(networks[0], 'class'):
            if len(form) < 2 or form[1] in self.classes:
                raise ValueError('ambiguous DSN class')
            circuit = _children(form, 'circuit')
            masks = _children(circuit[0], 'use_layer') if len(circuit) == 1 else []
            if len(circuit) > 1 or len(masks) > 1:
                raise ValueError('ambiguous DSN layer mask')
            allowed = masks[0][1:] if masks else list(signal_layers)
            if not allowed or len(set(allowed)) != len(allowed) or not set(allowed) <= set(signal_layers):
                raise ValueError('invalid DSN layer mask')
            self.classes[form[1]] = dict(layers=allowed, clearances=self.clearances(form))
            for net in [v for v in form[2:] if isinstance(v, str)]:
                if net in self.membership:
                    raise ValueError('ambiguous DSN net membership: ' + net)
                self.membership[net] = form[1]
        for form in _children(networks[0], 'class_class'):
            names = _children(form, 'classes')
            if len(names) != 1 or len(names[0]) != 3 or not set(names[0][1:]) <= set(self.classes):
                raise ValueError('invalid DSN class-pair membership')
            key = tuple(sorted(names[0][1:]))
            if key in self.pairs:
                raise ValueError('ambiguous DSN class-pair rules')
            self.pairs[key] = self.clearances(form)

    def clearances(self, form):
        result = []
        for rule in _children(form, 'rule'):
            for item in _children(rule, 'clearance'):
                # Exported pad-to-pad exceptions cannot apply to new tracks/vias.
                if item[2:] in ([['type', 'smd_smd']], [['type', 'pin_pin']], [['type', 'pin_smd']]):
                    continue
                if len(item) < 2:
                    raise ValueError('invalid DSN clearance')
                result.append(_number(item[1], self.unit))
        return result

    def allowed(self, net):
        return self.classes[self.membership[net]]['layers']

    def clearance_floor(self, left, right):
        ca = self.membership[left]
        cb = self.membership[right] if right else None
        values = list(self.defaults) + self.classes[ca]['clearances']
        if cb is not None:
            values += self.classes[cb]['clearances'] + self.pairs.get(tuple(sorted((ca, cb))), [])
        if not values:
            raise ValueError('no attributable DSN clearance')
        # Do not assume unproven class/type/precedence overrides. This lower
        # bound admits only if every potentially applicable declaration suffices.
        return min(values + self.all_clearances)


def project_clearance_requirement(text, *, source, active_nets, net_classes, obstacles):
    """Extract only authored clearances applicable to this new-copper scope.

    Reuses the project parser and the active/retained pair semantics of
    route_project_coverage.evaluate. This does not certify any router model.
    """
    rules, classes = route_project_coverage._load(text)
    active = set(active_nets)
    if (not active or any(not isinstance(n, str) or not n for n in active)
            or not isinstance(net_classes, dict) or not active <= set(net_classes)):
        raise ValueError('clearance strengthening requires exact active native nets/classes')
    counterparts = set(active)
    for obj in obstacles:
        if (not isinstance(obj, dict) or not isinstance(obj.get('NetName'), str)
                or obj['NetName'] not in net_classes):
            raise ValueError('clearance strengthening has an unknown retained native net')
        counterparts.add(obj['NetName'])
    if any(not isinstance(net_classes[n], str) or not net_classes[n] for n in counterparts):
        raise ValueError('clearance strengthening has an unknown native class')
    pairs = [(a, b) for a in sorted(active) for b in sorted(counterparts) if a != b]
    requirements = []
    for name in sorted({net_classes[n] for n in counterparts}):
        index, item = classes.get(name, (None, None))
        if item is None or 'clearance' not in item:
            raise ValueError('actual native netclass clearance is unresolved: ' + name)
        value = route_project_coverage._number(item['clearance'])
        relevant = [(a, b) for a, b in pairs if name in (net_classes[a], net_classes[b])]
        if relevant:
            requirements.append(dict(constraint='netclass_clearance', netclass=name,
                source=dict(path=str(source), pointer='/net_settings/classes/' + str(index) + '/clearance'),
                required_mm=str(value), witness=dict(active=relevant[0][0], obstacle=relevant[0][1])))
    if 'min_clearance' not in rules:
        raise ValueError('native project min_clearance is absent; no default is inferred')
    value = route_project_coverage._number(rules['min_clearance'])
    if pairs:
        requirements.append(dict(constraint='min_clearance',
            source=dict(path=str(source), pointer='/board/design_settings/rules/min_clearance'),
            required_mm=str(value), witness=dict(active=pairs[0][0], obstacle=pairs[0][1])))
    return dict(required_mm=str(max([Decimal(0)] + [Decimal(r['required_mm']) for r in requirements])),
                requirements=requirements, active_nets=sorted(active), counterparts=sorted(counterparts))


def inspect(dru_text, dsn_text, *, active_nets, net_classes, obstacles,
            layers, require_stitching=False, native_pads=None):
    result = dict(schema=SCHEMA, status='blocked', solver_launch_allowed=False,
        active_nets=sorted(active_nets), job_layers=list(layers), requirements=[], qualified=False,
        scope='native custom-rule model coverage only; final fresh native/configured gates remain mandatory')
    rows = result['requirements']
    try:
        model = Model(dsn_text, layers)
        if not active_nets or not set(active_nets) <= set(net_classes) or not set(active_nets) <= set(model.membership):
            raise ValueError('active native nets are absent from native or final DSN classes')
        if any(n and n not in model.membership for n in net_classes):
            raise ValueError('retained native obstacle net absent from final DSN model')
        if any(not set(model.allowed(n)) <= set(layers) for n in active_nets):
            raise ValueError('actual DSN permits undeclared routing layers for an active net')
        moving = []
        for net in sorted(active_nets):
            for kind in ('Track', 'Via') if len(model.allowed(net)) > 1 else ('Track',):
                moving.append(dict(NetName=net, NetClass=net_classes[net], Type=kind, Pad_Type=''))
        fixed = []
        for obj in obstacles:
            if not isinstance(obj, dict) or obj.get('NetName') not in net_classes or not isinstance(obj.get('Type'), str):
                raise ValueError('unknown retained obstacle identity/type')
            fixed.append(dict(obj, NetClass=net_classes[obj['NetName']]))
        counterparts = fixed + moving
        forms = _forms(dru_text)
        for form in forms:
            if form == ['version', '1']:
                continue
            if not isinstance(form, list) or len(form) < 2 or form[0] != 'rule':
                raise ValueError('unsupported native rules document/version')
            rule = form[1]
            conditions, rule_layers = _children(form, 'condition'), _children(form, 'layer')
            if len(conditions) > 1 or len(rule_layers) > 1 or any(len(v) != 2 for v in conditions + rule_layers):
                raise ValueError('ambiguous native rule condition/layer')
            condition = conditions[0][1] if conditions else 'True'
            constraint_forms = _children(form, 'constraint')
            if not constraint_forms or any(not isinstance(v, list) or not v or v[0] not in ('condition', 'layer', 'constraint') for v in form[2:]):
                raise ValueError('unsupported native rule fields: ' + str(rule))
            for constraint in constraint_forms:
                if len(constraint) < 2:
                    raise ValueError('invalid native constraint')
                kind = constraint[1]
                row = dict(rule=rule, constraint=kind, disposition='unsupported')
                rows.append(row)
                if kind == 'silk_clearance' and not any(v['Type'] == 'Via' for v in moving):
                    row.update(disposition='immutable_unchanged',
                        reason='single-layer router adds covered tracks, no new holes; source and import/final identity guards preserve masks, silk and outline')
                    continue
                if kind == 'disallow' and constraint[2:] == ['pad']:
                    row.update(disposition='immutable_unchanged', reason='router does not modify footprint/pad geometry; import identity guard remains required')
                    continue
                if kind in ('hole_to_hole', 'hole_size', 'annular_width', 'via_diameter') and not any(v['Type'] == 'Via' for v in moving):
                    row.update(disposition='immutable_unchanged', reason='verified single-layer model introduces no new via/hole transitions')
                    continue
                if (rule_layers and rule_layers[0][1] in model.actual_layers
                        and all(rule_layers[0][1] not in model.allowed(n) for n in active_nets)):
                    row.update(disposition='not_applicable',
                        reason='exact native layer cannot receive new copper under every actual active-net mask')
                    continue
                applicable, uncertain = [], False
                binary = kind in ('clearance', 'creepage', 'hole_clearance', 'hole_to_hole')
                for new in moving:
                    for other in counterparts if binary else [{}]:
                        for a, b in ((new, other), (other, new)) if binary else ((new, other),):
                            value = _condition(condition, a, b)
                            if value is UNKNOWN:
                                uncertain = True
                            elif value:
                                applicable.append((new, other))
                    if applicable and kind not in ('clearance', 'hole_clearance'):
                        break
                if uncertain:
                    row['reason'] = 'native selector applicability cannot be proved (spatial/unsupported terms are not compiled coverage)'
                    continue
                if not applicable:
                    row.update(disposition='not_applicable', reason='selector false for every active track/via and retained obstacle orientation')
                    continue
                row['witness'] = dict(active=applicable[0][0]['NetName'], obstacle=applicable[0][1].get('NetName'))
                if rule_layers:
                    row['reason'] = 'layer-dependent native rule precedence is not represented by this coverage subset'
                elif kind == 'clearance':
                    bounds = constraint[2:]
                    if len(bounds) != 1 or not isinstance(bounds[0], list) or len(bounds[0]) != 2 or bounds[0][0] != 'min':
                        row['reason'] = 'only a native minimum clearance is covered'
                        continue
                    required = _number(bounds[0][1])
                    floors = [model.clearance_floor(a['NetName'], b['NetName']) for a, b in applicable]
                    row.update(required_mm=str(required), model_floor_mm=str(min(floors)))
                    row.update(disposition='covered' if min(floors) >= required else 'weaker_than_native',
                               reason='conservative lower bound of actual final DSN declarations; no override precedence assumed')
                elif kind == 'hole_clearance':
                    bounds = constraint[2:]
                    if (len(bounds) != 1 or not isinstance(bounds[0], list)
                            or len(bounds[0]) != 2 or bounds[0][0] != 'min'):
                        row['reason'] = 'only a native minimum hole clearance is covered'
                        continue
                    if (native_pads is None or not native_pads
                            or any(a['Type'] != 'Track' or b.get('Type') != 'Pad'
                                   or b.get('Pad_Type') != 'Through-hole' for a, b in applicable)
                            or not {b['NetName'] for _, b in applicable}
                                   <= {p.get('net') for p in native_pads}):
                        row['reason'] = 'hole coverage requires exact retained PTH geometry and tracks only'
                        continue
                    required = _number(bounds[0][1])
                    floors = [model.clearance_floor(a['NetName'], b['NetName']) for a, b in applicable]
                    proof = route_hole_coverage.inspect(dsn_text, pads=native_pads,
                        active_nets=sorted(active_nets), layers=layers,
                        required_mm=str(required), clearance_floor_mm=str(min(floors)))
                    row.update(required_mm=str(required), hole_geometry=proof,
                        disposition='covered' if proof.get('status') == 'covered' else 'unsupported',
                        reason=proof.get('cause', 'actual exported PTH copper containment was not proved'))
                elif kind == 'disallow' and set(constraint[2:]) <= {'via'} and constraint[2:]:
                    row.update(disposition='covered' if all(len(model.allowed(a['NetName'])) == 1 for a, _ in applicable) else 'weaker_than_native',
                               reason='native via prohibition requires verified single-layer routing for every applicable active net')
                else:
                    row['reason'] = 'applicable native constraint has no proven enforcement in the actual DSN model'
        if require_stitching:
            multilevel = [n for n in sorted(active_nets) if len(model.allowed(n)) != 1]
            rows.append(dict(rule='configured kicad_happy RP-001', constraint='reference_stitching',
                disposition='unsupported' if multilevel else 'covered',
                reason='no bound stitching producer; active net masks must prevent new layer transitions', nets=multilevel))
        blockers = [r for r in rows if r['disposition'] not in ('covered', 'immutable_unchanged', 'not_applicable')]
        result.update(status='blocked' if blockers else 'passed', solver_launch_allowed=not blockers,
            cause='; '.join(str(r['rule']) + ': ' + r['constraint'] + ' ' + r['disposition'] for r in blockers) or 'applicable native requirements covered by final DSN model')
    except (ValueError, KeyError, IndexError, TypeError, InvalidOperation) as error:
        result.update(cause=str(error))
        rows.append(dict(rule='coverage admission', constraint='model_or_rules', disposition='unsupported', reason=str(error)))
    return result


def check_files(board, base, dsn, *, active_nets, net_classes, obstacles, layers, gate=None,
                backend_command=None, backend_policy=None, native_thermal_capability=None):
    """Bind the pure decision to exact original inputs and final transformed DSN."""
    board, base, dsn = Path(board), Path(base), Path(dsn)
    rules, base_rules = board.with_suffix('.kicad_dru'), base.with_suffix('.kicad_dru')
    paths = [board, base, dsn, Path(__file__).resolve(), Path(route_features.__file__).resolve(),
             Path(route_hole_coverage.__file__).resolve(), Path(route_project_coverage.__file__).resolve()]
    if native_thermal_capability is not None:
        import route_native_thermals
        paths.append(Path(route_native_thermals.__file__).resolve())
    project, base_project = board.with_suffix('.kicad_pro'), base.with_suffix('.kicad_pro')
    paths.extend([rules, base_rules, project, base_project])
    command = list(backend_command) if isinstance(backend_command, list) else backend_command
    try:
        policy = json.loads(json.dumps(backend_policy,allow_nan=False)) if isinstance(backend_policy, dict) else backend_policy
    except (ValueError, TypeError) as error:
        raise ValueError('backend policy is not finite attributable JSON') from error
    if isinstance(command, list) and command and isinstance(command[0], str):
        paths.append(Path(command[0]))
    from pcb_search import block_bindings, native_placement, contracts
    from placer import dru
    paths.extend([Path(m.__file__) for m in (block_bindings, native_placement, contracts, dru)])
    if gate is not None:
        paths.append(Path(gate))
    before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None for p in paths}
    def footprint_identity(path):
        result = {}
        for fp in block_bindings.footprints(path):
            reference = fp['props'].get('Reference')
            if not reference or reference in result:
                raise ValueError('ambiguous native footprint membership')
            result[reference] = dict(signature=native_placement.footprint_signature(fp),
                pose=[str(v.normalize()) for v in fp['pose']])
        return result
    source_footprints = footprint_identity(board)
    if source_footprints != footprint_identity(base):
        raise ValueError('footprint/pad definitions or poses changed before routing admission')

    def fixed_geometry(path):
        roots = _forms(path.read_text())
        if len(roots) != 1 or roots[0][:1] != ['kicad_pcb']:
            raise ValueError('expected one complete native PCB for project applicability')
        values = []
        for form in roots[0][1:]:
            if not isinstance(form, list) or not form:
                raise ValueError('malformed native board geometry')
            if form[0] in ('segment', 'arc', 'via', 'footprint'):
                continue
            if form[0] == 'zone':
                form = [v for v in form if not (isinstance(v, list) and v
                    and v[0] in ('filled_polygon', 'fill_segments'))]
            values.append(json.dumps(form, sort_keys=True))
        return sorted(values)

    fixed_preserved = fixed_geometry(board) == fixed_geometry(base)
    try:
        thermal = route_project_coverage.thermal_scope(
            [root for path in (board, base) for root in _forms(path.read_text())],
            _forms(rules.read_text()) if rules.is_file() else [])
    except ValueError as error:
        thermal = dict(thermal_connections_possible=True, reason=str(error))
    config = json.loads(Path(gate).read_text()) if gate is not None else {}
    if not isinstance(config, dict) or not isinstance(config.get('checks', {}), dict):
        raise ValueError('invalid configured board gate')
    checks = config.get('checks', {})
    # Unsupported PTH geometry must block a hole proof, without hiding the
    # more specific diagnostics for unrelated rules on other boards.
    pad_error = None
    try:
        native_pads = route_hole_coverage.native_pth_pads(base)
    except (ValueError, ArithmeticError) as error:
        native_pads, pad_error = None, str(error)
    result = inspect(rules.read_text() if rules.is_file() else '', dsn.read_text(),
        active_nets=active_nets, net_classes=net_classes, obstacles=obstacles, layers=layers,
        require_stitching='kicad_happy' in checks and checks['kicad_happy'] is not False,
        native_pads=native_pads)
    if pad_error:
        result['native_pth_geometry_unknown'] = pad_error
    drilled_error = None
    try:
        original_holes = route_hole_coverage.native_drilled_geometry(board)
        holes = route_hole_coverage.native_drilled_geometry(base)
        holes_preserved = sorted(original_holes, key=lambda h: h['identity']) == sorted(holes, key=lambda h: h['identity'])
    except (ValueError, ArithmeticError) as error:
        holes, holes_preserved, drilled_error = None, False, str(error)
    if drilled_error:
        result['native_drilled_geometry_unknown'] = drilled_error
    native_capability = None
    if native_thermal_capability is not None:
        try:
            supplied = json.loads(json.dumps(native_thermal_capability, allow_nan=False))
            native_capability = route_native_thermals.validate_capability(
                supplied, board, base, selected_nets=sorted(active_nets))
            for name, digest in native_capability['inputs'].items():
                if (not isinstance(name, str) or not (digest is None or
                        isinstance(digest, str) and re.fullmatch(r'[0-9a-f]{64}', digest))):
                    raise ValueError('native thermal evidence has an invalid input binding')
                if name in before and before[name] != digest:
                    raise ValueError('native thermal input changed during admission: ' + name)
                before[name] = digest
        except (OSError, ValueError, KeyError, TypeError, ArithmeticError) as error:
            native_capability = None
            result['requirements'].append(dict(rule='native thermal capability',
                constraint='native_thermal_evidence', disposition='unsupported', reason=str(error)))
    # Pure inspect retains its historical analytic subset for callers. Actual
    # solver admission must additionally prove the backend's physical obstacle
    # transform, even when the project has a smaller (or zero) hole minimum.
    for row in result['requirements']:
        if row.get('constraint') != 'hole_clearance' or row.get('disposition') != 'covered':
            continue
        row['analytical_hole_geometry'] = row.get('hole_geometry')
        try:
            if holes is None or not holes_preserved:
                raise ValueError('custom hole clearance requires complete unchanged drilled geometry')
            model = Model(dsn.read_text(), layers)
            floor = min((model.clearance_floor(net, hole.get('net') or None)
                for net in active_nets for hole in holes), default=Decimal(0))
            proof = route_hole_coverage.inspect_drilled(dsn.read_text(), holes=holes,
                active_nets=sorted(active_nets), layers=layers,
                required_mm=row['required_mm'], clearance_floor_mm=str(floor),
                applicability='custom_pth_track', backend_command=command, backend_policy=policy)
            row.update(hole_geometry=proof,
                disposition='covered' if proof.get('status') == 'covered' else 'unsupported',
                reason=proof.get('cause', 'actual backend drilled containment proof'))
        except (ValueError, KeyError, TypeError, ArithmeticError) as error:
            row.update(disposition='unsupported', reason=str(error))
    try:
        model = Model(dsn.read_text(), layers)
        project_rows = route_project_coverage.evaluate(project.read_text() if project.is_file() else None,
            source=project, model=model, dsn_text=dsn.read_text(), active_nets=active_nets,
            net_classes=net_classes, obstacles=obstacles, layers=layers, holes=holes,
            holes_preserved=holes_preserved, immutable_geometry_preserved=fixed_preserved,
            backend_command=command, thermal=thermal, backend_policy=policy,
            native_thermal_capability=native_capability)
    except (ValueError, KeyError, TypeError, ArithmeticError) as error:
        project_rows = [dict(rule='native project', constraint='project_model', disposition='unsupported', reason=str(error))]
    result['requirements'].extend(project_rows)
    for row in result['requirements']:
        geometry = row.get('hole_geometry', [])
        proofs = [geometry] if isinstance(geometry, dict) else [item.get('proof', {}) for item in geometry]
        for proof in proofs:
            for name, digest in proof.get('inputs', {}).items():
                if not isinstance(name, str) or not (digest is None or isinstance(digest,str) and re.fullmatch(r'[0-9a-f]{64}',digest)):
                    raise ValueError('invalid backend proof input binding')
                if name in before and before[name] != digest:
                    raise ValueError('backend proof input changed during admission')
                before[name] = digest
    if before[str(project)] is None or before[str(project)] != before[str(base_project)]:
        result['requirements'].append(dict(rule='native project', constraint='project_source', disposition='unsupported',
            reason='actual base project is absent or differs from the original authored project',
            source=dict(path=str(project)), base_project=str(base_project)))
    if before[str(rules)] != before[str(base_rules)]:
        result['requirements'].append(dict(rule='native custom rules', constraint='rule_source', disposition='unsupported',
            reason='actual base custom-rule presence/bytes differ from the original authored rules',
            source=dict(path=str(rules)), base_rules=str(base_rules)))
    command_error = None
    if command is not None:
        try:
            _validate_backend_command(command, dsn)
            if not Path(command[0]).is_file():
                raise ValueError('planned backend executable is not an attributable file')
        except (ValueError, TypeError, IndexError) as error:
            command_error = str(error)
            result['requirements'].append(dict(rule='native project', constraint='backend_command',
                disposition='unsupported', reason=command_error))
    serializable_command = command if isinstance(command, list) and all(isinstance(v, str) for v in command) else None
    result.update(scope='native custom/project rule model coverage; final fresh native/configured gates remain mandatory',
        backend_command=serializable_command, backend_command_sha256=(hashlib.sha256(json.dumps(serializable_command,
            separators=(',', ':'), ensure_ascii=True).encode()).hexdigest() if serializable_command is not None else None),
        backend_policy=policy if isinstance(policy, dict) else None,
        drilled_geometry_preserved=holes_preserved, fixed_geometry_preserved=fixed_preserved)
    obligations = [r['native_obligation'] for r in result['requirements']
                   if r['disposition'] == 'native_postcondition']
    blockers = [r for r in result['requirements'] if r['disposition'] not in
                ('covered', 'immutable_unchanged', 'not_applicable', 'native_postcondition')]
    result.update(status='blocked' if blockers else ('pending_native' if obligations else 'passed'),
        solver_launch_allowed=not blockers,
        model_status='blocked' if blockers else ('partial' if obligations else 'complete'),
        cause='; '.join(str(r['rule']) + ': ' + r['constraint'] + ' ' + r['disposition'] + ': ' + r.get('reason', '')
            for r in blockers) or ('model admission complete except explicit pending native thermal postconditions'
                if obligations else 'applicable native custom/project requirements covered by final DSN and exact backend controls'))
    if native_capability is not None:
        result.update(native_thermal_capability=native_capability, native_postconditions=obligations)
    result.update(inputs=before, dsn=dict(path=str(dsn), sha256=before[str(dsn)]),
        native_classes=net_classes, footprint_scope_sha256=hashlib.sha256(json.dumps(source_footprints, sort_keys=True).encode()).hexdigest(),
        obstacle_scope_sha256=hashlib.sha256(json.dumps(obstacles, sort_keys=True).encode()).hexdigest())
    if any((hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None) != wanted for p, wanted in before.items()):
        result.update(status='blocked', solver_launch_allowed=False, cause='coverage input changed during admission')
    if backend_command != command:
        result.update(status='blocked', solver_launch_allowed=False, cause='backend command changed during admission')
    if backend_policy != policy:
        result.update(status='blocked', solver_launch_allowed=False, cause='backend policy changed during admission')
    return result


def _validate_backend_command(command, dsn):
    if not isinstance(command, list) or not command or any(not isinstance(v, str) or not v for v in command):
        raise ValueError('final backend argv is missing or malformed')
    # All supported switches are explicit and cannot load an alternate config.
    # Unknown switches abstain rather than guessing whether they weaken rules.
    values = {'-de', '-do', '-mp'}
    switches = {'--diagnose', '--quality-first'}
    options = {'--report', '--max-time', '--router.min_trace_width_um',
        '--router.copper_to_edge_clearance_um', '--router.neck_width_um',
        '--router.autorouter.ignore_net_classes', '--router.optimizer.enabled',
        '--router.autorouter.max_threads', '--router.optimizer.max_threads',
        '--router.scoring.via_costs'}
    seen, index = set(), 1
    while index < len(command):
        value = command[index]
        name = value.split('=', 1)[0]
        if name in seen:
            raise ValueError('duplicate backend argv option: ' + name)
        seen.add(name)
        if name in values and value == name and index + 1 < len(command):
            if name == '-de' and command[index + 1] != str(dsn):
                raise ValueError('final backend argv targets a different DSN')
            index += 2
        elif value in switches:
            index += 1
        elif name in options and value.startswith(name + '=') and value[len(name) + 1:]:
            index += 1
        else:
            raise ValueError('unknown or malformed backend argv option: ' + value)
    if '-de' not in seen:
        raise ValueError('final backend argv does not name its admitted DSN')
