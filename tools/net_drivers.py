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

D-124c: IBIS drivers use static V-I mean-current estimates with the routed trace,
sourced receiver loads and driver C_comp MIN, not the resistive-fixture Ramp.
All estimates remain conditional and retain model/corner/load attribution.
"""
import fnmatch
import json
import os
import re
import subprocess
import tempfile
import hashlib
import math
from pathlib import Path
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_FILE = os.path.join(HERE, 'driver-edges.json')
KICAD_CLI = os.environ.get('KICAD_CLI', '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli')
PASSIVE = ('R', 'C', 'L', 'FB', 'D', 'TP', 'F', 'Y', 'SW', 'BT', 'H', 'MH', 'NT', 'JP')
SERIES = ('R', 'FB')
CONNECTOR = ('J', 'P', 'CN')
ROLES = ('input', 'push_pull', 'open_drain', 'opto', 'unknown')
R_TOL=0.95
C0_MM_PER_NS=299.792458


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
    comps = {};values={}
    for c in root.iter('comp'):
        fields = {f.get('name'): (f.text or '').strip() for f in c.iter('field')}
        comps[c.get('ref')] = fields.get('MPN') or (c.findtext('value') or '').strip()
    values = {c.get('ref'):(c.findtext('value') or '').strip() for c in root.iter('comp')}
    nets = {}
    for n in root.iter('net'):
        nets[n.get('name')] = [(d.get('ref'), d.get('pin'), pin_name(d.get('pin'), d.get('pinfunction')))
                               for d in n.iter('node')]
    return {'comps': comps, 'values':values, 'nets': nets}


def export_netlist(sch_path, deadline=None):
    """Run kicad-cli on the schematic and parse the netlist. Raises OSError when it fails."""
    if not os.path.isfile(sch_path):
        raise OSError(f'no schematic {sch_path} (needed for the net drivers)')
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, 'net.xml')
        import lean_workflow as lean
        bound = lean.deadline_after(30)
        deadline = bound if deadline is None else min(bound, deadline)
        r = lean.run_stage([KICAD_CLI, 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', out, sch_path],
                           stage='driver-netlist-export', deadline=deadline,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if r.returncode != 0 or not os.path.isfile(out):
            raise OSError(f'kicad-cli netlist export failed for {sch_path}: {r.stderr.strip()[-300:]}')
        with open(out) as f:
            result = parse_netlist(f.read())
        if lean.remaining(deadline) <= 0:
            raise subprocess.TimeoutExpired('driver-netlist-parse', 30)
        return result


def verify_evidence(raw):
    """Check the exact local evidence declared by the stable driver/class table."""
    for e in raw.get('evidence_files', []):
        path = e.get('path', '')
        if not path.startswith(('hardware-design/registry/datasheets/','hardware-design/registry/ibis/')) or '..' in Path(path).parts:
            raise TableError('invalid driver evidence path')
        f = Path(HERE).parent / path
        if not f.is_file() or hashlib.sha256(f.read_bytes()).hexdigest() != e.get('sha256'):
            raise TableError(f'missing or changed driver evidence: {path}')


def load_table(path=TABLE_FILE):
    """The parts of tools/driver-edges.json. Each rule needs a role; a driver role needs its times and a source."""
    with open(path) as f:
        raw = json.load(f)
    verify_evidence(raw)
    parts = raw.get('parts')
    if not isinstance(parts, dict) or not parts:
        raise TableError(f'{path}: "parts" must be an object')
    for key, p in parts.items():
        if not isinstance(p.get('mpn'), list) or not p['mpn'] or not isinstance(p.get('pins'), list):
            raise TableError(f'{path}: part {key} needs "mpn" (patterns) and "pins" (rules)')
        if 'pin_c' in p:
            if not _pos(p['pin_c'].get('pf')) or not str(p['pin_c'].get('source','')).strip():raise TableError(f'{key}: invalid sourced pin capacitance')
        if 'ibis' in p:
            ib=p['ibis'];source=dict(path=ib.get('file'),sha256=ib.get('sha256'))
            if source not in raw.get('evidence_files',[]):raise TableError(f'{key}: IBIS source closure missing')
            if not all(isinstance(ib.get(k),str) and ib[k].strip() for k in ('component','supply_pin','url','downloaded')):raise TableError(f'{key}: incomplete IBIS source/model metadata')
            if not isinstance(ib.get('variants'),dict) or not ib['variants']:raise TableError(f'{key}: missing IBIS voltage variants')
            for volts,suffix in ib['variants'].items():
                try:voltage=float(volts)
                except (ValueError,TypeError):raise TableError(f'{key}: invalid IBIS voltage variant')
                if not _pos(voltage) or not isinstance(suffix,str) or not suffix:raise TableError(f'{key}: invalid IBIS voltage/model suffix')
        for i, rule in enumerate(p['pins']):
            role, where = rule.get('role'), f'{path}: part {key} pin rule {i}'
            if role not in ROLES or not isinstance(rule.get('match'), str):
                raise TableError(f'{where}: needs "match" (regex) and a role of {ROLES}')
            if rule.get('ibis_model') and not isinstance(p.get('ibis'),dict):raise TableError(f'{where}: IBIS model needs source binding')
            if 'bound' in rule:_check_bound(rule['bound'],role,where)
            alternative=rule.get('ibis_model') or 'bound' in rule
            if role in ('push_pull', 'opto') and not alternative and not all(_pos(rule.get(k)) for k in ('tr_ns', 'tf_ns')):
                raise TableError(f'{where}: {role} needs tr_ns and tf_ns > 0')
            if role == 'open_drain' and not alternative and not _pos(rule.get('tf_ns')):
                raise TableError(f'{where}: open_drain needs tf_ns > 0 (the driver fall time)')
            if role != 'input' and not str(rule.get('source', '')).strip():
                raise TableError(f'{where}: a {role} rule needs a source (or the reason it is unknown)')
            record_sha=_minimum_record_hash(key,p['mpn'],rule)
            if record_sha in _REVIEWED_MINIMUMS:
                source=_REVIEWED_MINIMUMS[record_sha]
                if dict(path=source[0],sha256=source[1]) not in raw.get('evidence_files',[]):
                    raise TableError(f'{where}: reviewed minimum primary evidence declaration missing/changed')
                rule['_minimum_proof']=_ReviewedMinimumProof(record_sha,source,
                    'line side of transformer',
                    'Measured at line side of transformer, line replaced by 100 ohm (+/-1%) resistor.',False)
    return parts


def _pos(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0


# Conditional minimum reviewed in accepted D124a source: LAN8742A DS00001989A
# Table 5-8, Note 1. Binding includes part/MPN/pin/values/stat/load/source, not a
# mutable `stat=min` label. New reviewed bounds need explicit source registration.
_REVIEWED_MINIMUMS = {
    '7899c7bb904687e8144540d486d688a41f34ba7a271b0615dd565fa8c44fccde':
        ('hardware-design/registry/datasheets/LAN8742A-CZ-TR_C621424.pdf',
         '35d5d7e4f278efc2c72be68521796ace36f36f0fe46822d065747dd5872fc8ef')
}


def _minimum_record_hash(key,mpns,rule):
    clean={k:v for k,v in rule.items() if k!='_minimum_proof'}
    return hashlib.sha256(json.dumps(dict(part=key,mpn=mpns,rule=clean),sort_keys=True,separators=(',',':')).encode()).hexdigest()


class _ReviewedMinimumProof:
    """Minted by table loader only after the exact primary evidence is verified."""
    def __init__(self,record_sha,source,boundary,conditions,applies_to_driver):
        self.record_sha=record_sha;self.source=source;self.boundary=boundary;self.conditions=conditions
        self.applies_to_driver=applies_to_driver
    def matches(self,key,mpns,rule):return _minimum_record_hash(key,mpns,rule)==self.record_sha


def part_of(mpn, table):
    for key, p in table.items():
        if any(fnmatch.fnmatchcase(mpn or '', q) for q in p['mpn']):
            return key, p
    return None, None


def timing_evidence(record,part_key=None,part_mpns=None):
    """Screening statistics are not fastest-edge lower bounds.
    A reviewed MIN record bounds the stated datasheet load/conditions only;
    board-level model/measurement qualification remains independent.
    """
    stat=record.get('stat','unspecified')
    proof=record.get('_minimum_proof')
    source_verified=stat=='min' and not record.get('assumption',False) and isinstance(proof,_ReviewedMinimumProof) and proof.matches(part_key,part_mpns,record)
    qualified=source_verified and proof.applies_to_driver
    return dict(stat=stat,qualified_fastest_bound=qualified,source_MIN_verified=source_verified,
                applicable_driver_bound=qualified,source=record.get('source',''),
                load=record.get('load','not recorded'),scope='stated source conditions only; board-level qualification separate',
                measurement_boundary=proof.boundary if source_verified else None,
                source_conditions=proof.conditions if source_verified else None,
                reviewed_record_sha256=proof.record_sha if source_verified else None,
                primary_evidence=dict(path=proof.source[0],sha256=proof.source[1]) if source_verified else None,
                reason='hash-bound reviewed minimum with matched driver measurement boundary/conditions' if qualified else
                    'line-side transformer minimum does not establish pre-transformer TXP/TXN chip-pad bound' if source_verified else
                    'screening value; no reviewed fastest-edge lower bound')


def pin_timing_evidence(mpn,pin,table,part_class=None,ref=None,nl=None):
    if part_class and any(fnmatch.fnmatchcase(mpn or '',pat) for pat in part_class['applicability']['mpn']) and re.fullmatch(part_class['applicability']['pins'],pin):
        return timing_evidence(part_class)
    key,part=part_of(mpn,table)
    for rule in (part or {}).get('pins',[]):
        if re.fullmatch(rule['match'],pin):
            if rule.get('ibis_model') or ('bound' in rule and not _pos(rule.get('tf_ns'))):
                return screening_evidence(part,rule,ref,nl)
            return timing_evidence(rule,key,part['mpn'])
    return timing_evidence({})


def screening_evidence(part,rule,ref=None,nl=None):
    """D124b alternatives use the existing timing contract, never mint MIN proof."""
    evidence=dict(qualified_fastest_bound=False,source_MIN_verified=False,applicable_driver_bound=False,
                  source=rule.get('source',''),scope='sourced screening estimate; board applicability unresolved')
    if rule.get('ibis_model'):
        ib=part['ibis']
        evidence.update(kind='ibis_vi_load_estimate',primary_evidence=dict(path=ib['file'],sha256=ib.get('sha256')),
                        component=ib.get('component'),url=ib.get('url'),downloaded=ib.get('downloaded'),
                        premises=['static V-I average is not a transient current waveform',
                                  'capacitance and swing lower bounds unproved',
                                  'distributed connected topology not a proven lumped load',
                                  'package and measurement boundary applicability unproved'],
                        reason='load-dependent V-I conditional screening estimate cannot certify fastest physical edge')
    else:
        evidence.update(kind='conditional_capacitance_current_estimate',inputs=dict(rule['bound']),
                        premises=['instantaneous current upper bound unproved','capacitance and swing lower bounds unproved',
                                  'distributed connected topology not a proven lumped load','series tolerance/charging-path applicability unproved'],
                        reason='C*dV/I conditional calculation cannot certify fastest physical edge')
    return evidence


def pin_edge(mpn, pin, table, part_class=None, ref=None, nl=None):
    """(role, edge_ns or None, text) of one part pin. The edge is the time the return current flows in."""
    if part_class and any(fnmatch.fnmatchcase(mpn or '', pat) for pat in part_class['applicability']['mpn']) and re.fullmatch(part_class['applicability']['pins'], pin):
        return 'push_pull', part_class['tr_ns'], f"part-bound class {mpn}.{pin}: {part_class['source']}"
    key, p = part_of(mpn, table)
    if p is None:
        return 'unknown', None, f'{mpn}: no entry in tools/driver-edges.json'
    for rule in p['pins']:
        if re.fullmatch(rule['match'], pin):
            role = rule['role']
            if role == 'input':
                return 'input', None, f'{key} {pin} input'
            if part_class:
                return 'unknown', None, f"{mpn}.{pin}: incompatible with part-bound class {part_class['applicability']['mpn']}"
            if role == 'unknown':
                return 'unknown', None, f"{key} {pin}: {rule['source']}"
            if rule.get('ibis_model'):
                return 'bound',None,(key,p,rule)
            if not _pos(rule.get('tf_ns')) and 'bound' in rule:return 'bound',None,(key,p,rule)
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


def net_drivers(net, nl, table, receivers=None, power=(), _seen=None, part_class=None, _series=()):
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
                    rv=r_value(nl.get('values',{}).get(ref)) if pre=='R' else None
                    d, u, _ = net_drivers(others[0], nl, table, receivers, power, seen, part_class,_series+((ref,rv),))
                    drivers += [(r,p,e,f'{t} (through {ref} from {others[0]})' if e is not None else t) for r,p,e,t in d]
                    unknowns += [f'{t} (through {ref} from {others[0]})' for t in u]
            continue
        role, edge, text = pin_edge(nl['comps'].get(ref, ''), name, table, part_class,ref,nl)
        if role == 'input':
            continue
        if role == 'unknown':
            unknowns.append(f'{ref}.{name} {text}')
        elif role=='bound':
            drivers.append((ref,name,None,text+(net,_series)))
        else:
            drivers.append((ref, name, edge, f'{ref}.{name} {text}'))
    return drivers, unknowns, conns


def net_edge(net, nl, table, receivers=None, offboard=None, classes=None, power=(), interface=None, geom=None):
    """The edge of a net: {'edge_ns', 'driver'} or {'unknown': reason}.
    offboard: {net pattern: {"class": edge class, "reason"}}; classes: the edge-rates.json classes."""
    if net not in nl['nets']:
        return {'unknown': f'net {net} is not in the schematic netlist'}
    c = (classes or {}).get(interface) if interface else None
    if c and c['applicability']['kind'] == 'protocol':
        if not nl['nets'][net]:
            return {'unknown': 'interface net has no schematic endpoints'}
        return {'edge_ns': c['tr_ns'], 'driver': f"protocol {interface}: {c['applicability']['reason']}; {c['source']}", 'timing_evidence':timing_evidence(c)}
    drivers, unknowns, conns = net_drivers(net, nl, table, receivers, power, part_class=c)
    resolved=[];calculated_evidence={}
    for d in drivers:
        if d[2] is None:
            try:
                if d[3][2].get('ibis_model'):
                    e,text,details=ibis_vi_bound(d,net,nl,table,geom,power)
                    calculated_evidence[(d[0],d[1],e,text)]=details
                else:e,text=pin_bound(d,net,nl,table,geom,power)
            except (ValueError,OSError,KeyError,TypeError,IndexError,OverflowError) as error:e,text=None,f'{d[0]}.{d[1]}: invalid conditional estimate: {error}'
            if e is None:unknowns.append(text)
            else:resolved.append((d[0],d[1],e,text))
        else:resolved.append(d)
    drivers=resolved
    if unknowns:
        return {'unknown': '; '.join(unknowns)}
    if drivers:
        ref, pin, e, text = min(drivers, key=lambda d: d[2])
        contributors=[dict(ref=r,pin=p,screening_edge_ns=value,evidence=pin_timing_evidence(nl['comps'].get(r,''),p,table,c,r,nl)) for r,p,value,_ in drivers]
        for driver,d in zip(drivers,contributors):
            if driver in calculated_evidence:
                d['evidence'].update(calculated_evidence[driver])
            if d['evidence'].get('kind') in ('conditional_capacitance_current_estimate','ibis_vi_load_estimate'):
                d['evidence']['geometry_screening']=dict(net=net,length_mm=(geom or {}).get('length_mm',{}).get(net),
                    pf_per_mm=(geom or {}).get('pf_per_mm',{}).get(net),
                    model_applicability=(geom or {}).get('model_applicability',{}))
        return {'edge_ns': e, 'driver': text, 'timing_evidence':dict(qualified_fastest_bound=all(d['evidence']['qualified_fastest_bound'] for d in contributors),contributors=contributors,reason='all possible drivers require sourced fastest-edge bounds')}
    for pat, o in (offboard or {}).items():
        if fnmatch.fnmatchcase(net, pat):
            c = (classes or {}).get(o['class'])
            if c is None:
                return {'unknown': f'offboard class {o["class"]} is not in tools/edge-rates.json'}
            if not conns:
                return {'unknown': 'offboard class requires an actual schematic connector endpoint'}
            if c['applicability']['kind'] == 'part':
                mpn, pin = o.get('driver_mpn', ''), o.get('driver_pin', '')
                if not any(fnmatch.fnmatchcase(mpn, pat) for pat in c['applicability']['mpn']) or not re.fullmatch(c['applicability']['pins'], pin):
                    return {'unknown': 'offboard driver MPN/pin absent or incompatible with part-bound class'}
            return {'edge_ns': c['tr_ns'], 'driver': f"off-board via {', '.join(conns) or 'connector'}: class {o['class']} "
                                                     f"({c['source']}); {o['reason']}", 'timing_evidence':timing_evidence(c)}
    if conns:
        return {'unknown': f"driven from off-board via {', '.join(conns)}; no interface class (spec \"offboard\")"}
    return {'unknown': 'no driver pin on the net'}


def _check_bound(b, role, where):
    if not _pos(b.get('i_ma')) or not str(b.get('i_source', '')).strip():
        raise TableError(f'{where}: a bound needs i_ma > 0 and i_source')
    if not (b.get('supply_pin') or _pos(b.get('vdd_v')) or (role == 'open_drain' and b.get('pullup'))):
        raise TableError(f'{where}: a bound needs supply_pin, vdd_v or (open drain) "pullup": true')
    if 'cpin_pf' in b and (not _pos(b['cpin_pf']) or not str(b.get('cpin_source', '')).strip()):
        raise TableError(f'{where}: cpin_pf needs a value > 0 and cpin_source')

def edge_bound_ns(c_pf, vdd_v, i_ma):
    """t >= C x dV / I, dV = 0.8 x VDD (the 10-90 % swing). pF x V / mA = 1e-9 s."""
    if not all(_pos(v) for v in (c_pf,vdd_v,i_ma)):raise TableError('invalid C*dV/I inputs')
    return c_pf * 0.8 * vdd_v / i_ma

def series_limit_ma(i_ma, vdd_v, r_ohm):
    """The current through a series resistor is at most VDD / (0.95 x R) (R at its low tolerance)."""
    if not all(_pos(v) for v in (i_ma,vdd_v,r_ohm)):raise TableError('invalid series-current inputs')
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
    m = ibis_ramp.load(_ibis_path(p),p['ibis'].get('sha256'))['models'].get(name.lower())
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

def pin_c_pf(mpn, pin, table, ref=None, nl=None):
    """(pF, text) of the input capacitance of a part pin with a source, or (None, reason)."""
    key, p = part_of(mpn, table)
    if p is None:
        return None, f'{mpn}: no entry'
    for rule in p['pins']:
        if re.fullmatch(rule['match'], pin):
            if rule.get('ibis_model') and 'ibis' in p:
                vals=[]
                for suf,_,_ in _ibis_variants(p,ref,nl):
                    triple=ibis_model(p,rule['ibis_model']+suf)['c_comp']
                    if triple and triple[1] is not None:vals.append((triple[1]*1e12,suf))
                if not vals:return None,f'{key} {pin}: IBIS C_comp minimum unavailable'
                c, suf = min(vals)
                return c, f"{key} {pin} {c:.3g} pF (IBIS {rule['ibis_model']}{suf} C_comp min)"
            break
    pc = p.get('pin_c')
    if pc:
        return pc['pf'], f"{key} {pin} {pc['pf']:g} pF ({pc['source']})"
    return None, f'{key} {pin}: no input capacitance with a source'

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
    if not geom or net not in (geom.get('length_mm') or {}) or net not in (geom.get('pf_per_mm') or {}):
        return None, f'{ref}.{name} {key}: the bound C*dV/I needs the routed length of {net} (no board geometry)'
    if rule.get('ibis_model'):
        return ibis_vi_bound(drv,net,nl,table,geom,power)[:2]
    b = rule['bound']
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
    if not _pos(length) or not _pos(cpm):return None,f'{ref}.{name}: invalid/nonpositive geometry capacitance'
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
    if not _pos(t):return None,f'{ref}.{name}: invalid capacitance/current estimate'
    via = f" (through {', '.join(r for r, _ in series)} from {home})" if series else ''
    text = (f"{ref}.{name} {key} conditional estimate: C*dV/I = ({c_trace:.2f} pF trace [{length:.1f} mm x {cpm:.4f} pF/mm, {cpm_src}]"
            f" + {c_load:.2f} pF loads [{'; '.join(used) or 'none with a source'}]"
            + (f" + {c_pin:g} pF pin [{b['cpin_source']}]" if c_pin else '')
            + f") x 0.8 x {vdd:g} V [{vsrc}] / {ilabel} = {t:.3g} ns"
            + (f"; loads with no source left out (bound shorter): {', '.join(left)}" if left else '') + via)
    return t, text


def ibis_vi_bound(drv, net, nl, table, geom, power=()):
    """Load-dependent V-I screening estimate and its exact inputs (D-124c).
    Static V-I averages and omitted loads do not prove a fastest-edge bound.
    Every possible supply/model must be interpretable; errors remain unknown.
    """
    import ibis_ramp
    ref,name,_,(key,part,rule,home,series)=drv
    if not geom or net not in geom.get('length_mm',{}) or net not in geom.get('pf_per_mm',{}):
        raise TableError(f'{ref}.{name}: V-I estimate needs the routed length and capacitance of {net}')
    length=geom['length_mm'][net];cpm,cpm_src=geom['pf_per_mm'][net]
    if not _pos(length) or not _pos(cpm):raise TableError('invalid/nonpositive geometry capacitance')
    c_trace=length*cpm
    c_load,used,left=net_load_pf(net,nl,table,skip=(ref,name))
    od=rule['role']=='open_drain'
    swing=_pullup_volts(home,nl,power) if od else None
    if od and not _pos(swing):raise TableError(f'open drain has no pull-up rail on {home}')
    parsed=ibis_ramp.load(_ibis_path(part),part['ibis'].get('sha256'))
    component=part['ibis'].get('component');estimates=[]
    if component and component not in parsed['pins']:raise TableError('IBIS component missing')
    nodes=[(pin,signal) for nodes in nl['nets'].values() for r,pin,signal in nodes if r==ref and signal==name]
    if component and not nodes:raise TableError('selected schematic pin missing')
    for suffix,volts,note in _ibis_variants(part,ref,nl):
        model_name=rule['ibis_model']+suffix;model=ibis_model(part,model_name)
        allowed=('open_drain','open_sink') if od else ('output','i/o','3-state')
        if (model.get('type') or '').lower() not in allowed:raise TableError('IBIS model type incompatible with output role')
        if component:
            for pin,signal in nodes:
                item=parsed['pins'][component].get(pin)
                if item is None:raise TableError('IBIS component pin missing: '+pin)
                base=item[1].lower();choices=parsed['selectors'].get(base,[base])
                if model_name.lower() not in choices:raise TableError('IBIS component/pin/model selector mismatch: '+pin)
        triple=model.get('c_comp')
        if not series and (not triple or not _pos(triple[1])):raise TableError('driver IBIS C_comp minimum unavailable')
        c_pin=triple[1]*1e12 if not series else 0.0
        total=c_trace+c_load+c_pin
        if not _pos(total):raise TableError('invalid total capacitance')
        limit=None;limit_sources=[]
        for resistor,rv in series:
            if rv is not None:
                if not _pos(rv):raise TableError('invalid series resistance')
                current=(swing or volts)/(R_TOL*rv)
                limit=current if limit is None else min(limit,current)
                limit_sources.append(dict(ref=resistor,ohm=rv,tolerance_factor=R_TOL,current_a=current))
        edges=ibis_ramp.vi_edges(model,total*1e-12,swing_v=swing,open_drain=od,i_limit_a=limit)
        edge=edges['tf_ns'] if od else min(edges['tr_ns'],edges['tf_ns'])
        if not _pos(edge):raise TableError('invalid IBIS V-I edge estimate')
        estimates.append(dict(model=model_name,supply_nominal_v=volts,supply_resolution=note,
                              capacitance_pf=total,driver_c_comp_min_pf=c_pin,
                              driver_capacitance_omitted_for_series=bool(series),
                              series_current_limit_a=limit,series_limit_sources=limit_sources,
                              screening_edge_ns=edge,**edges))
    if not estimates:raise TableError('no IBIS model variants')
    best=min(estimates,key=lambda item:item['screening_edge_ns']);edge=best['screening_edge_ns']
    details=dict(estimates=estimates,selected_model=best['model'],selected_pin=name,
                 inputs=dict(net=net,driver_home_net=home,length_mm=length,pf_per_mm=cpm,
                             capacitance_per_length_source=cpm_src,trace_capacitance_pf=c_trace,
                             receiver_capacitance_pf=c_load,receiver_sources=used,omitted_loads=left,
                             open_drain=od,pullup_swing_v=swing,series=list(series)))
    text=(f"{ref}.{name} {key} IBIS V-I conditional estimate: C*dV/I_avg, {os.path.basename(part['ibis']['file'])} "
          f"[Model] {best['model']} ({best['supply_resolution']}): {best['capacitance_pf']:.6g} pF "
          f"({c_trace:.6g} pF trace, {c_load:.6g} pF sourced loads, {best['driver_c_comp_min_pf']:.6g} pF C_comp min) "
          f"-> {edge:.6g} ns; source {part['ibis']['url']} (downloaded {part['ibis']['downloaded']})"
          + (f"; loads without source omitted: {', '.join(left)}" if left else '')
          + (f"; through {', '.join(r for r,_ in series)} from {home}" if series else ''))
    return edge,text,details
