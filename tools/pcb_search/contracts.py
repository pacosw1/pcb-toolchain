"""Explicit, sourced contracts for solver-independent routing problems.

This first kernel represents rectangular routing regions and copper envelopes.
Unsupported requirements are retained and cause abstention, never silently lost.
Input hashes bind evidence; they do not establish that the model is complete.
"""
from dataclasses import dataclass
import hashlib
import json
import math


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def number(value, name, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(name + ' must be finite')
    if value < 0 or (positive and value == 0):
        raise ValueError(name + ' out of range')
    return float(value)


def xy(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                             or not math.isfinite(v) for v in value):
        raise ValueError('point requires two finite coordinates')
    return tuple(float(v) for v in value)


def box(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError('box requires four coordinates')
    a, b = xy(value[:2]), xy(value[2:])
    if a[0] >= b[0] or a[1] >= b[1]:
        raise ValueError('box must have positive area')
    return a + b


@dataclass(frozen=True)
class NetRule:
    name: str
    width: float
    clearance: float
    layers: tuple
    source: str


@dataclass(frozen=True)
class Obstacle:
    name: str
    bounds: tuple
    layers: tuple
    net: str  # empty for mechanical/keepout obstacles
    clearance: float


@dataclass(frozen=True)
class Connection:
    name: str
    net: str
    start: tuple
    end: tuple
    layers: tuple  # layers accessible at BOTH ends, not arbitrary layer union


@dataclass(frozen=True)
class Problem:
    bounds: tuple
    edge_clearance: float
    layers: tuple
    nets: tuple
    obstacles: tuple
    connections: tuple
    pair_clearances: tuple
    unsupported: tuple
    identity: str

    @classmethod
    def read(cls, raw):
        required = {'schema', 'bounds', 'edge_clearance', 'edge_source', 'layers',
                    'nets', 'obstacles', 'connections', 'pair_clearances',
                    'unsupported', 'inputs'}
        if not isinstance(raw, dict) or set(raw) != required or raw['schema'] != 'iot-lab.route-problem.v1':
            raise ValueError('unknown/missing route contract fields or schema')
        if not raw['edge_source'] or not isinstance(raw['edge_source'], str):
            raise ValueError('edge clearance requires a source')
        inputs = raw['inputs']
        if not isinstance(inputs, dict) or not inputs:
            raise ValueError('input fingerprints required')
        for name, value in inputs.items():
            if not isinstance(name, str) or not name or not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
                raise ValueError('invalid input fingerprint')
        for field in ('layers', 'nets', 'obstacles', 'connections', 'pair_clearances'):
            if not isinstance(raw[field], list):
                raise ValueError(field + ' must be an array')
        layers = tuple(raw['layers'])
        if not layers or any(not isinstance(l, str) or not l for l in layers) or len(set(layers)) != len(layers):
            raise ValueError('unique nonempty layers required')

        def layer_set(ls):
            if (not isinstance(ls, list) or not ls or any(not isinstance(l, str) for l in ls)
                    or len(set(ls)) != len(ls) or not set(ls) <= set(layers)):
                raise ValueError('invalid layer mask')
            return tuple(ls)

        def keys(row, names):
            if not isinstance(row, dict) or set(row) != set(names.split()):
                raise ValueError('unknown/missing fields in route item')

        nets = []
        for r in raw['nets']:
            keys(r, 'name width clearance layers source')
            if not isinstance(r['name'], str) or not r['name'] or not isinstance(r['source'], str) or not r['source']:
                raise ValueError('net name and rule source required')
            nets.append(NetRule(r['name'], number(r['width'], 'width', True),
                                number(r['clearance'], 'clearance'), layer_set(r['layers']), r['source']))
        by_net = {r.name: r for r in nets}
        if len(nets) != len(by_net):
            raise ValueError('duplicate net')
        obs = []
        for r in raw['obstacles']:
            keys(r, 'name bounds layers net clearance')
            if not isinstance(r['net'], str) or (r['net'] and r['net'] not in by_net):
                raise ValueError('obstacle net lacks a rule')
            obs.append(Obstacle(r['name'], box(r['bounds']), layer_set(r['layers']),
                                r['net'], number(r['clearance'], 'obstacle clearance')))
        cons = []
        for r in raw['connections']:
            keys(r, 'name net start end layers')
            if not isinstance(r['net'], str) or r['net'] not in by_net:
                raise ValueError('connection net lacks a rule')
            ls = layer_set(r['layers'])
            if not set(ls) <= set(by_net[r['net']].layers):
                raise ValueError('connection requests a forbidden net layer')
            cons.append(Connection(r['name'], r['net'], xy(r['start']), xy(r['end']), ls))
        for items in (obs, cons):
            names = [r.name for r in items]
            if any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
                raise ValueError('unique item names required')
        pairs = []
        seen = set()
        for r in raw['pair_clearances']:
            keys(r, 'nets clearance source')
            ns = r['nets']
            if (not isinstance(ns, list) or len(ns) != 2 or any(not isinstance(n, str) for n in ns)
                    or not isinstance(r['source'], str) or not r['source'].strip()):
                raise ValueError('invalid net-pair clearance')
            ns = tuple(sorted(ns))
            if ns[0] == ns[1] or not set(ns) <= set(by_net) or ns in seen:
                raise ValueError('invalid net-pair clearance')
            pairs.append((ns, number(r['clearance'], 'pair clearance')))
            seen.add(ns)
        unsupported = raw['unsupported']
        if not isinstance(unsupported, list) or any(not isinstance(x, str) or not x for x in unsupported):
            raise ValueError('unsupported requirements must be explicit strings')
        return cls(box(raw['bounds']), number(raw['edge_clearance'], 'edge clearance'),
                   layers, tuple(nets), tuple(obs), tuple(cons), tuple(pairs),
                   tuple(unsupported), fingerprint(raw))

    def gap(self, net, other, other_clearance=0):
        rules = {n.name: n for n in self.nets}
        gap = max(rules[net].clearance, other_clearance,
                  rules[other].clearance if other else 0)
        pair = dict(self.pair_clearances).get(tuple(sorted((net, other))), 0)
        return max(gap, pair)
