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


def inspect(dru_text, dsn_text, *, active_nets, net_classes, obstacles,
            layers, require_stitching=False):
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
                if kind == 'disallow' and constraint[2:] == ['pad']:
                    row.update(disposition='immutable_unchanged', reason='router does not modify footprint/pad geometry; import identity guard remains required')
                    continue
                if kind in ('hole_to_hole', 'hole_size', 'annular_width', 'via_diameter') and not any(v['Type'] == 'Via' for v in moving):
                    row.update(disposition='immutable_unchanged', reason='verified single-layer model introduces no new via/hole transitions')
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
                    if applicable and kind != 'clearance':
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


def check_files(board, base, dsn, *, active_nets, net_classes, obstacles, layers, gate=None):
    """Bind the pure decision to exact original inputs and final transformed DSN."""
    board, base, dsn = Path(board), Path(base), Path(dsn)
    rules = board.with_suffix('.kicad_dru')
    paths = [board, base, dsn, Path(__file__).resolve(), Path(route_features.__file__).resolve()]
    paths.extend([rules, board.with_suffix('.kicad_pro')])
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
    config = json.loads(Path(gate).read_text()) if gate is not None else {}
    if not isinstance(config, dict) or not isinstance(config.get('checks', {}), dict):
        raise ValueError('invalid configured board gate')
    checks = config.get('checks', {})
    result = inspect(rules.read_text() if rules.is_file() else '', dsn.read_text(),
        active_nets=active_nets, net_classes=net_classes, obstacles=obstacles, layers=layers,
        require_stitching='kicad_happy' in checks and checks['kicad_happy'] is not False)
    result.update(inputs=before, dsn=dict(path=str(dsn), sha256=before[str(dsn)]),
        native_classes=net_classes, footprint_scope_sha256=hashlib.sha256(json.dumps(source_footprints, sort_keys=True).encode()).hexdigest(),
        obstacle_scope_sha256=hashlib.sha256(json.dumps(obstacles, sort_keys=True).encode()).hexdigest())
    if any((hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None) != wanted for p, wanted in before.items()):
        result.update(status='blocked', solver_launch_allowed=False, cause='coverage input changed during admission')
    return result
