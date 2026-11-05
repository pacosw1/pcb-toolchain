import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveBoard } from './board-edit.ts';
import { kicadCli } from './env.mjs';
import { copperNames, derivedDielectrics, explicitDielectrics, stackupText, withStackup } from '../set_stackup.ts';

const SIX = ['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu'];

test('explicit dielectrics alternate prepreg and core from the outside (JLC06161H-7628, D-142)', () => {
  const thicknesses = [0.2104, 0.4, 0.2028, 0.4, 0.2104];
  const dielectrics = explicitDielectrics(thicknesses, SIX.length);
  assert.deepEqual(dielectrics.map(gap => gap.thickness), thicknesses);
  assert.deepEqual(dielectrics.map(gap => gap.kind), ['prepreg', 'core', 'prepreg', 'core', 'prepreg']);
  const all = [...stackupText(SIX, dielectrics).matchAll(/\(thickness ([\d.]+)\)/g)].map(match => match[1]);
  assert.deepEqual(all.slice(1, 12).filter((_, i) => i % 2 === 0), ['0.035', '0.0152', '0.0152', '0.0152', '0.0152', '0.035']);
  const total = thicknesses.reduce((sum, thickness) => sum + thickness, 0) + 2 * 0.035 + 4 * 0.0152 + 0.02;
  assert.ok(Math.abs(total - 1.5744) < 1e-4); // D-142 dielectrics, copper and mask; nominal 1.6 mm board
});

test('a dielectric count that does not fit the copper layers fails', () => {
  assert.throws(() => explicitDielectrics([0.2, 0.4], SIX.length), /2 dielectrics for 6 copper layers/);
});

test('the default four-layer build has outer prepreg and one inner core', () => {
  const dielectrics = derivedDielectrics(4, 0.2104, 1.6);
  assert.deepEqual(dielectrics.map(gap => gap.kind), ['prepreg', 'core', 'prepreg']);
  assert.equal(dielectrics[1]!.thickness, 1.0588);
});

test('a two-layer board is one core', () => {
  assert.deepEqual(derivedDielectrics(2, 0.2104, 1.6).map(gap => [gap.kind, gap.thickness]), [['core', 1.51]]);
});

test('copper names come from the layers list, top to bottom', () => {
  const board = '(kicad_pcb\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t\t(6 "In2.Cu" power)\n'
    + '\t\t(4 "In1.Cu" mixed)\n\t\t(9 "F.Adhes" user "F.Adhesive")\n\t)\n)\n';
  assert.deepEqual(copperNames(board), ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
});

test('withStackup adds a missing stackup as the first child of the setup', () => {
  const added = withStackup('(kicad_pcb\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n)\n', '\t\t(stackup\n\t\t)');
  assert.equal(added, '(kicad_pcb\n\t(setup\n\t\t(stackup\n\t\t)\n\t\t(pad_to_mask_clearance 0)\n\t)\n)\n');
});

test('withStackup replaces an old stackup, quoted parentheses included', () => {
  const board = '(kicad_pcb\n\t(setup\n\t\t(stackup\n\t\t\t(layer "F.Cu"\n\t\t\t\t(type "a) b")\n\t\t\t)\n\t\t)\n\t\t(pad_to_mask_clearance 0)\n\t)\n)\n';
  const done = withStackup(board, '\t\t(stackup\n\t\t\t(copper_finish "ENIG")\n\t\t)');
  assert.equal(done, '(kicad_pcb\n\t(setup\n\t\t(stackup\n\t\t\t(copper_finish "ENIG")\n\t\t)\n\t\t(pad_to_mask_clearance 0)\n\t)\n)\n');
  assert.equal(withStackup(done, '\t\t(stackup\n\t\t)').match(/\(stackup/g)?.length, 1);
});

// A real KiCad 10 save: KiCad keeps the last block of two, which is how the values used to be lost. Needs kicad-cli.
const REAL_BOARD = `(kicad_pcb
\t(version 20260206)
\t(generator "pcbnew")
\t(generator_version "10.0")
\t(general
\t\t(thickness 1.6)
\t\t(legacy_teardrops no)
\t)
\t(paper "A4")
\t(layers
\t\t(0 "F.Cu" signal)
\t\t(2 "B.Cu" signal)
\t\t(25 "Edge.Cuts" user)
\t)
\t(setup
\t\t(stackup
\t\t\t(layer "F.Cu"
\t\t\t\t(type "copper")
\t\t\t\t(thickness 0.035)
\t\t\t)
\t\t\t(layer "dielectric 1"
\t\t\t\t(type "core")
\t\t\t\t(thickness 1.51)
\t\t\t\t(material "FR4")
\t\t\t\t(epsilon_r 4.5)
\t\t\t\t(loss_tangent 0.02)
\t\t\t)
\t\t\t(layer "B.Cu"
\t\t\t\t(type "copper")
\t\t\t\t(thickness 0.035)
\t\t\t)
\t\t)
\t\t(pad_to_mask_clearance 0)
\t)
\t(net 0 "")
)
`;

test('a board with a stackup keeps the new values through a KiCad 10 save', { skip: !existsSync(kicadCli) && 'needs kicad-cli' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'set-stackup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'X.kicad_pcb');
  const edited = withStackup(REAL_BOARD, stackupText(['F.Cu', 'B.Cu'], explicitDielectrics([0.8], 2)));
  writeFileSync(source, edited);
  writeFileSync(join(dir, 'X.kicad_pro'), '{}');
  const report = saveBoard(source, edited, join(dir, 'out'));
  const saved = readFileSync(report.board, 'utf8');
  assert.match(saved, /\(thickness 0\.8\)/);
  assert.doesNotMatch(saved, /\(thickness 1\.51\)/);
});
