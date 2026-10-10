#!/usr/bin/env python3
"""net_drivers: the edge time of a net from its actual driver (D-124 addendum, 2026-10-09).

The driver of a net is found in the board's schematic netlist (kicad-cli sch export netlist --format kicadxml). The
edge time of each driver pin comes from tools/driver-edges.json (per part: datasheet tr and tf with the test load, or
the IBIS model), never from a default. A net whose driver or edge time is not known is "unknown driver".

Rules (tools/driver-edges.json "about" has the full text):
  - A pin of a part in the table has a role: "input" (not a driver), "push_pull" (edge = min(tr, tf)),
    "open_drain" (open drain or open collector with a pull-up: edge = tf, the driver's fall; the RC rise is slower),
    "opto" (phototransistor output: edge = min(tr, tf)) or "unknown" (with the reason, for example no IBIS model).
  - A part that is not in the table, or a pin that no rule of its part matches, is unknown.
  - Passive parts (R, C, L, FB, D, TP, F, Y, SW, BT, H, MH, NT, JP refs) are no driver. A 2-pin resistor or ferrite
    passes the drivers of the net at its other end (not a rail), with the same edge (the series part only slows it).
  - A connector pin (ref J, P, CN) is a load when the net has a driver on the board. With no driver on the board, the
    spec must name the off-board interface ("offboard"); else the net is unknown.
  - "receivers" in the spec: parts whose pin on that net is an input by firmware or by design (with a reason).
  - The edge of the net is the shortest edge of all its drivers. One unknown driver makes the whole net unknown.
  - A rail is a net from a power symbol (no "/" in front of the name) or a spec power net: no driver search.
"""
import fnmatch
import json
import os
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_FILE = os.path.join(HERE, 'driver-edges.json')
KICAD_CLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
PASSIVE = ('R', 'C', 'L', 'FB', 'D', 'TP', 'F', 'Y', 'SW', 'BT', 'H', 'MH', 'NT', 'JP')
SERIES = ('R', 'FB')
CONNECTOR = ('J', 'P', 'CN')
ROLES = ('input', 'push_pull', 'open_drain', 'opto', 'unknown')


class TableError(ValueError):
    pass


def ref_prefix(ref):
    m = re.match(r'[A-Za-z_#]+', ref)
    return m.group(0).upper() if m else ''


def pin_name(pin, func):
    """The pin name of a netlist node: KiCad 10 writes pinfunction as NAME_NUMBER."""
    func = func or ''
    if func.endswith('_' + pin):
        func = func[:-len(pin) - 1]
    return func or pin


def parse_netlist(xml_text):
    """{'comps': {ref: mpn or value}, 'nets': {name: [(ref, pin, pin name)]}} from kicadxml text."""
    root = ET.fromstring(xml_text)
    comps = {}
    for c in root.iter('comp'):
        fields = {f.get('name'): (f.text or '').strip() for f in c.iter('field')}
        comps[c.get('ref')] = fields.get('MPN') or (c.findtext('value') or '').strip()
    nets = {}
    for n in root.iter('net'):
        nets[n.get('name')] = [(d.get('ref'), d.get('pin'), pin_name(d.get('pin'), d.get('pinfunction')))
                               for d in n.iter('node')]
    return {'comps': comps, 'nets': nets}


def export_netlist(sch_path):
    """Run kicad-cli on the schematic and parse the netlist. Raises OSError when it fails."""
    if not os.path.isfile(sch_path):
        raise OSError(f'no schematic {sch_path} (needed for the net drivers)')
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, 'net.xml')
        r = subprocess.run([KICAD_CLI, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', out, sch_path],
                           capture_output=True, text=True)
        if r.returncode != 0 or not os.path.isfile(out):
            raise OSError(f'kicad-cli netlist export failed for {sch_path}: {r.stderr.strip()[-300:]}')
        with open(out) as f:
            return parse_netlist(f.read())


def load_table(path=TABLE_FILE):
    """The parts of tools/driver-edges.json. Each rule needs a role; a driver role needs its times and a source."""
    with open(path) as f:
        raw = json.load(f)
    parts = raw.get('parts')
    if not isinstance(parts, dict) or not parts:
        raise TableError(f'{path}: "parts" must be an object')
    for key, p in parts.items():
        if not isinstance(p.get('mpn'), list) or not p['mpn'] or not isinstance(p.get('pins'), list):
            raise TableError(f'{path}: part {key} needs "mpn" (patterns) and "pins" (rules)')
        for i, rule in enumerate(p['pins']):
            role, where = rule.get('role'), f'{path}: part {key} pin rule {i}'
            if role not in ROLES or not isinstance(rule.get('match'), str):
                raise TableError(f'{where}: needs "match" (regex) and a role of {ROLES}')
            if role in ('push_pull', 'opto') and not all(_pos(rule.get(k)) for k in ('tr_ns', 'tf_ns')):
                raise TableError(f'{where}: {role} needs tr_ns and tf_ns > 0')
            if role == 'open_drain' and not _pos(rule.get('tf_ns')):
                raise TableError(f'{where}: open_drain needs tf_ns > 0 (the driver fall time)')
            if role != 'input' and not str(rule.get('source', '')).strip():
                raise TableError(f'{where}: a {role} rule needs a source (or the reason it is unknown)')
    return parts


def _pos(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def part_of(mpn, table):
    for key, p in table.items():
        if any(fnmatch.fnmatchcase(mpn or '', q) for q in p['mpn']):
            return key, p
    return None, None


def pin_edge(mpn, pin, table):
    """(role, edge_ns or None, text) of one part pin. The edge is the time the return current flows in."""
    key, p = part_of(mpn, table)
    if p is None:
        return 'unknown', None, f'{mpn}: no entry in tools/driver-edges.json'
    for rule in p['pins']:
        if re.fullmatch(rule['match'], pin):
            role = rule['role']
            if role == 'input':
                return 'input', None, f'{key} {pin} input'
            if role == 'unknown':
                return 'unknown', None, f"{key} {pin}: {rule['source']}"
            if role == 'open_drain':
                return role, rule['tf_ns'], f"{key} {pin} open drain, tf {rule['tf_ns']:g} ns: {rule['source']}"
            e = min(rule['tr_ns'], rule['tf_ns'])
            return role, e, f"{key} {pin} {role}, min(tr {rule['tr_ns']:g}, tf {rule['tf_ns']:g}) = {e:g} ns: {rule['source']}"
    return 'unknown', None, f'{key} pin {pin}: no rule in tools/driver-edges.json'


def is_rail(net, power=()):
    return not net.startswith('/') and not net.startswith('Net-') and not net.startswith('unconnected') \
        or any(fnmatch.fnmatchcase(net, q) for q in power)


def _receivers(net, receivers):
    refs = set()
    for pat, r in (receivers or {}).items():
        if fnmatch.fnmatchcase(net, pat):
            refs |= set(r['refs'])
    return refs


def net_drivers(net, nl, table, receivers=None, power=(), _seen=None):
    """(drivers, unknowns, connectors): drivers [(ref, pin, edge_ns, text)], unknowns [text], connector refs.
    Follows 2-pin series resistors and ferrites to nets that are not rails."""
    seen = _seen if _seen is not None else {net}
    drivers, unknowns, conns = [], [], []
    rx = _receivers(net, receivers)
    for ref, pin, name in nl['nets'].get(net, []):
        pre = ref_prefix(ref)
        if ref in rx:
            continue
        if pre in CONNECTOR:
            conns.append(f'{ref}.{pin}')
            continue
        if pre in PASSIVE:
            if pre in SERIES:
                others = [n for n, nodes in nl['nets'].items() if n != net and any(r == ref for r, _, _ in nodes)]
                if len(others) == 1 and others[0] not in seen and not is_rail(others[0], power):
                    seen.add(others[0])
                    d, u, _ = net_drivers(others[0], nl, table, receivers, power, seen)
                    drivers += [(r, p, e, f'{t} (through {ref} from {others[0]})') for r, p, e, t in d]
                    unknowns += [f'{t} (through {ref} from {others[0]})' for t in u]
            continue
        role, edge, text = pin_edge(nl['comps'].get(ref, ''), name, table)
        if role == 'input':
            continue
        if role == 'unknown':
            unknowns.append(f'{ref}.{name} {text}')
        else:
            drivers.append((ref, name, edge, f'{ref}.{name} {text}'))
    return drivers, unknowns, conns


def net_edge(net, nl, table, receivers=None, offboard=None, classes=None, power=()):
    """The edge of a net: {'edge_ns', 'driver'} or {'unknown': reason}.
    offboard: {net pattern: {"class": edge class, "reason"}}; classes: the edge-rates.json classes."""
    if net not in nl['nets']:
        return {'unknown': f'net {net} is not in the schematic netlist'}
    drivers, unknowns, conns = net_drivers(net, nl, table, receivers, power)
    if unknowns:
        return {'unknown': '; '.join(unknowns)}
    if drivers:
        ref, pin, e, text = min(drivers, key=lambda d: d[2])
        return {'edge_ns': e, 'driver': text}
    for pat, o in (offboard or {}).items():
        if fnmatch.fnmatchcase(net, pat):
            c = (classes or {}).get(o['class'])
            if c is None:
                return {'unknown': f'offboard class {o["class"]} is not in tools/edge-rates.json'}
            return {'edge_ns': c['tr_ns'], 'driver': f"off-board via {', '.join(conns) or 'connector'}: class {o['class']} "
                                                     f"({c['source']}); {o['reason']}"}
    if conns:
        return {'unknown': f"driven from off-board via {', '.join(conns)}; no interface class (spec \"offboard\")"}
    return {'unknown': 'no driver pin on the net'}
