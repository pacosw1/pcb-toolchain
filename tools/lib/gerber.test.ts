import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check, parseNetlist, type Pad } from '../gerber_netcheck.ts';
import { CopperLayer, Outline, relate, type Xy } from './copper-graph.ts';
import { capsule, circle, parseCopper, parseDrill } from './gerber.ts';

const HEADER = '%FSLAX46Y46*%\n%MOMM*%\n';
const gerber = (...lines: string[]) => `${HEADER}${lines.join('\n')}\nM02*\n`;
const layer = (...lines: string[]) => new CopperLayer(parseCopper(gerber(...lines)));
const square = (x: number, y: number, size = 1): Outline =>
  new Outline([[x, y], [x + size, y], [x + size, y + size], [x, y + size]]);

test('a circle has the 96 vertices of buffer(r, 24), from angle 0', () => {
  const points = circle(1, 2, 3);
  assert.equal(points.length, 96);
  assert.deepEqual(points[0], [4, 2]);
});

test('a line of no length is a circle, and a line is a capsule of two half circles', () => {
  assert.equal(capsule([0, 0], [0, 0], 1).length, 96);
  assert.equal(capsule([0, 0], [5, 0], 1).length, 98);
});

test('shapes join on a shared edge or area, not on a single point', () => {
  assert.equal(relate(square(0, 0), square(0.5, 0.5)), 2);
  assert.equal(relate(square(0, 0), square(1, 0)), 2);
  assert.equal(relate(square(0, 0), square(1, 1)), 1);
  assert.equal(relate(square(0, 0), square(3, 3)), 0);
  assert.equal(relate(square(0, 0, 9), square(4, 4)), 2);
  assert.equal(new CopperLayer([square(0, 0), square(1, 1)]).pieces, 2);
  assert.equal(new CopperLayer([square(0, 0), square(1, 0)]).pieces, 1);
});

test('a hit counts a single point of contact, as intersects does', () => {
  const copper = new CopperLayer([square(0, 0)]);
  assert.deepEqual(copper.piecesAt([1, 1]), [0]);
  assert.deepEqual(copper.piecesAt([1.1, 1]), []);
  assert.deepEqual(copper.piecesHit(square(1, 1)), [0]);
  assert.deepEqual(copper.piecesHit(square(2, 2)), []);
});

test('a keyholed zone outline has its hole: a pad there is not on the zone', () => {
  const zone = ['G36*', 'X0Y0D02*', 'G01*', 'X6000000Y0D01*', 'X6000000Y6000000D01*', 'X0Y6000000D01*', 'X0Y0D01*',
    'X2000000Y2000000D01*', 'X2000000Y4000000D01*', 'X4000000Y4000000D01*', 'X4000000Y2000000D01*', 'X2000000Y2000000D01*', 'X0Y0D01*', 'G37*'];
  const copper = layer(...zone);
  assert.deepEqual(copper.piecesAt([1, 1]), [0]);
  assert.deepEqual(copper.piecesAt([3, 3]), []);
});

test('flashes and lines take the sizes gerbonara gave them', () => {
  assert.deepEqual(layer('%ADD10C,1.000000*%', 'D10*', 'X0Y0D03*').piecesAt([0.49, 0]), [0]);
  assert.deepEqual(layer('%ADD10R,2.000000X1.000000*%', 'D10*', 'X0Y0D03*').piecesAt([0.9, 0.4]), [0]);
  const obround = layer('%ADD10O,3.000000X1.000000*%', 'D10*', 'X0Y0D03*');
  assert.deepEqual(obround.piecesAt([1.4, 0]), [0]);
  assert.deepEqual(obround.piecesAt([1.4, 0.4]), []);
  // a line drawn with a rectangle is as wide as its diagonal
  const drawn = layer('%ADD10R,3.000000X4.000000*%', 'D10*', 'X0Y0D02*', 'X10000000Y0D01*');
  assert.deepEqual(drawn.piecesAt([5, 2.4]), [0]);
  assert.deepEqual(drawn.piecesAt([5, 2.6]), []);
});

test('an aperture hole is filled, as it was', () => {
  assert.deepEqual(layer('%ADD10C,2.000000X1.000000*%', 'D10*', 'X0Y0D03*').piecesAt([0, 0]), [0]);
});

test('a line after an arc is a line again', () => {
  const copper = layer('%ADD10C,0.100000*%', 'D10*', 'G75*', 'X0Y0D02*', 'G03*', 'X2000000Y0I1000000J0D01*', 'G01*', 'X4000000Y0D01*');
  assert.equal(copper.pieces, 1);
  assert.deepEqual(copper.piecesAt([3, 0]), [0]);
  // anticlockwise from the left end of the diameter runs through the bottom
  assert.deepEqual(copper.piecesAt([1, -1]), [0]);
  assert.deepEqual(copper.piecesAt([1, 1]), []);
});

test('an arc inside a region is its chord, as it was', () => {
  const copper = layer('G36*', 'X0Y0D02*', 'G01*', 'X2000000Y0D01*', 'G03*', 'X2000000Y2000000I0J1000000D01*', 'G01*', 'X0Y2000000D01*', 'X0Y0D01*', 'G37*');
  assert.deepEqual(copper.piecesAt([1.9, 1]), [0]);
  assert.deepEqual(copper.piecesAt([2.5, 1]), []);
});

test('a D02 in a region starts another outline', () => {
  assert.equal(layer('G36*', 'X0Y0D02*', 'G01*', 'X1000000Y0D01*', 'X1000000Y1000000D01*', 'X0Y0D01*',
    'X5000000Y0D02*', 'X6000000Y0D01*', 'X6000000Y1000000D01*', 'X5000000Y0D01*', 'G37*').pieces, 2);
});

test('a macro outline turns clockwise and a macro rectangle anticlockwise, the results of gerbonara', () => {
  const outline = ['%AMPoly*', '4,1,3,0,0,2.000000,0,2.000000,0.500000,0,0,$1*%', '%ADD10Poly,90.000000*%', 'D10*', 'X0Y0D03*'];
  assert.deepEqual(layer(...outline).piecesAt([0.2, -1.5]), [0]);
  assert.deepEqual(layer(...outline).piecesAt([-0.2, 1.5]), []);
  const rectangle = ['%AMRect*', '21,1,4.000000,0.200000,0,0,$1*%', '%ADD10Rect,45.000000*%', 'D10*', 'X0Y0D03*'];
  assert.deepEqual(layer(...rectangle).piecesAt([1, 1]), [0]);
  assert.deepEqual(layer(...rectangle).piecesAt([1, -1]), []);
});

test('an exposure-off macro primitive is copper too, as it was', () => {
  assert.deepEqual(layer('%AMOff*', '21,0,1.000000,1.000000,0,0,0*%', '%ADD10Off*%', 'D10*', 'X0Y0D03*').piecesAt([0, 0]), [0]);
});

test('anything the check does not model is refused, so a board cannot pass on it', () => {
  const refused: [string[], RegExp][] = [
    [['%LPC*%'], /clear polarity/],
    [['%LPC*ADD10C,1*%'], /statement not handled/],
    [['%SRX2Y2I1J1*%'], /statement not handled/],
    [['G74*'], /statement not handled/],
    [['%IPNEG*%'], /statement not handled/],
    [['%ADD10P,1X6*%'], /aperture not handled/],
    [['%AMCirc*', '1,1,1,0,0*%'], /primitive not handled/],
    [['%AMCalc*', '21,1,$1x2,1,0,0,0*%'], /expression not handled/],
    [['%AMOpen*', '4,1,3,0,0,1,0,1,1,0,1*%'], /not closed/],
    [['%ADD10O,2X1*%', 'D10*', 'X0Y0D02*', 'X1000000Y0D01*'], /non-circular aperture/],
    [['X0Y0D01*'], /without an aperture/],
    [['D11*'], /undefined aperture/],
    [['G36*', '%ADD10C,1*%', 'D10*', 'X0Y0D03*'], /flash inside a region/],
    [['X1000000Y0*'], /without an operation/],
  ];
  for (const [lines, reason] of refused) assert.throws(() => parseCopper(gerber(...lines)), reason, lines.join(' '));
  assert.throws(() => parseCopper('%MOIN*%\n%FSLAX46Y46*%\n%ADD10C,1*%\n'), /statement not handled/);
  assert.throws(() => parseCopper('%MOMM*%\nX1Y1D03*\n'), /format/);
});

test('coordinates keep the digits of the format, and an omitted one stays', () => {
  const copper = layer('%ADD10C,0.100000*%', 'D10*', 'X-1500000Y2000000D03*', 'X1500000D03*');
  assert.equal(copper.pieces, 2);
  assert.deepEqual(copper.piecesAt([-1.5, 2]), [0]);
  assert.deepEqual(copper.piecesAt([1.5, 2]), [1]);
});

test('drill files give holes and slots, and refuse inches', () => {
  const text = 'M48\nMETRIC\nT1C0.300\nT2C1.000\n%\nT1\nX1.5Y-2.5\nT2\nX0Y0G85X3Y0\nM30\n';
  assert.deepEqual(parseDrill(text), [{ x1: 1.5, y1: -2.5, x2: 1.5, y2: -2.5, diameter: 0.3 }, { x1: 0, y1: 0, x2: 3, y2: 0, diameter: 1 }]);
  assert.throws(() => parseDrill('INCH\n'), /inch drill file not handled/);
});

test('the netlist gives ref.pin to net, with XML entities', () => {
  const xml = '<export><nets><net code="1" name="A&amp;B" class="Default"><node ref="U1" pin="1" pintype="input"/>'
    + '<node ref="R&#49;" pin="2"/></net></nets></export>';
  assert.deepEqual([...parseNetlist(xml).entries()], [['U1\u00001', 'A&B'], ['R1\u00002', 'A&B']]);
});

const pad = (ref: string, x: number, y: number, layers = ['F.Cu']): Pad => ({ ref, pin: '1', x, y, layers });
const nets = (entries: [string, string][]) => new Map(entries.map(([ref, net]) => [`${ref}\u00001`, net]));
const shape = (...points: Xy[]) => new Outline(points);
const strip = (x: number) => shape([x, 0], [x + 1, 0], [x + 1, 1], [x, 1]);

test('the report names opens, shorts and missing copper, in the words of the old tool', () => {
  const top = { name: 'F_Cu', copper: new CopperLayer([strip(0), strip(5)]) };
  const open = check('B', [top], [], [pad('A', 0.5, 0.5), pad('C', 5.5, 0.5)], nets([['A', 'N'], ['C', 'N']]));
  assert.deepEqual(open.lines, ['gerber_netcheck B: 2 pads, 0 plated holes, 1 nets (1 with 2+ pads); OPEN 1, SHORT 0, MISSING 0', '  OPEN N: A.1 | C.1']);
  assert.equal(open.failed, true);
  const short = check('B', [top], [], [pad('A', 0.5, 0.5), pad('C', 0.6, 0.5)], nets([['A', 'N'], ['C', 'M']]));
  assert.deepEqual(short.lines.slice(1), ['  SHORT N (A.1) + M (C.1)']);
  const missing = check('B', [top], [], [pad('A', 3, 3)], nets([]));
  assert.deepEqual(missing.lines.slice(1), ['  MISSING copper under pad A.1 (None)']);
  assert.equal(check('B', [top], [], [pad('A', 0.5, 0.5), pad('C', 0.6, 0.5)], nets([['A', 'N'], ['C', 'N']])).failed, false);
});

test('a plated hole joins the layers it touches, and an unconnected- net is not checked', () => {
  const layers = [{ name: 'F_Cu', copper: new CopperLayer([strip(0)]) }, { name: 'B_Cu', copper: new CopperLayer([strip(0)]) }];
  const pads = [pad('A', 0.5, 0.5), pad('C', 0.5, 0.5, ['B.Cu'])];
  const hole = { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5, diameter: 0.3 };
  assert.equal(check('B', layers, [], pads, nets([['A', 'N'], ['C', 'N']])).failed, true);
  assert.equal(check('B', layers, [hole], pads, nets([['A', 'N'], ['C', 'N']])).failed, false);
  assert.equal(check('B', layers, [hole], pads, nets([['A', 'unconnected-x'], ['C', 'N']])).failed, false);
});
