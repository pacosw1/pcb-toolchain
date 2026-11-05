// A synthetic reviewed board for tests: four one-pad test points, a real one-page PDF that says what it is, and a passing
// part-use manifest. Everything is labeled synthetic; nothing here is a manufacturer document. Not a test file itself.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256File } from './json-file.ts';
import { readBoard } from './part-native.ts';
import { factsDigest, MANIFEST } from './part-review.ts';
import { Atom, dump, items, parse, type CadList } from './pq-cadlib.ts';
import { jsonLoads } from './py-compat.mjs';
import type { Dict } from './py-dict.ts';
import { textOf } from './py-path.ts';

const URL_NAMESPACE = '6ba7b8119dad11d180b400c04fd430c8';
export const BOARD = 'PART-FIXTURE';
export const FOLDER = `hardware-design/boards/${BOARD}`;

/** uuid5 of the URL namespace: stable fixture identities. */
export function uid(name: string): string {
  const hash = createHash('sha1').update(Buffer.from(URL_NAMESPACE, 'hex')).update(`iot-lab-native-smoke:${name}`).digest();
  hash[6] = (hash[6] as number & 0x0f) | 0x50;
  hash[8] = (hash[8] as number & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Embedded one-pin passive symbols with explicit native instance identities. */
export function schematic(): string {
  const symbol = `(symbol "Smoke:TP" (in_bom yes) (on_board yes)
      (property "Reference" "J" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
      (property "Value" "TP" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "Smoke:TP" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (symbol "TP_0_1" (rectangle (start 0 -1) (end 2 1)
       (stroke (width 0) (type default)) (fill (type background))))
      (symbol "TP_1_1" (pin passive line (at 0 0 0) (length 2.54)
       (name "P" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))`;
  const rows = [`(kicad_sch (version 20250114) (generator "eeschema") (uuid "${uid('root')}") (paper "A4")`, `(lib_symbols ${symbol})`];
  for (let index = 0; index < 4; index++) {
    const ref = `J${index + 1}`;
    const net = index < 2 ? 'A' : 'B';
    const x = 50.8 + (index % 2) * 25.4;
    const y = 50.8 + Math.floor(index / 2) * 25.4;
    rows.push(`(symbol (lib_id "Smoke:TP") (at ${x} ${y} 0) (unit 1)
          (in_bom yes) (on_board yes) (dnp no) (uuid "${uid(ref)}")
          (property "Reference" "${ref}" (at ${x} ${y - 3} 0) (effects (font (size 1.27 1.27))))
          (property "Value" "TP" (at ${x} ${y + 3} 0) (effects (font (size 1.27 1.27))))
          (property "Footprint" "Smoke:TP" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (hide yes)))
          (pin "1" (uuid "${uid(`${ref}-pin`)}"))
          (instances (project "fixture" (path "/${uid('root')}" (reference "${ref}") (unit 1)))))`,
    `(label "${net}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${uid(`${ref}-label`)}"))`);
  }
  rows.push('(embedded_fonts no))');
  return rows.join('\n');
}

function pcb(): string {
  const forms = ['(kicad_pcb (version 20250114) (generator "pcbnew") (general (thickness 1.6))',
    '(layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 1 "/A") (net 2 "/B")'];
  for (let index = 0; index < 4; index++) {
    const ref = `J${index + 1}`;
    const net = index < 2 ? '/A' : '/B';
    forms.push(`(footprint "Smoke:TP" (layer "F.Cu") (at ${5 + (index % 2) * 10} ${5 + Math.floor(index / 2) * 10} 0)
              (property "Reference" "${ref}") (property "Value" "TP") (path "/${uid(ref)}")
              (pad "1" smd rect (at 0 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask")
                (net ${net === '/A' ? 1 : 2} "${net}")))`);
  }
  forms.push(')');
  return forms.join('\n');
}

/** A real one-page PDF with clearly labeled synthetic test limits. */
export function syntheticPdf(path: string): void {
  const content = Buffer.from('BT /F1 12 Tf 40 700 Td (SYNTHETIC TEST FIXTURE - NOT A MANUFACTURER DATASHEET) Tj '
    + '0 -20 Td (TP: 0 to 5 V; net current budget: 0.1 A.) Tj 0 -20 Td (Applicable ambient temperature: -40 to 85 degC.) Tj '
    + '0 -20 Td (J1.1 to J2.1 pad-center distance: maximum 11 mm.) Tj ET');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content.toString()}\nendstream`];
  let data = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(data.length);
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = data.length;
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  data += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** The MPN and LCSC fields a placed symbol or footprint needs. */
function addIdentity(path: string, kind: string): void {
  const tree = parse(textOf(path));
  for (const placed of items(tree, kind)) {
    const reference = items(placed, 'property').find(row => row[1] === 'Reference');
    if (!reference) continue;
    const ref = reference[2] as string;
    for (const [name, value] of [['MPN', 'SYNTHETIC-TP'], ['LCSC', `C90000${ref.slice(1)}`]] as const) {
      const at: CadList = [new Atom('at'), new Atom('0'), new Atom('0'), new Atom('0')];
      const font: CadList = [new Atom('font'), [new Atom('size'), new Atom('1'), new Atom('1')]];
      placed.push([new Atom('property'), name, value, at, [new Atom('effects'), font, [new Atom('hide'), new Atom('yes')]]]);
    }
  }
  writeFileSync(path, `${dump(tree)}\n`);
}

/** Puts `value` on disk with its review bound to its facts. */
export function writeReviewed(path: string, value: { review: { facts_sha256: string } }): void {
  value.review.facts_sha256 = factsDigest(jsonLoads(JSON.stringify(value)) as Dict);
  writeFileSync(path, JSON.stringify(value));
}

/** A fake pdfinfo: tests do not depend on Poppler, and the review only asks for the page count. */
export function fakePdfinfo(folder: string, pages = 1): string {
  const path = join(folder, 'fixture-pdfinfo');
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "-v" ]; then echo 'fixture pdfinfo 1'; else echo 'Pages: ${pages}'; fi\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Writes the board and returns the path of its passing manifest. */
export function makeFixture(root: string): string {
  const folder = join(root, FOLDER);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'gate.json'), '{"project":"fixture","checks":{"erc":true,"drc":true}}\n');
  writeFileSync(join(folder, 'fixture.kicad_sch'), schematic());
  writeFileSync(join(folder, 'fixture.kicad_pcb'), pcb());
  addIdentity(join(folder, 'fixture.kicad_sch'), 'symbol');
  addIdentity(join(folder, 'fixture.kicad_pcb'), 'footprint');
  writeFileSync(join(folder, 'SPEC.md'), 'Synthetic fixture only. Required 3.0 to 3.6 V, 20 to 30 degC, 0.02 A per TP.\n');
  const reviews = join(root, 'hardware-design/registry/part-reviews');
  mkdirSync(reviews, { recursive: true });
  const reviewDocument = join(reviews, 'SYNTHETIC-REVIEW.md');
  writeFileSync(reviewDocument, 'Synthetic test review only. No manufacturer or production qualification. All TP pin/pad maps and fixture conditions checked.\n');
  const pdf = join(root, 'hardware-design/registry/datasheets/SYNTHETIC-TP.pdf');
  syntheticPdf(pdf);
  const source = (path: string, extra: object) => ({ path: path.slice(root.length + 1), sha256: sha256File(path), ...extra });
  const pdfSource = source(pdf, { page: 1 });
  const specSource = source(join(folder, 'SPEC.md'), { section: 'Synthetic fixture conditions' });
  const range = (min: number, max: number, unit: string, from: object) => ({ min, max, unit, source: { ...from } });
  const snapshot = readBoard(root, BOARD);
  const parts: Record<string, any>[] = [...snapshot.parts].map(([reference, actual]) => ({
    reference, mpn: actual.mpn, lcsc: actual.lcsc, manufacturer: 'Synthetic fixture',
    package: { name: 'Synthetic one-pad TP', variant: 'SYNTHETIC-TP' },
    datasheets: [{ ...pdfSource, document_id: 'SYNTHETIC TEST FIXTURE', revision: '1' }],
    native: {
      symbol_sha256: actual.symbol_sha256, pin_map: Object.fromEntries(actual.pin_map), footprint: actual.footprint, footprint_sha256: actual.footprint_sha256,
      land_geometry_sha256: actual.land_geometry_sha256, pad_net_map: Object.fromEntries(actual.pad_net_map), non_electrical_pads: [],
    },
    ratings: [{
      id: 'supply', quantity: 'voltage', limit: range(0, 5, 'V', pdfSource), required: range(3.0, 3.6, 'V', specSource),
      conditions: [{ quantity: 'ambient_temperature', valid: range(-40, 85, 'degC', pdfSource), required: range(20, 30, 'degC', specSource) }],
    }],
    layout_constraints: [], assembly_dependencies: [], unresolved: [],
  }));
  (parts[0] as Record<string, any>).layout_constraints = [{
    id: 'fixture-distance', kind: 'pin_distance', source: pdfSource, a: { ref: 'J1', pad: '1' }, b: { ref: 'J2', pad: '1' }, metric: 'pad_center_euclidean', max_mm: 11,
  }];
  const manifest = {
    schema: MANIFEST, board: BOARD, revision: 'synthetic-1', project: snapshot.project, spec: specSource, parts,
    budgets: [{ id: 'rail', net: '/A', limit: range(0, 0.1, 'A', pdfSource), loads: ['J1', 'J2'].map(reference => ({ reference, required: range(0, 0.02, 'A', specSource) })), exclusions: [] }],
    review: {
      verdict: 'passed', reviewer: 'synthetic-test-fixture', reviewed_at_utc: '2026-10-16T00:00:00Z', facts_sha256: '',
      evidence: source(reviewDocument, { section: 'Synthetic test review' }),
    },
  };
  const path = join(reviews, `${BOARD}.json`);
  writeReviewed(path, manifest);
  return path;
}
