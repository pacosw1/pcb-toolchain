import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Board, Footprint } from '../lib/board-types.ts';
import { fanout } from './compact.ts';
import { drawnBoard, fixedRefs, movedFootprint, partBox, referenceBlocks } from './membership-board.ts';
import { derive, match, parseSchematic, shift, tightenBlock, type Box, type Members } from './membership-derive.ts';
import { main } from './membership.ts';

const SCH = `(kicad_sch (version 20260306)
\t(lib_symbols (symbol "x:U" (property "Reference" "U" (at 0 0 0))))
\t(text "POWER: buck" (exclude_from_sim no) (at 10 10 0) (effects (font (size 1.778 1.778) (bold yes))))
\t(symbol (lib_id "x:BUCK") (at 20 20 0) (property "Reference" "U4" (at 0 0 0)) (property "Description" "Buck" (at 0 0 0)))
\t(symbol (lib_id "x:C") (at 30 20 0) (property "Reference" "C34" (at 0 0 0)) (property "Description" "U4 VIN 4.7 uF next to pin 4." (at 0 0 0)))
\t(symbol (lib_id "power:GND") (at 30 30 0) (property "Reference" "#PWR001" (at 0 0 0)))
\t(text "ETHERNET" (exclude_from_sim no) (at 10 100 0) (effects (font (size 1.778 1.778) (bold yes))))
\t(symbol (lib_id "x:PHY") (at 20 120 0) (property "Reference" "U7" (at 0 0 0)) (property "Group" "eth1" (at 0 0 0)))
)
`;

test('a group comes from the field or the bold title above', () => {
  const { parts, titles } = parseSchematic(SCH);
  assert.deepEqual([...parts.keys()].sort(), ['C34', 'U4', 'U7']);   // power symbols and lib_symbols are not parts
  assert.equal(parts.get('U7')!.group, 'eth1');                      // the Group field
  assert.equal(parts.get('U4')!.group, 'POWER: buck');               // else the bold title above
  assert.match(parts.get('C34')!.desc, /U4 VIN/);
  assert.deepEqual(titles.map(([, title]) => title), ['POWER: buck', 'ETHERNET']);
});

const sheet = (group: string, rows: Record<string, string>) => Object.entries(rows).map(([r, desc]) => [r, { group, desc }] as const);
const pads = (rows: Record<string, string[]>) => new Map(Object.entries(rows));

test('a part joins the IC its description names, else by net affinity', () => {
  const s = new Map<string, { group: string; desc: string }>(sheet('pwr', { U4: '', U5: '', C34: 'U4 VIN 4.7 uF', C37: 'U5 VIN 4.7 uF', L1: '', R8: '', C36: 'VDD_3V3 10 uF', D3: 'VBUS TVS at J1', J1: '', R4: '', D1: 'Status LED green' }));
  const p = pads({ U4: ['VBUS', 'GND', 'SW1', 'VBUS', 'FB1'], U5: ['VBUS', 'GND', 'SW2', 'VBUS', 'FB2'], C34: ['VBUS', 'GND'], C37: ['VBUS', 'GND'], L1: ['SW1', 'V33'], R8: ['V33', 'FB1'],
    C36: ['V33', 'GND'], D3: ['VBUS', 'GND'], J1: ['VBUS', 'GND', 'CC', 'X'], R4: ['V33', 'LEDA'], D1: ['LEDA', 'LEDK'] });
  for (let k = 0; k < 4; k++) {   // V33 on more than RAIL_DEG parts: a rail
    s.set(`C9${k}`, { group: 'other', desc: '' });
    p.set(`C9${k}`, ['V33', 'GND']);
  }
  const m = derive(s, p);
  assert.deepEqual(m.blocks.get('U4'), ['C34', 'C36', 'L1', 'R8', 'U4']);   // C36 via L1 / R8 on V33
  assert.deepEqual(m.blocks.get('U5'), ['C37', 'U5']);
  assert.match(m.why.get('C34')!, /names U4/);
  assert.match(m.why.get('D3')!, /connector support/);                       // names J1, no IC: placed with the connector
  assert.match(m.why.get('D1')!, /indicator/);
  assert.ok(!m.blocks.get('U4')!.includes('R4'));                            // LED resistor: signal net LEDA, no tie via V33
  assert.deepEqual([...m.components.get('pwr')!].sort(), ['D1', 'D3', 'J1', 'R4', 'U4', 'U5']);
});

test('a part stays in its group, and a chain follows its IC', () => {
  const s = new Map([...sheet('soc', { U1: '', C1: '', Y1: '', C28: '' }), ...sheet('eth', { U7: '', C45: '' })]);
  const p = pads({ U1: ['V33', 'OSCI', 'OSCO', 'GND'], U7: ['V33', 'X1', 'X2', 'GND'], C1: ['V33', 'GND'], C45: ['V33', 'GND'], Y1: ['OSCI', 'GND', 'OSCO', 'GND'], C28: ['OSCI', 'GND'] });
  const m = derive(s, p);
  assert.deepEqual(m.blocks.get('U1'), ['C1', 'C28', 'U1', 'Y1']);   // C1 and C45 stay in their own group
  assert.deepEqual(m.blocks.get('U7'), ['C45', 'U7']);
});

test('references sort by number and an exact half rounds as Python printed it', () => {
  const p = pads({ U1: ['A', 'B', 'C', 'GND'], ...Object.fromEntries(Array.from({ length: 16 }, (_, k) => [`C${k + 1}`, ['A', 'GND']])) });
  const m = derive(new Map(), p);
  assert.deepEqual(m.blocks.get('U1')!.slice(0, 3), ['C1', 'C2', 'C3']);
  assert.deepEqual(m.blocks.get('U1')!.at(-2), 'C16');
  assert.equal(m.why.get('C1'), 'net affinity 0.062 to U1');   // A is on 17 parts: 1 / 16 = 0.0625, half even
});

test('the match takes the largest overlap of each reference block', () => {
  const r = match(new Map([['U4', ['U4', 'C1', 'C2']]]), new Map([['BUCK', ['U4', 'C1', 'L1']]]));
  assert.equal(r.blocks[0]!.derived, 'U4');
  assert.equal(r.blocks[0]!.jaccard.value, 0.5);
  assert.deepEqual(r.blocks[0]!.missing, ['L1']);
  assert.equal(r.share.value, 0.667);
});

test('tighten moves toward the anchor and keeps the side and the gap', () => {
  const anchor: Box = [0, 0, 4, 4];
  const parts = new Map<string, Box>([['C1', [10, 1.5, 11, 2.5]], ['C2', [1.5, -10, 2.5, -9]]]);
  const d = tightenBlock(anchor, parts, () => true, 0.25, 100);
  const c1 = shift(parts.get('C1')!, ...d.get('C1')!);
  assert.ok(c1[0] > anchor[2]);                         // still east of the IC
  assert.ok(c1[0] - anchor[2] >= 0.25 - 1e-9);
  assert.ok(c1[0] - anchor[2] < 0.4);                   // but close
  assert.ok(Math.abs(d.get('C1')![1]) < 1e-9);          // on its own centre line (centre y 2 = anchor y)
  const c2 = shift(parts.get('C2')!, ...d.get('C2')!);
  assert.ok(c2[3] < anchor[1]);                         // still north
});

test('a blocked part stays', () => {
  const d = tightenBlock([0, 0, 4, 4], new Map<string, Box>([['C1', [5, 1, 6, 2]]]), q => q[0] >= 4.9);
  assert.deepEqual(d.get('C1')!.map(Math.abs), [0, 0]);
});

const MM = 1_000_000;
const pt = (x: number, y: number) => ({ x: x * MM, y: y * MM });
const ring = (x0: number, y0: number, x1: number, y1: number) => ({ outline: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], holes: [] });
const pad = (net: string, x: number, y: number, kind = 'Smd') => ({ number: '1', kind, net, position: pt(x, y), drill: pt(0, 0), copper: [], polygons: { 'F.Cu': ring(x - 0.5, y - 0.5, x + 0.5, y + 0.5) },
  bbox: { left: (x - 0.5) * MM, top: (y - 0.5) * MM, right: (x + 0.5) * MM, bottom: (y + 0.5) * MM } });
const part = (reference: string, x: number, y: number, rest: object = {}) => ({ id: `fp-${reference}`, reference, lib_id: 'x:y', layer: 'F.Cu', position: pt(x, y), locked: false, pads: [pad('N', x, y)], courtyard_front: [ring(x - 1, y - 1, x + 1, y + 1)], ...rest }) as unknown as Footprint;
const boardOf = (footprints: Footprint[], rest: object = {}) => ({ footprints, copper: [], graphics: [], texts: [], outlines: [ring(0, 0, 50, 50)], ...rest }) as unknown as Board;

test('the rect of a part covers its courtyard and copper pads, not an NPTH hole', () => {
  assert.deepEqual(partBox(part('C1', 10, 10)), [9, 9, 11, 11]);
  assert.deepEqual(partBox(part('C1', 10, 10, { pads: [pad('N', 12, 10)] })), [9, 9, 12.5, 11]);
  assert.deepEqual(partBox(part('H1', 10, 10, { pads: [pad('', 12, 10, 'NpThroughHole')] })), [9, 9, 11, 11]);
  assert.deepEqual(partBox(part('C1', 10, 10, { courtyard_front: [] })), [9.25, 9.25, 10.75, 10.75]);   // no courtyard: pads + 0.25
});

test('a cohesion net is no escaping track', () => {
  const unit = (name: string) => ({ name, refs: [name], fixed: false, x: 0, y: 0, rects: [[-1, -1, 1, 1, 0.5]] });
  const nets = [{ name: 'S', weight: 1, pins: [[0, 0, 0, 0, 0], [2, 0, 0, 0, 0]] }, { name: '~comp:X', weight: 2, pins: [[0, -1, -1, 1, 1], [1, -1, -1, 1, 1]], track: 0, cohesion: true }];
  assert.deepEqual(fanout({ units: ['A', 'B', 'C'].map(unit), nets, board: { outline: [] } } as never), [1, 0, 1]);
});

test('the fixed parts are those iotplace read keeps fixed', () => {
  const track = { Track: { id: 't', start: pt(20, 20), end: pt(30, 20), mid: null, width: 200_000, layer: 'F.Cu', net: 'N', locked: true } };
  const b = boardOf([
    part('C1', 20, 20), part('C2', 25, 10, { pads: [pad('M', 25, 10)] }), part('C3', 5, 5, { locked: true, pads: [pad('M', 5, 5)] }), part('C4', 5, 10, { layer: 'B.Cu', pads: [pad('M', 5, 10)] }),
    part('H1', 40, 40, { pads: [] }), part('X1', 7, 7, { lib_id: 'lib:MountingHole_3mm', pads: [] }),
    part('J1', 0.5, 25, { pads: [pad('M', 0.5, 25)] }), part('J2', 25, 25, { pads: [pad('M', 25, 25)] }), part('J3', 60, 60, { pads: [pad('M', 60, 60)] }),
  ], { copper: [track] });
  assert.deepEqual(fixedRefs(b), ['C1', 'C3', 'C4', 'H1', 'J1', 'X1']);   // J2 inside, J3 staged outside, C2 on no locked copper
  assert.throws(() => fixedRefs(boardOf([], { outlines: [] })), /no closed board outline/);
});

const FOOTPRINT = `(footprint "x:y"
\t(layer "F.Cu")
\t(uuid "fp-C1")
\t(at 10 20 90)
\t(property "Reference" "C1" (at 0 -1 0))
\t(pad "1" smd rect (at 1 0 90))
\t(zone (polygon (pts (xy 9 19) (xy 11.5 19))))
)`;

test('a moved footprint changes its place and the board coordinates of its zones only', () => {
  const out = movedFootprint(FOOTPRINT, part('C1', 10, 20), { x: 1_500_000, y: -250_000 });
  assert.match(out, /\(at 11\.5 19\.75 90\)/);
  assert.match(out, /\(xy 10\.5 18\.75\) \(xy 13 18\.75\)/);
  assert.match(out, /\(pad "1" smd rect \(at 1 0 90\)\)/);
  assert.match(out, /"C1" \(at 0 -1 0\)/);
  assert.throws(() => movedFootprint(FOOTPRINT, part('C1', 10, 21), pt(1, 0)), /disagree/);
});

const TEXT = `(kicad_pcb
\t(gr_line (start 1 1) (end 2 1) (layer "User.1") (uuid "old-line"))
\t(gr_text "OLD" (at 1 1 0) (layer "User.2") (uuid "old-text"))
\t(gr_line (start 0 0) (end 50 0) (layer "Edge.Cuts") (uuid "edge"))
\t${FOOTPRINT.replaceAll('C1', 'C2').replace('(at 10 20 90)', '(at 30 10)')}
\t${FOOTPRINT.replace('(at 10 20 90)', '(at 20 10 90)')}
\t${FOOTPRINT.replaceAll('C1', 'U1').replace('(at 10 20 90)', '(at 10 10)')}
)
`;

const members = (rows: Partial<Members>): Members => ({ blocks: new Map(), components: new Map(), why: new Map(), ...rows });

function drawnFixture(): [Board, Members] {
  const u1 = part('U1', 10, 10, { pads: [pad('A', 9, 10), pad('B', 11, 10), pad('C', 10, 9), pad('D', 10, 11)], courtyard_front: [ring(8, 8, 12, 12)] });
  const graphics = [{ id: 'old-line', layer: 'User.1', geometry: 'Other' }, { id: 'edge', layer: 'Edge.Cuts', geometry: 'Other' }];
  const b = boardOf([u1, part('C1', 20, 10), part('C2', 30, 10)], { graphics, texts: [{ id: 'old-text', layer: 'User.2', text: 'OLD', position: pt(1, 1) }] });
  return [b, members({ blocks: new Map([['U1', ['C1', 'U1']]]), components: new Map([['pwr', ['U1', 'C2']]]) })];
}

test('the draw replaces old borders and keeps the rest', () => {
  const [b, m] = drawnFixture();
  const { text, tightened } = drawnBoard(TEXT, b, m, null);
  assert.equal(tightened.size, 0);
  assert.ok(!text.includes('old-line') && !text.includes('"OLD"') && text.includes('"edge"'));
  assert.match(text, /\(gr_line\n\t\t\(start 7\.7 7\.7\)\n\t\t\(end 21\.3 7\.7\)\n\t\t\(stroke\n\t\t\t\(width 0\.08\)\n\t\t\t\(type default\)\n\t\t\)\n\t\t\(layer "User\.1"\)/);
  assert.match(text, /\(gr_text "U1"\n\t\t\(at 7\.9 8\.2 0\)\n\t\t\(layer "User\.1"\)/);
  assert.match(text, /\(size 0\.6 0\.6\)\n\t\t\t\t\(thickness 0\.12\)/);
  assert.match(text, /\(start 7\.2 7\.2\)\n\t\t\(end 31\.5 7\.2\)\n\t\t\(stroke\n\t\t\t\(width 0\.12\)/);   // the component holds the block box and C2
  assert.match(text, /\(gr_text "pwr"\n\t\t\(at 7\.4 12\.3 0\)\n\t\t\(layer "User\.2"\)/);
  assert.equal(text.match(/\(gr_line\n/g)!.length, 8);
});

test('the tighten moves a passive of a free block, and the border follows it', () => {
  const [b, m] = drawnFixture();
  const { text, tightened } = drawnBoard(TEXT, b, m, []);
  const move = tightened.get('C1')!;
  assert.deepEqual(move.map(v => v.value), [-6.5, 0]);   // t = 0.35 of the 10 mm: courtyard edges 12 and 12.5 keep the 0.25 gap
  assert.match(text, /\(uuid "fp-C1"\)\n\t\(at 13\.5 10 90\)/);
  assert.match(text, /\(end 14\.8 7\.7\)/);
});

test('a block with a fixed part keeps its parts', () => {
  const [b, m] = drawnFixture();
  assert.equal(drawnBoard(TEXT, b, m, ['C1']).tightened.size, 0);
});

const line = (id: string, a: [number, number], c: [number, number]) => ({ id, layer: 'User.1', geometry: { Segment: { start: pt(...a), end: pt(...c) } } });

test('reference blocks come from rectangles, closed lines and their labels', () => {
  const lines = [line('a', [10, 10], [20, 10]), line('b', [10, 20], [20, 20]), line('c', [10, 10], [10, 20]), line('d', [20, 10], [20, 20])];
  const rect = { id: 'r', layer: 'User.1', geometry: { Rect: { top_left: pt(30, 10), bottom_right: pt(40, 20) } } };
  const b = boardOf([part('C10', 12, 12), part('C2', 15, 15), part('U1', 35, 15), part('R1', 45, 45)], { graphics: [...lines, rect], texts: [{ id: 't', layer: 'User.1', text: 'BUCK', position: pt(10.5, 9) }] });
  assert.deepEqual([...referenceBlocks(b)], [['BLOCK1', ['U1']], ['BUCK', ['C2', 'C10']]]);
});

test('the command writes the membership and asks for a saved copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'membership-test-'));
  const [sch, pcb, out, draw] = ['b.kicad_sch', 'b.kicad_pcb', 'members.json', 'o.kicad_pcb'].map(n => join(dir, n)) as [string, string, string, string];
  try {
    writeFileSync(sch, SCH.replace('(at 20 20 0)', '(at 20 20 0) (property "Group" "pwr" (at 0 0 0))'));
    writeFileSync(pcb, TEXT);
    const [b] = drawnFixture();
    b.footprints[0]!.pads[0]!.net = 'N';
    const saved: string[] = [];
    const save = ((_: string, text: string, work: string) => {
      saved.push(text);
      writeFileSync(join(work, 'x.kicad_pcb'), text);
      return { board: join(work, 'x.kicad_pcb') };
    }) as never;
    const lines: string[] = [];
    const log = console.log;
    console.log = (text: string) => lines.push(text);
    try { assert.equal(main(['derive', sch, pcb, '-o', out, '--draw', draw, '--tighten'], { board: () => b, save }), 0); } finally { console.log = log; }
    const m = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(Object.keys(m), ['blocks', 'components', 'why', 'source', 'fixed', 'soft_blocks', 'tightened']);
    assert.deepEqual(m.blocks, { U1: ['C1', 'C2', 'U1'] });
    assert.deepEqual(m.fixed, []);
    assert.equal(lines[0], '{"blocks": 1, "soft_blocks": [], "components": 0, "match_share": null, "tightened": 2}');
    assert.equal(readFileSync(draw, 'utf8'), saved[0]);
    assert.throws(() => main(['derive', sch, pcb, '-o', out, '--draw', pcb], { board: () => b, save }), /copy only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
