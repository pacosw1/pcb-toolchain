#!/usr/bin/env node
// Cluster proposer: reads a .kicad_pcb and says which parts belong together and why, before placement.
//
//   node tools/placer/clusters.mjs BOARD.kicad_pcb [-o clusters.json]
//
// Prints one block per cluster, one line per part with its rule and reason, then a one-line summary. -o also writes
// the JSON that `cli.py read --auto-clusters FILE` takes. The board file is only read.
//
// A proposal uses the netlist and the part fields (reference, value, Description), never the positions, so a spread
// board and a placed board get the same answer. It is advice for a soft search term: it has no authority over a
// reviewed rule, a fixed part, a keepout or a clearance. tools/placer/README.md "Automatic clusters" has the search side.
//
// Model. Each part gets at most one tie: its pad, the pad it should sit next to, on one net, with the rule and the
// reason. The reader checks each end against the board, so a stale proposal stops. Ties form a tree; a cluster is one
// tree, named after its root (an IC or a connector). A part with a mechanical, user or test role (a connector, a button,
// an indicator LED, a test point, a hole) is never tied to anything: its place has another reason. Rules, first match wins:
//   crystal    a crystal to its IC pin, its load caps and feedback resistor to the crystal
//   esd        an ESD or TVS part to the connector pin of its net, else to the IC pin
//   regulator  the switch node, feedback and bootstrap parts of a regulator, and its input and output caps
//   series     a series resistor or ferrite on a short link to a connector pin, else to an IC pin
//   decap      a capacitor from a power net to ground to an IC power pin
//   filter     a capacitor from a signal net to ground to the IC pin of that net
//   support    a passive on a short net with one IC, connector, transistor or relay pin, and the passive behind it
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const SCHEMA = 'iot-lab.placer-clusters.v1';

// Sources. Nothing here is an electrical limit; each number only decides which parts are grouped.
const IC_PADS = 3;      // an IC is a U with more pads than this: kicad_io._decaps, escape.py, membership.py
const RAIL_DEG = 6;     // a net on more parts is a rail: membership.py RAIL_DEG
const LINK_PARTS = 3;   // default to tune: a series link is the part, its end, and one extra (a TVS)
const SUPPORT_PARTS = 4;  // default to tune: one more, for a divider plus its filter cap at one pin (RELAY-4 /RB_K1)
const REG_PADS = 16;    // default to tune: above this a U is not a regulator (an MCU Description also says "regulator")
const CHAIN_DEPTH = 2;  // default to tune: a compensation R then C reaches one passive behind the IC pin, not a whole filter
const GROUND = /GND|VSS|(^|[_/])0V$/i;  // the ground nets of the iot-lab boards: GND, FIELD_GND, FGND2, /CAN_GND, FIELD_0V
const POWER = /^[+-]?\d|V(CC|DD|BAT|BUS|IN|S|CORE|SYS|REF)|\dV\d|\dV($|_)|L\+/i;  // +3V3, VDD_3V3, 24V_IN, FIELD_5V, /L+
const CONNECTOR = new Set(['J', 'P', 'CN']);  // kicad_io.part_fixed, membership.py CONNECTOR
const CRYSTAL = new Set(['Y', 'X']);
const PASSIVE = new Set(['R', 'C', 'L', 'FB', 'D', 'LED']);
const ACTIVE = new Set(['U', 'Q', 'K', 'T']);
// Their place comes from the enclosure, the user or test access (README "Fixed user-facing parts"), not from the netlist.
const ANCHORED = new Set(['SW', 'BT', 'BZ', 'TP', 'H', 'MH', 'LED']);
const INDICATOR = /\bLED\b|indicator/i;
const ESD = /\b(ESD|TVS)|PESD|SMAJ|SMBJ|SMCJ|SMF\d|USBLC|PRTR|SRV05|TPD\d|CDSOT/i;
const REGULATOR = /regulator|\bLDO\b|\bbuck\b|\bboost\b|DC.?DC|switcher/i;

const prefix = ref => /^[A-Za-z_]*/.exec(ref)[0];
const natural = (a, b) => a.localeCompare(b, 'en', {numeric: true});

// Nested arrays; an atom or a string is a JS string. Enough of the KiCad format for the items read here.
export function parseSexpr(text) {
  const stack = [];
  let cur = [], i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '(') { stack.push(cur); cur = []; i++; }
    else if (c === ')') { const done = cur; cur = stack.pop(); cur.push(done); i++; }
    else if (c === '"') {
      let j = i + 1, s = '';
      while (text[j] !== '"') {
        if (text[j] === '\\') { s += text.slice(i + 1, j); s += text[j + 1] === 'n' ? '\n' : text[j + 1]; j += 2; i = j - 1; }
        else j++;
      }
      cur.push(s + text.slice(i + 1, j));
      i = j + 1;
    } else if (c === ' ' || c === '\n' || c === '\t' || c === '\r') i++;
    else {
      let j = i;
      while (j < n && !' \n\t\r()"'.includes(text[j])) j++;
      cur.push(text.slice(i, j));
      i = j;
    }
  }
  return cur[0];
}

const kids = (node, name) => node.filter(x => Array.isArray(x) && x[0] === name);

// [{ref, value, description, pads: [{num, net}]}]; a pad with no net has net ''.
export function readBoard(text) {
  const parts = [];
  for (const fp of kids(parseSexpr(text), 'footprint')) {
    const prop = k => kids(fp, 'property').find(p => p[1] === k)?.[2] ?? '';
    const pads = kids(fp, 'pad').map(p => {
      const net = kids(p, 'net')[0];
      return {num: p[1], net: net ? net[net.length - 1] : ''};  // KiCad 10: (net "A"); older: (net 3 "A")
    });
    const ref = prop('Reference');
    if (ref) parts.push({ref, value: prop('Value'), description: prop('Description'), mpn: prop('MPN'), lib: fp[1], pads});
  }
  return parts;
}

// Farads from 100nF, 4.7uF, 2u2, 10 µF; 0 when it is not a capacitance.
export function farads(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([pnuµm])\s*(\d*)/i.exec(value || '');
  if (!m) return 0;
  const scale = {p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, m: 1e-3}[m[2].toLowerCase()];
  return Number(m[1] + (m[3] ? '.' + m[3] : '')) * scale;
}

class Netlist {
  constructor(parts) {
    this.parts = new Map(parts.map(p => [p.ref, p]));
    this.nets = new Map();  // net -> [{ref, num}]
    for (const p of parts) {
      for (const pad of p.pads) {
        if (!pad.net || pad.net.startsWith('unconnected-')) continue;
        if (!this.nets.has(pad.net)) this.nets.set(pad.net, []);
        this.nets.get(pad.net).push({ref: p.ref, num: pad.num});
      }
    }
    this.ties = new Map();  // ref -> tie
    this.names = new Map(parts.map(p => [p.ref, new Set(
      (p.description.match(/\b[A-Z]{1,3}\d+\b/g) || []).filter(r => r !== p.ref && this.parts.has(r)))]));
  }

  kind(ref) { return prefix(ref); }
  isTestPoint(ref) { return this.kind(ref) === 'TP'; }
  isEsd(ref) {
    const p = this.parts.get(ref);
    return ['U', 'D'].includes(this.kind(ref)) && ESD.test(`${p.value} ${p.mpn} ${p.description}`);
  }
  isIc(ref) { return this.kind(ref) === 'U' && this.parts.get(ref).pads.length > IC_PADS && !this.isEsd(ref); }
  isConnector(ref) { return CONNECTOR.has(this.kind(ref)); }
  isAnchored(ref) {
    const p = this.parts.get(ref);
    return this.isConnector(ref) || ANCHORED.has(this.kind(ref)) ||
      (this.kind(ref) === 'D' && INDICATOR.test(`${p.value} ${p.description} ${p.lib}`));
  }
  isGround(net) { return GROUND.test(net); }
  partsOn(net) { return new Set((this.nets.get(net) || []).filter(e => !this.isTestPoint(e.ref)).map(e => e.ref)); }
  isRail(net) { return this.isGround(net) || this.partsOn(net).size > RAIL_DEG; }
  isLink(net, parts = LINK_PARTS) { return !this.isGround(net) && this.partsOn(net).size <= parts; }
  netsOf(ref) { return this.parts.get(ref).pads.filter(p => p.net && this.nets.has(p.net)); }
  padOn(ref, net) { return this.parts.get(ref).pads.find(p => p.net === net); }
  twoPad(ref) { return this.parts.get(ref).pads.length === 2; }
  free(ref) { return !this.ties.has(ref); }

  tie(ref, net, to, toPad, rule, why) {
    if (!this.isAnchored(ref)) this.ties.set(ref, {ref, pad: this.padOn(ref, net).num, to, to_pad: toPad, net, rule, why});
  }

  // Pins of the parts `want` selects on a net: [{ref, num}], in board order.
  pins(net, want) { return (this.nets.get(net) || []).filter(e => want(e.ref)); }
}

// Is this U a regulator? By its fields, or by its circuit: an inductor on a short net with one of its pins.
function regulators(nl) {
  const out = new Set();
  for (const [ref, p] of nl.parts) {
    if (nl.kind(ref) !== 'U' || nl.isEsd(ref)) continue;
    if (p.pads.length > REG_PADS) continue;
    if (REGULATOR.test(`${p.value} ${p.description}`)) out.add(ref);
    for (const {net} of nl.netsOf(ref)) {
      if (!nl.isRail(net) && [...nl.partsOn(net)].some(r => nl.kind(r) === 'L')) out.add(ref);
    }
  }
  return out;
}

function ruleCrystal(nl) {
  for (const ref of [...nl.parts.keys()].sort(natural)) {
    if (!CRYSTAL.has(nl.kind(ref))) continue;
    const signal = [...new Set(nl.netsOf(ref).map(p => p.net))].filter(n => !nl.isRail(n));
    if (!signal.length) continue;
    const label = `crystal ${ref}`;
    for (const net of signal) {
      for (const r of nl.partsOn(net)) {
        if (r === ref || !nl.free(r) || !nl.twoPad(r)) continue;
        const nets = nl.parts.get(r).pads.map(p => p.net);
        const other = nets.find(n => n !== net);
        if (nl.kind(r) === 'C' && other && nl.isGround(other)) {
          nl.tie(r, net, ref, nl.padOn(ref, net).num, 'crystal', `load cap of ${label} on ${net}`);
        } else if (nl.kind(r) === 'R' && nets.every(n => signal.includes(n))) {
          nl.tie(r, net, ref, nl.padOn(ref, net).num, 'crystal', `feedback resistor across ${label}`);
        }
      }
    }
    // The IC pin: on the crystal's own net, or behind a series resistor on it.
    let best = null;
    for (const net of signal) {
      const pin = nl.pins(net, r => nl.isIc(r))[0];
      if (pin) { best = {net, pin}; break; }
    }
    if (best) {
      nl.tie(ref, best.net, best.pin.ref, best.pin.num, 'crystal', `crystal on ${best.net} at ${best.pin.ref} pin ${best.pin.num}`);
      continue;
    }
    for (const net of signal) {
      for (const r of nl.partsOn(net)) {
        if (nl.kind(r) !== 'R' || !nl.free(r) || !nl.twoPad(r)) continue;
        const other = nl.parts.get(r).pads.map(p => p.net).find(n => n !== net);
        const pin = other && nl.pins(other, q => nl.isIc(q))[0];
        if (pin && !best) {
          best = {net, pin};
          nl.tie(r, other, pin.ref, pin.num, 'crystal', `series resistor of ${label} at ${pin.ref} pin ${pin.num}`);
          nl.tie(ref, net, r, nl.padOn(r, net).num, 'crystal', `crystal behind ${r} on ${net}`);
        }
      }
    }
  }
}

function ruleEsd(nl) {
  for (const ref of [...nl.parts.keys()].sort(natural)) {
    if (!nl.isEsd(ref) || !nl.free(ref)) continue;
    const nets = nl.netsOf(ref).filter(p => !nl.isGround(p.net));
    const end = want => nets.flatMap(p => nl.pins(p.net, want).map(q => ({net: p.net, pin: q})))[0];
    const hit = end(r => nl.isConnector(r)) || end(r => nl.isIc(r));
    if (hit) {
      nl.tie(ref, hit.net, hit.pin.ref, hit.pin.num, 'esd',
        `ESD/TVS part on ${hit.net} next to ${hit.pin.ref} pin ${hit.pin.num}`);
    }
  }
}

function ruleSeries(nl) {
  for (const ref of [...nl.parts.keys()].sort(natural)) {
    if (!['R', 'FB'].includes(nl.kind(ref)) || !nl.free(ref) || !nl.twoPad(ref)) continue;
    const [a, b] = nl.parts.get(ref).pads.map(p => p.net);
    if (!a || !b || a === b || [a, b].some(n => nl.isRail(n) || POWER.test(n))) continue;
    if (!nl.isLink(a) && !nl.isLink(b)) continue;
    const ends = [a, b].flatMap(net => nl.pins(net, r => r !== ref && (nl.isConnector(r) || nl.isIc(r))).map(pin => ({net, pin})));
    if (!ends.length) continue;
    // A part the Description names wins; then a connector (protection sits at the entry), then the shortest net.
    const named = nl.names.get(ref);
    ends.sort((p, q) => (named.has(q.pin.ref) - named.has(p.pin.ref))
      || (nl.isConnector(q.pin.ref) - nl.isConnector(p.pin.ref))
      || (nl.partsOn(p.net).size - nl.partsOn(q.net).size) || natural(p.pin.ref, q.pin.ref));
    const {net, pin} = ends[0];
    nl.tie(ref, net, pin.ref, pin.num, 'series', `series part on ${net} next to ${pin.ref} pin ${pin.num}`);
  }
}

function ruleRegulator(nl, regs) {
  for (const reg of [...regs].sort(natural)) {
    // Switch node and bootstrap first: an inductor, diode or cap on a short net with a regulator pin.
    for (const {net, num} of nl.netsOf(reg)) {
      if (nl.isRail(net)) continue;
      for (const r of nl.partsOn(net)) {
        if (r === reg || !nl.free(r) || !PASSIVE.has(nl.kind(r)) || !nl.twoPad(r)) continue;
        const what = {L: 'switch node inductor', D: 'switch node diode', C: 'bootstrap or filter cap', R: 'feedback or set resistor'}[nl.kind(r)] || 'part';
        nl.tie(r, net, reg, num, 'regulator', `${what} on ${net} at regulator ${reg} pin ${num}`);
      }
    }
  }
}

// Caps from a rail to ground. A Description that names a part on the rail decides. The rest of a rail go over its pins
// so that each pin gets the same number, the biggest cap to a regulator (bulk at the source) and small caps to the loads.
function ruleDecap(nl, regs) {
  const onNet = new Map();
  for (const ref of [...nl.parts.keys()].sort(natural)) {
    if (nl.kind(ref) !== 'C' || !nl.free(ref) || !nl.twoPad(ref)) continue;
    const [a, b] = nl.parts.get(ref).pads.map(p => p.net);
    if (!a || !b || nl.isGround(a) === nl.isGround(b)) continue;
    const net = nl.isGround(a) ? b : a;
    if (!onNet.has(net)) onNet.set(net, []);
    onNet.get(net).push(ref);
  }
  for (const [net, caps] of [...onNet].sort((p, q) => natural(p[0], q[0]))) {
    const source = r => regs.has(r);
    const pins = nl.pins(net, r => nl.isIc(r) || source(r));
    const power = nl.isRail(net) || POWER.test(net);
    const outputs = [];  // the far pad of a tied inductor is a regulator output
    for (const r of nl.partsOn(net)) {
      const t = nl.ties.get(r);
      if (nl.kind(r) === 'L' && t?.rule === 'regulator') outputs.push({ref: r, num: nl.padOn(r, net).num});
    }
    const all = [...pins, ...outputs];
    if (!all.length) continue;
    const count = new Map(all.map(p => [`${p.ref}.${p.num}`, 0]));
    const add = (cap, pin, why) => {
      count.set(`${pin.ref}.${pin.num}`, count.get(`${pin.ref}.${pin.num}`) + 1);
      const rule = source(pin.ref) || nl.kind(pin.ref) === 'L' ? 'regulator' : power ? 'decap' : 'filter';
      nl.tie(cap, net, pin.ref, pin.num, rule, why);
    };
    const open = [];
    for (const cap of caps) {
      // A Description copied from a block sheet can name a part of another instance: the pin it states must be on this net.
      const wanted = /\bpins?\s+(\d+)/i.exec(nl.parts.get(cap).description)?.[1];
      const named = all.filter(p => nl.names.get(cap).has(p.ref) && (!wanted || p.num === wanted));
      if (named.length) {
        const pin = leastUsed(named, count);
        add(cap, pin, `Description names ${pin.ref}: ${net} at pin ${pin.num}`);
      } else open.push(cap);
    }
    open.sort((p, q) => farads(nl.parts.get(q).value) - farads(nl.parts.get(p).value) || natural(p, q));
    const loads = pins.filter(p => !source(p.ref));
    const sources = all.filter(p => !loads.includes(p));
    for (const cap of open) {
      const untaken = sources.filter(p => count.get(`${p.ref}.${p.num}`) === 0);
      const pool = untaken.length ? untaken : loads.length ? loads : sources;
      const pin = leastUsed(pool, count);
      const shared = new Set(all.map(p => p.ref)).size;
      add(cap, pin, `${nl.parts.get(cap).value || 'cap'} on ${net} at ${pin.ref} pin ${pin.num}` +
        (shared > 1 ? `; rail shared by ${shared} parts, spread by count` : ''));
    }
  }
}

function leastUsed(pins, count) {
  return [...pins].sort((p, q) => count.get(`${p.ref}.${p.num}`) - count.get(`${q.ref}.${q.num}`) ||
    natural(p.ref, q.ref) || natural(p.num, q.num))[0];
}

function ruleSupport(nl) {
  for (let depth = 0; depth < CHAIN_DEPTH; depth++) {
    for (const ref of [...nl.parts.keys()].sort(natural)) {
      if (!PASSIVE.has(nl.kind(ref)) || !nl.free(ref) || !nl.twoPad(ref)) continue;
      for (const {net} of nl.netsOf(ref)) {
        if (!nl.isLink(net, SUPPORT_PARTS) || POWER.test(net)) continue;
        const others = [...nl.partsOn(net)].filter(r => r !== ref);
        const hard = others.filter(r => nl.isConnector(r) || ACTIVE.has(nl.kind(r)));
        // Behind a tied passive only on a link with no active part: /COIL1 has a relay, so its LED is not the expander's.
        const target = depth === 0 ? hard[0] : !hard.length && nl.isLink(net) && others.find(r => nl.ties.has(r) && nl.twoPad(r));
        if (!target || (depth === 0 && hard.length !== 1)) continue;
        nl.tie(ref, net, target, nl.padOn(target, net).num, 'support',
          depth === 0 ? `only passive link of ${net} to ${target}` : `behind ${target} on ${net}`);
        break;
      }
    }
  }
}

export function propose(parts) {
  const nl = new Netlist(parts);
  const regs = regulators(nl);
  ruleCrystal(nl);
  ruleEsd(nl);
  ruleRegulator(nl, regs);
  ruleSeries(nl);
  ruleDecap(nl, regs);
  ruleSupport(nl);
  const rootOf = ref => {
    let r = ref;
    while (nl.ties.has(r)) r = nl.ties.get(r).to;
    return r;
  };
  const groups = new Map();
  for (const t of nl.ties.values()) {
    const root = rootOf(t.ref);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(t);
  }
  const depth = t => (nl.ties.has(t.to) ? 1 + depth(nl.ties.get(t.to)) : 0);
  const clusters = [...groups].sort((a, b) => natural(a[0], b[0])).map(([anchor, ties]) => {
    ties.sort((a, b) => depth(a) - depth(b) || natural(a.ref, b.ref));  // parents first: gather places them in order
    const rules = {};
    for (const t of ties) rules[t.rule] = (rules[t.rule] || 0) + 1;
    const p = nl.parts.get(anchor);
    const list = Object.entries(rules).map(([k, v]) => `${v} ${k}`).join(', ');
    return {name: anchor, anchor, value: p.value, regulator: regs.has(anchor), parts: [anchor, ...ties.map(t => t.ref)],
      why: `${anchor} ${p.value}${regs.has(anchor) ? ' (regulator)' : ''}: ${list}`, ties};
  });
  const inCluster = new Set(clusters.flatMap(c => c.parts));
  const loose = [...nl.parts.keys()].filter(r => !inCluster.has(r) && !nl.isTestPoint(r) && nl.netsOf(r).length).sort(natural);
  const rules = {};
  for (const t of nl.ties.values()) rules[t.rule] = (rules[t.rule] || 0) + 1;
  return {schema: SCHEMA, clusters, loose, summary: {parts: parts.length, clusters: clusters.length,
    clustered: inCluster.size, ties: nl.ties.size, rules}};
}

export function render(res) {
  const lines = [];
  for (const c of res.clusters) {
    lines.push(`${c.why}`);
    for (const t of c.ties) lines.push(`  ${t.ref}.${t.pad} -> ${t.to}.${t.to_pad}  ${t.rule}: ${t.why}`);
  }
  if (res.loose.length) lines.push(`no rule: ${res.loose.join(' ')}`);
  const s = res.summary;
  lines.push(`SUMMARY clusters ${s.clusters}, clustered parts ${s.clustered} of ${s.parts}, ` +
    Object.entries(s.rules).map(([k, v]) => `${k} ${v}`).join(', '));
  return lines.join('\n');
}

function main(argv) {
  const out = argv.includes('-o') ? argv[argv.indexOf('-o') + 1] : null;
  const board = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '-o');
  if (!board) {
    console.error('usage: clusters.mjs BOARD.kicad_pcb [-o clusters.json]');
    return 2;
  }
  const res = {...propose(readBoard(readFileSync(board, 'utf8'))), board: path.basename(board)};
  if (out) writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  console.log(render(res));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
