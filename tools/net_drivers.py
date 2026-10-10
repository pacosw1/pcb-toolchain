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

D-124b (2026-10-09): the edge of a driver pin, in this order:
  1. the vendor IBIS model ("ibis" of the part, "ibis_model" of the rule; hardware-design/registry/ibis/): the [Ramp]
     20-80 % time of the model for the part's supply voltage (the rail on its "supply_pin"), the fastest of the typ
     and max corners (tools/ibis_ramp.py);
  2. the datasheet tr and tf ("tr_ns", "tf_ns");
  3. the bound t >= C x dV / I_max ("bound"): C = the net's routed length x the microstrip capacitance per mm (from
     the board stackup) + the input capacitance of each IC pin on the net that has a sourced value (IBIS C_comp min
     corner, or "pin_c" of the part) + the driver's own pin capacitance; dV = 0.8 x VDD of the driver (10-90 %);
     I_max = the driver's maximum output current at its drive setting (push-pull: the larger of IOH and IOL; open
     drain: IOL). Through a series resistor I_max is also limited to VDD / (0.95 x R). A load capacitance with no
     source is left out, which makes the bound shorter (stricter). The result is labelled "bound: C*dV/I";
  4. else "unknown", with the reason.
"""
import fnmatch
import json
import math
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
R_TOL = 0.95          # a resistor is at least 95 % of its value (covers the 1 % F and 5 % J parts)
C0_MM_PER_NS = 299.792458


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
    comps, values = {}, {}
    for c in root.iter('comp'):
        fields = {f.get('name'): (f.text or '').strip() for f in c.iter('field')}
        comps[c.get('ref')] = fields.get('MPN') or (c.findtext('value') or '').strip()
        values[c.get('ref')] = (c.findtext('value') or '').strip()
    nets = {}
    for n in root.iter('net'):
        nets[n.get('name')] = [(d.get('ref'), d.get('pin'), pin_name(d.get('pin'), d.get('pinfunction')))
                               for d in n.iter('node')]
    return {'comps': comps, 'values': values, 'nets': nets}


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
            if rule.get('ibis_model') and not isinstance(p.get('ibis'), dict):
                raise TableError(f'{where}: "ibis_model" needs the part "ibis" (file, url, downloaded, supply_pin, variants)')
            if 'bound' in rule:
                _check_bound(rule['bound'], role, where)
            alt = rule.get('ibis_model') or 'bound' in rule
            if role in ('push_pull', 'opto') and not alt and not all(_pos(rule.get(k)) for k in ('tr_ns', 'tf_ns')):
                raise TableError(f'{where}: {role} needs tr_ns and tf_ns > 0, an IBIS model or a bound')
            if role == 'open_drain' and not alt and not _pos(rule.get('tf_ns')):
                raise TableError(f'{where}: open_drain needs tf_ns > 0 (the driver fall time), an IBIS model or a bound')
            if role != 'input' and not str(rule.get('source', '')).strip():
                raise TableError(f'{where}: a {role} rule needs a source (or the reason it is unknown)')
    return parts


def _pos(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0


def _check_bound(b, role, where):
    if not _pos(b.get('i_ma')) or not str(b.get('i_source', '')).strip():
        raise TableError(f'{where}: a bound needs i_ma > 0 and i_source')
    if not (b.get('supply_pin') or _pos(b.get('vdd_v')) or (role == 'open_drain' and b.get('pullup'))):
        raise TableError(f'{where}: a bound needs supply_pin, vdd_v or (open drain) "pullup": true')
    if 'cpin_pf' in b and (not _pos(b['cpin_pf']) or not str(b.get('cpin_source', '')).strip()):
        raise TableError(f'{where}: cpin_pf needs a value > 0 and cpin_source')


# ---------------------------------------------------------------- D-124b: IBIS, bound, rails (pure)
def edge_bound_ns(c_pf, vdd_v, i_ma):
    """t >= C x dV / I, dV = 0.8 x VDD (the 10-90 % swing). pF x V / mA = 1e-9 s."""
    return c_pf * 0.8 * vdd_v / i_ma


def series_limit_ma(i_ma, vdd_v, r_ohm):
    """The current through a series resistor is at most VDD / (0.95 x R) (R at its low tolerance)."""
    return min(i_ma, vdd_v / (R_TOL * r_ohm) * 1000)


def microstrip_pf_per_mm(w_mm, h_mm, t_mm, er):
    """C per length of a microstrip: C' = sqrt(Eeff) / (c0 x Z0), with Z0 and Eeff from the Hammerstad-Jensen
    equations of tools/si_pairs.py (the same ones its impedance check uses)."""
    import si_pairs
    z, eeff, _ = si_pairs._microstrip(w_mm, h_mm, t_mm, er)
    return 1000 * math.sqrt(eeff) / (C0_MM_PER_NS * z)


def rail_volts(net):
    """The voltage in a rail name: VDD_3V3, +3V3 -> 3.3; FIELD_5V, 5V_LOGIC -> 5; +15V -> 15. None if not one value."""
    vals = {float(a + ('.' + b if b else '')) for a, b in re.findall(r'(?<![0-9.])(\d+)V(\d*)(?![0-9])', net or '')}
    return vals.pop() if len(vals) == 1 else None


def r_value(text):
    """'10k' -> 10000, '4.7k' -> 4700, '330' -> 330, '1M' -> 1e6, '4k7' -> 4700. None if not a value."""
    m = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*([RkKmM]?)(\d*)\s*(?:ohm|Ω)?\s*', text or '')
    if not m:
        return None
    mult = {'': 1, 'R': 1, 'k': 1e3, 'K': 1e3, 'm': 1e6, 'M': 1e6}[m.group(2)]
    v = float(m.group(1) + ('.' + m.group(3) if m.group(3) else ''))
    return v * mult


def _by_ref(nl):
    if '_by_ref' not in nl:
        idx = {}
        for net, nodes in nl['nets'].items():
            for ref, pin, name in nodes:
                idx.setdefault(ref, []).append((pin, name, net))
        nl['_by_ref'] = idx
    return nl['_by_ref']


def supply_volts(nl, ref, pin):
    """The rail voltage on the supply pin (name) of a part, or None."""
    for _, name, net in _by_ref(nl).get(ref, []):
        if name == pin:
            return rail_volts(net)
    return None


def _ibis_path(p):
    f = p['ibis']['file']
    return f if os.path.isabs(f) else os.path.join(os.path.dirname(HERE), f)


def ibis_model(p, name):
    import ibis_ramp
    m = ibis_ramp.load(_ibis_path(p))['models'].get(name.lower())
    if m is None:
        raise TableError(f"IBIS model {name} is not in {p['ibis']['file']}")
    return m


def ibis_edges(p, name):
    import ibis_ramp
    return ibis_ramp.ramp_edges(ibis_model(p, name))


def _ibis_variants(p, ref, nl):
    """[(model suffix, volts, note)]: the variant for the part's supply rail, else all (the caller takes the worst)."""
    ib = p['ibis']
    v = supply_volts(nl, ref, ib['supply_pin']) if nl is not None and ref else None
    if v is not None:
        for k, suf in ib['variants'].items():
            if abs(float(k) - v) < 0.05:
                return [(suf, v, f"{ib['supply_pin']} {v:g} V")]
    return [(suf, float(k), f"{ib['supply_pin']} rail not found: all variants") for k, suf in ib['variants'].items()]


def ibis_pin_edge(p, rule, ref, nl):
    """(edge_ns, text) of a driver pin from its IBIS model (the fastest variant when the supply is not known)."""
    best = None
    for suf, v, note in _ibis_variants(p, ref, nl):
        name = rule['ibis_model'] + suf
        e = ibis_edges(p, name)
        edge = e['tf_ns'] if rule['role'] == 'open_drain' else min(e['tr_ns'], e['tf_ns'])
        what = (f"tf {e['tf_ns']:.3g} ns ({e['corner_f']})" if rule['role'] == 'open_drain' else
                f"min(tr {e['tr_ns']:.3g} ({e['corner_r']}), tf {e['tf_ns']:.3g} ({e['corner_f']})) ns")
        if best is None or edge < best[0]:
            best = (edge, f"IBIS {os.path.basename(p['ibis']['file'])} [Model] {name} ({note}), [Ramp] 20-80 % {what}")
    return best


def pin_c_pf(mpn, pin, table, ref=None, nl=None):
    """(pF, text) of the input capacitance of a part pin with a source, or (None, reason)."""
    key, p = part_of(mpn, table)
    if p is None:
        return None, f'{mpn}: no entry'
    for rule in p['pins']:
        if re.fullmatch(rule['match'], pin):
            if rule.get('ibis_model') and 'ibis' in p:
                vals = [(ibis_model(p, rule['ibis_model'] + suf)['c_comp'][1] * 1e12, suf)
                        for suf, _, _ in _ibis_variants(p, ref, nl)]
                c, suf = min(vals)
                return c, f"{key} {pin} {c:.3g} pF (IBIS {rule['ibis_model']}{suf} C_comp min)"
            break
    pc = p.get('pin_c')
    if pc:
        return pc['pf'], f"{key} {pin} {pc['pf']:g} pF ({pc['source']})"
    return None, f'{key} {pin}: no input capacitance with a source'


def part_of(mpn, table):
    for key, p in table.items():
        if any(fnmatch.fnmatchcase(mpn or '', q) for q in p['mpn']):
            return key, p
    return None, None


def pin_edge(mpn, pin, table, ref=None, nl=None):
    """(role, edge_ns or None, text) of one part pin. The edge is the time the return current flows in.
    role "bound": the edge needs the net (pin_bound); the text is the part key."""
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
            if rule.get('ibis_model'):
                e, text = ibis_pin_edge(p, rule, ref, nl)
                return role, e, f"{key} {pin} {role.replace('_', ' ')}, {text}: {p['ibis']['url']} (downloaded {p['ibis']['downloaded']})"
            if not _pos(rule.get('tf_ns')) and 'bound' in rule:
                return 'bound', None, (key, p, rule)
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


def net_drivers(net, nl, table, receivers=None, power=(), _seen=None, _series=()):
    """(drivers, unknowns, connectors): drivers [(ref, pin, edge_ns, text)], unknowns [text], connector refs.
    Follows 2-pin series resistors and ferrites to nets that are not rails. A driver with a bound (no IBIS, no
    datasheet time) has edge None and text (key, part, rule, series): the series resistor values (ohm, None for
    a ferrite or an unknown value) between it and this net."""
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
                    rv = r_value(nl.get('values', {}).get(ref)) if pre == 'R' else None
                    d, u, _ = net_drivers(others[0], nl, table, receivers, power, seen, _series + ((ref, rv),))
                    drivers += [(r, p, e, f'{t} (through {ref} from {others[0]})' if e is not None else t)
                                for r, p, e, t in d]
                    unknowns += [f'{t} (through {ref} from {others[0]})' for t in u]
            continue
        role, edge, text = pin_edge(nl['comps'].get(ref, ''), name, table, ref, nl)
        if role == 'input':
            continue
        if role == 'unknown':
            unknowns.append(f'{ref}.{name} {text}')
        elif role == 'bound':
            drivers.append((ref, name, None, text + (net, _series)))
        else:
            drivers.append((ref, name, edge, f'{ref}.{name} {text}'))
    return drivers, unknowns, conns


def _pullup_volts(net, nl, power):
    """The lowest rail that a resistor from this net leads to (the pull-up of an open drain), or None."""
    vs = []
    for ref, _, _ in nl['nets'].get(net, []):
        if ref_prefix(ref) == 'R':
            for _, _, other in _by_ref(nl).get(ref, []):
                if other != net and is_rail(other, power) and rail_volts(other):
                    vs.append(rail_volts(other))
    return min(vs) if vs else None


def net_load_pf(net, nl, table, skip=None):
    """(pF, [texts], [omitted]) of the IC pins on a net with a sourced input capacitance (not passives, not
    connectors); skip = (ref, pin) of the driver."""
    total, used, left = 0.0, [], []
    for ref, _, name in nl['nets'].get(net, []):
        if (ref, name) == skip or ref_prefix(ref) in PASSIVE + CONNECTOR:
            continue
        c, text = pin_c_pf(nl['comps'].get(ref, ''), name, table, ref, nl)
        if c is None:
            left.append(f'{ref}.{name}')
        else:
            total += c
            used.append(f'{ref}.{text}')
    return total, used, left


def pin_bound(drv, net, nl, table, geom, power=()):
    """(edge_ns, text) or (None, reason) of a bound driver on a net (D-124b): t >= C x 0.8 VDD / I."""
    ref, name, _, (key, p, rule, home, series) = drv
    b = rule['bound']
    if not geom or net not in (geom.get('length_mm') or {}):
        return None, f'{ref}.{name} {key}: the bound C*dV/I needs the routed length of {net} (no board geometry)'
    if b.get('supply_pin'):
        vdd = supply_volts(nl, ref, b['supply_pin'])
        vsrc = f"{b['supply_pin']} rail {vdd:g} V" if vdd else None
    elif b.get('pullup'):
        vdd = _pullup_volts(home, nl, power)
        vsrc = f'pull-up rail {vdd:g} V' if vdd else None
    else:
        vdd, vsrc = b['vdd_v'], f"{b['vdd_v']:g} V ({b.get('vdd_source', '')})"
    if not vdd:
        return None, f'{ref}.{name} {key}: the bound needs the supply voltage; no rail found for it'
    length = geom['length_mm'][net]
    cpm, cpm_src = geom['pf_per_mm'][net]
    c_trace = length * cpm
    c_load, used, left = net_load_pf(net, nl, table, skip=(ref, name))
    c_pin = b.get('cpin_pf', 0) if not series else 0
    c = c_trace + c_load + c_pin
    i, ilabel = b['i_ma'], f"{b['i_ma']:g} mA ({b['i_source']})"
    for rref, rv in series:
        if rv is None:
            continue
        lim = series_limit_ma(i, vdd, rv)
        if lim < i:
            i, ilabel = lim, f"{lim:.3g} mA = {vdd:g} V / (0.95 x {rv:g} ohm {rref})"
    if c <= 0:
        return None, f'{ref}.{name} {key}: the bound has no capacitance (no routed length)'
    t = edge_bound_ns(c, vdd, i)
    via = f" (through {', '.join(r for r, _ in series)} from {home})" if series else ''
    text = (f"{ref}.{name} {key} bound: C*dV/I = ({c_trace:.2f} pF trace [{length:.1f} mm x {cpm:.4f} pF/mm, {cpm_src}]"
            f" + {c_load:.2f} pF loads [{'; '.join(used) or 'none with a source'}]"
            + (f" + {c_pin:g} pF pin [{b['cpin_source']}]" if c_pin else '')
            + f") x 0.8 x {vdd:g} V [{vsrc}] / {ilabel} = {t:.3g} ns"
            + (f"; loads with no source left out (bound shorter): {', '.join(left)}" if left else '') + via)
    return t, text


def net_edge(net, nl, table, receivers=None, offboard=None, classes=None, power=(), geom=None):
    """The edge of a net: {'edge_ns', 'driver'} or {'unknown': reason}.
    offboard: {net pattern: {"class": edge class, "reason"}}; classes: the edge-rates.json classes.
    geom: {'length_mm': {net: routed mm}, 'pf_per_mm': {net: (pF/mm, source text)}} for the bound (D-124b)."""
    if net not in nl['nets']:
        return {'unknown': f'net {net} is not in the schematic netlist'}
    drivers, unknowns, conns = net_drivers(net, nl, table, receivers, power)
    out = []
    for d in drivers:
        if d[2] is None:
            e, text = pin_bound(d, net, nl, table, geom, power)
            if e is None:
                unknowns.append(text)
            else:
                out.append((d[0], d[1], e, text))
        else:
            out.append(d)
    drivers = out
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
