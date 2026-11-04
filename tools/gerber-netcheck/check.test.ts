import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { cacheKey, BOARD_JSON_SCHEMA, pinnedKicadCommit } from '../lib/board-json.ts';
import type { BoardDocument } from '../lib/board-types.ts';
import { sha256File } from '../lib/json-file.ts';
import { zipArchive } from '../lib/zip-write.ts';
import { boardPads, checkInput, expectedNets, reportLines } from './check.ts';
import { checkConnectivity } from './native.ts';
import { excellonHoles, layerGeometry } from './parse.ts';
import type { CheckInput, Draw } from './types.ts';

const ENGINE = fileURLToPath(new URL('../router/core/target/debug/gerber_netcheck', import.meta.url));
const CLI = fileURLToPath(new URL('../gerber_netcheck.ts', import.meta.url));
const XML = '<export><nets><net code="1" name="N&amp;1"><node ref="J1" pin="1"/><node ref="J2" pin="1"/></net></nets></export>';
const DRILL = 'M48\n;KiCad metric decimal\nFMAT,2\nMETRIC\nT1C0.300\n%\nG90\nG05\nM30\n';
const gerber = (body: string, defs = '%ADD10C,0.5*%'): string =>
  `G04 fixture*\n%FSLAX24Y24*%\n%MOMM*%\nG01*\nG75*\n%LPD*%\n${defs}\nD10*\n${body}\nM02*\n`;

function document(): BoardDocument {
  return {
    schema: BOARD_JSON_SCHEMA, kicad_commit: pinnedKicadCommit(), kicad: 'fixture', board_sha256: '', project_sha256: '', rules_sha256: '',
    board: {
      path: 'fixture', copper_layers: ['F.Cu', 'B.Cu'], stackup: [], nets: {}, copper: [], zones: [], graphics: [], outlines: [],
      edges_bbox: { left: 0, top: 0, right: 10_000_000, bottom: 2_000_000 },
      footprints: [1, 9].map((x, i) => ({
        id: `fp${i}`, reference: `J${i + 1}`, value: 'fixture', lib_id: '', layer: 'F.Cu', position: { x: 0, y: 0 }, orientation: 0,
        locked: false, fields: [], graphics: [], zones: [], courtyard_front: [], courtyard_back: [],
        pads: [{
          id: `pad${i}`, number: '1', kind: 'Smd', shape: 'Circle', net: 'BOARD_NET_IS_IGNORED', position: { x: x * 1_000_000, y: -1_000_000 },
          orientation: 0, size: { x: 500_000, y: 500_000 }, drill: { x: 0, y: 0 }, layers: ['F.Cu', 'F.Mask', 'F.Paste'],
          bbox: { left: 0, top: 0, right: 0, bottom: 0 }, zone_connection: null, thermal_spoke_angle: 45, spoke_templates: 0,
          copper: [], polygons: {}, solder_mask_expansion: 0,
        }],
      })),
    },
  };
}

function check(operations: Draw[], points: [number, number][]): ReturnType<typeof checkConnectivity> {
  const input: CheckInput = { layers: [{ name: 'F.Cu', operations }], holes: [],
    pads: points.map(([x, y], i) => ({ ref: `P${i}`, pin: '1', x, y, layers: ['F.Cu'], net: 'N' })) };
  return checkConnectivity(input, ENGINE);
}

test('Gerber strokes and X2 attributes produce the same copper and ignore net labels', async () => {
  const body = 'X010000Y010000D02*\nX090000Y010000D01*';
  const plain = await layerGeometry(gerber(body));
  const attrs = await layerGeometry(gerber(`%TO.N,WRONG_NET*%\n%TA.AperFunction,ViaPad*%\n${body}\n%TD*%`));
  assert.deepEqual(attrs, plain);
  const report = check(plain, [[1, 1], [9, 1]]);
  assert.deepEqual(report.opens, {});
  assert.equal(report.nets_checked, 1);
  assert.equal(report.layers[0].pieces, 1);
});

test('layer clear polarity cuts previous copper and a later dark stroke reconnects it', async () => {
  const base = 'X010000Y010000D02*X090000Y010000D01*\n%LPC*%\nD11*\nX050000Y010000D03*';
  const defs = '%ADD10C,0.5*%\n%ADD11C,1.0*%';
  const open = check(await layerGeometry(gerber(base, defs)), [[1, 1], [9, 1]]);
  assert.equal(Object.keys(open.opens).length, 1);
  const restored = check(await layerGeometry(gerber(`${base}\n%LPD*%\nD10*\nX010000Y010000D02*X090000Y010000D01*`, defs)), [[1, 1], [9, 1]]);
  assert.deepEqual(restored.opens, {});
});

test('aperture holes and macro clear primitives belong to the aperture', async () => {
  const macro = '%AMRING*1,1,1,0,0*1,0,0.4,0,0*%\n%ADD10RING*%';
  const ring = check(await layerGeometry(gerber('X050000Y010000D03*', macro)), [[5, 1], [5.4, 1]]);
  assert.deepEqual(ring.missing, ['P0.1 (N)']);
  const defs = '%ADD10C,0.5*%\n%ADD11C,1.0X0.4*%';
  const report = check(await layerGeometry(gerber('X010000Y010000D02*X090000Y010000D01*\nD11*\nX050000Y010000D03*', defs)), [[5, 1]]);
  assert.deepEqual(report.missing, []);
});

test('region contours, circular arcs and step repeats become copper', async () => {
  const region = gerber('G36*\nX000000Y000000D02*X020000Y000000D01*X020000Y020000D01*X000000Y020000D01*X000000Y000000D01*\nG37*');
  assert.deepEqual(check(await layerGeometry(region), [[1, 1]]).missing, []);
  const arc = gerber('X000000Y000000D02*\nG03X010000Y010000I000000J010000D01*');
  assert.deepEqual(check(await layerGeometry(arc), [[0, 0], [1, 1]]).missing, []);
  const repeat = gerber('%SRX2Y1I2.0J0.0*%\nX010000Y010000D03*\n%SR*%');
  assert.deepEqual(check(await layerGeometry(repeat), [[1, 1], [3, 1]]).missing, []);
});

test('inch Gerbers are scaled to millimetres', async () => {
  const source = gerber('X010000Y010000D03*').replace('%MOMM*%', '%MOIN*%');
  assert.deepEqual(check(await layerGeometry(source), [[25.4, 25.4]]).missing, []);
});

test('rectangle and obround aperture flashes keep their extents', async () => {
  const defs = '%ADD10R,2.0X1.0*%\n%ADD11O,2.0X1.0*%';
  const source = gerber('X020000Y010000D03*\nD11*\nX060000Y010000D03*', defs);
  const report = check(await layerGeometry(source), [[1.1, 1.4], [2.9, 1.4], [5.1, 1], [6.9, 1], [6, 1.6]]);
  assert.deepEqual(report.missing, ['P4.1 (N)']);
  assert.equal(report.layers[0].pieces, 2);
});

test('invalid Gerbers and missing tools fail without silently dropping copper', async () => {
  await assert.rejects(layerGeometry('garbage'), /explicit coordinate/);
  await assert.rejects(layerGeometry(gerber('D99*\nX010000Y010000D03*')), /not defined|unknown tool/);
});

test('metric decimal Excellon holes and G85 slots retain coordinates and diameters', () => {
  assert.deepEqual(excellonHoles(DRILL.replace('M30', 'T1\nX1.0Y-2.0\nX3.0Y4.0G85X5.0Y6.0\nM30')), [
    { start: [1, -2], end: [1, -2], diameter: 0.3 }, { start: [3, 4], end: [5, 6], diameter: 0.3 },
  ]);
  assert.throws(() => excellonHoles(DRILL.replace('METRIC', 'INCH')), /inch/);
  assert.throws(() => excellonHoles(DRILL.replace('M30', 'T99\nM30')), /undefined drill tool/);
  assert.throws(() => excellonHoles(DRILL.replace('M30', 'T1\nX001Y002\nM30')), /decimal/);
});

test('board JSON supplies nm positions and copper layers; schematic supplies expected nets', () => {
  const pads = boardPads(document(), expectedNets(XML));
  assert.deepEqual(pads.map(p => [p.ref, p.x, p.y, p.layers, p.net]), [
    ['J1', 1, 1, ['F.Cu'], 'N&1'], ['J2', 9, 1, ['F.Cu'], 'N&1'],
  ]);
  assert.throws(() => expectedNets('<export><net><node ref="A"/></net></export>'), /no name/);
});

test('ZIP input goes through parser and native connectivity, with legacy report text', async () => {
  const zip = zipArchive([
    { name: 'ENV-SENSE-F_Cu.gbr', data: Buffer.from(gerber('X010000Y010000D02*X090000Y010000D01*')) },
    { name: 'ENV-SENSE-PTH.drl', data: Buffer.from(DRILL) },
  ]);
  const input = await checkInput(zip, 'ENV-SENSE', document(), XML);
  const report = checkConnectivity(input, ENGINE);
  assert.deepEqual(reportLines('ENV-SENSE', report), [
    'F_Cu: 1 copper pieces',
    'gerber_netcheck ENV-SENSE: 2 pads, 0 plated holes, 1 nets (1 with 2+ pads); OPEN 0, SHORT 0, MISSING 0',
  ]);
  await assert.rejects(checkInput(zipArchive([{ name: '../outside.gbr', data: Buffer.from('x') }]), 'ENV-SENSE', document(), XML), /no copper layers/);
});

test('CLI exports schematic XML, reads a cached board document and leaves input bytes intact', t => {
  const root = mkdtempSync(join(tmpdir(), 'gerber-netcheck-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bd = join(root, 'hardware-design/boards/ENV-SENSE');
  const stem = join(bd, 'cad/ENV-SENSE/ENV-SENSE');
  mkdirSync(dirname(stem), { recursive: true });
  writeFileSync(join(bd, 'gate.json'), JSON.stringify({ project: 'cad/ENV-SENSE/ENV-SENSE' }));
  writeFileSync(`${stem}.kicad_pcb`, '(kicad_pcb)');
  writeFileSync(`${stem}.kicad_pro`, '{}');
  writeFileSync(`${stem}.kicad_sch`, '(kicad_sch)');
  const cache = join(root, 'cache/pcb-toolchain/board-json');
  mkdirSync(cache, { recursive: true });
  const doc = document();
  doc.board_sha256 = sha256File(`${stem}.kicad_pcb`);
  writeFileSync(join(cache, `${cacheKey(`${stem}.kicad_pcb`, BOARD_JSON_SCHEMA, pinnedKicadCommit())}.json`), JSON.stringify(doc));
  const zip = join(root, 'fab.zip');
  writeFileSync(zip, zipArchive([
    { name: 'ENV-SENSE-F_Cu.gbr', data: Buffer.from(gerber('X010000Y010000D02*X090000Y010000D01*')) },
    { name: 'ENV-SENSE-PTH.drl', data: Buffer.from(DRILL) },
  ]));
  const xml = join(root, 'fixture.xml'); writeFileSync(xml, XML);
  const cli = join(root, 'kicad-cli');
  writeFileSync(cli, '#!/bin/sh\n[ "$1 $2 $3" = "sch export netlist" ] || exit 90\nwhile [ "$1" != "-o" ]; do shift; done\nshift\ncp "$GNC_FIXTURE_XML" "$1"\n');
  chmodSync(cli, 0o755);
  const before = readFileSync(`${stem}.kicad_pcb`);
  const run = spawnSync(process.execPath, [CLI, 'ENV-SENSE', '--root', root], { encoding: 'utf8',
    env: { ...process.env, KICAD_CLI: cli, XDG_CACHE_HOME: join(root, 'cache'), GNC_NATIVE: ENGINE, GNC_ZIP: zip, GNC_FIXTURE_XML: xml } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /OPEN 0, SHORT 0, MISSING 0/);
  assert.deepEqual(readFileSync(`${stem}.kicad_pcb`), before);
});
