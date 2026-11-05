// The synthetic functional contract on top of part-fixture.ts, used by the tests and by the native export proof. It installs
// no export or PDF replacement: those boundaries belong to the caller. Not a test file itself.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA as DESIGN_SCHEMA } from './design-contract-load.ts';
import { sha256File } from './json-file.ts';
import { BOARD, FOLDER, makeFixture, writeReviewed } from './part-fixture.ts';
import { Atom, dump, items, parse, type CadList } from './pq-cadlib.ts';
import { textOf } from './py-path.ts';
import { SCHEMA } from './schematic-contract.ts';

type Json = Record<string, any>;
const REQUIREMENTS = ['REQ-VALUE', 'REQ-PINS', 'REQ-POPULATION', 'REQ-MODE', 'REQ-BUDGET'];
const SPEC_NOTE = '\nSynthetic functional fixture: J1 nominal1uF exactly; low mode only.\n'
  + 'The /A rail permits0..0.1A; J1,J2 each require0..0.02A in low mode. These are test facts, not production ratings.\n';

/** The row of `kind` with this reference. */
export function placed(tree: CadList, kind: string, ref: string): CadList {
  const row = items(tree, kind).find(form => items(form, 'property').some(property => property[1] === 'Reference' && property[2] === ref));
  if (!row) throw new Error(`no ${kind} ${ref}`);
  return row;
}

export function changeProperty(path: string, kind: string, ref: string, name: string, value: string): void {
  const tree = parse(textOf(path));
  const row = placed(tree, kind, ref);
  const property = items(row, 'property').find(form => form[1] === name);
  if (property) property[2] = value;
  else {
    const font: CadList = [new Atom('font'), [new Atom('size'), new Atom('1'), new Atom('1')]];
    row.push([new Atom('property'), name, value, [new Atom('at'), new Atom('0'), new Atom('0'), new Atom('0')],
      [new Atom('effects'), font, [new Atom('hide'), new Atom('yes')]]]);
  }
  writeFileSync(path, dump(tree));
}

/** Every source that names `path` follows its current hash. */
function rehash(value: unknown, path: string, sha256: string): void {
  if (Array.isArray(value)) value.forEach(child => rehash(child, path, sha256));
  else if (value !== null && typeof value === 'object') {
    const row = value as Json;
    if (row.path === path) row.sha256 = sha256;
    Object.values(row).forEach(child => rehash(child, path, sha256));
  }
}

export interface FunctionalFixture {
  root: string;
  board: string;
  folder: string;
  schematic: string;
  pcb: string;
  spec: string;
  partManifest: string;
  designPath: string;
  contract: string;
  source: Json;
  value: Json;
  bound: (path: string) => Json;
  interval: (min: number, max: number, unit: string) => Json;
  /** Writes the contract; with `review`, its review follows the facts. */
  save: (review?: boolean) => void;
}

export function makeFunctionalFixture(root: string): FunctionalFixture {
  const partManifest = makeFixture(root);
  const folder = join(root, FOLDER);
  const schematic = join(folder, 'fixture.kicad_sch');
  const pcb = join(folder, 'fixture.kicad_pcb');
  changeProperty(schematic, 'symbol', 'J1', 'Value', '1uF');
  changeProperty(pcb, 'footprint', 'J1', 'Value', '1uF');
  changeProperty(schematic, 'symbol', 'J1', 'Operating_Mode', 'low');
  const spec = join(folder, 'SPEC.md');
  appendFileSync(spec, SPEC_NOTE);
  const relative = (path: string) => path.slice(root.length + 1);
  const parts = JSON.parse(textOf(partManifest));
  rehash(parts, relative(spec), sha256File(spec));
  writeReviewed(partManifest, parts);
  const source: Json = { path: relative(spec), sha256: sha256File(spec), section: 'Synthetic functional fixture' };
  const contract = join(folder, 'schematic-functional.json');
  const designPath = join(folder, 'design-contract.json');
  writeFileSync(designPath, JSON.stringify({
    schema: DESIGN_SCHEMA, identity: { design_id: BOARD, board: BOARD, revision: 'synthetic-1' }, current_stage: 'schematic', architecture: null,
    test_plans: [], failure_conditions: [], unknowns: [], production: {},
    requirements: REQUIREMENTS.map(id => ({
      id, statement: `Synthetic fixture assertion ${id}`, source, verification_stage: 'schematic',
      acceptance: { kind: 'review', criterion: 'exact native fixture assertion', source },
    })),
    checks: [{ id: 'CHECK-FUNCTION', kind: 'schematic', stage: 'schematic', path: relative(contract), requirements: REQUIREMENTS }],
  }));
  const bound = (path: string) => ({ path: relative(path), sha256: sha256File(path) });
  const interval = (min: number, max: number, unit: string) => ({ min, max, unit, source: structuredClone(source) });
  const low = [{ mode: 'MODE', value: 'low' }];
  const value: Json = {
    schema: SCHEMA, board: BOARD, project: `${FOLDER}/fixture`, design_contract: bound(designPath), part_review: bound(partManifest),
    population_source: { path: `${FOLDER}/variants.json`, exists: false, sha256: null },
    assertions: [
      { id: 'NOMINAL', kind: 'value', requirement: 'REQ-VALUE', source, reference: 'J1', mpn: 'SYNTHETIC-TP', expected: interval(1, 1, 'uF'), conditions: low },
      { id: 'PIN', kind: 'pin_net', requirement: 'REQ-PINS', source, reference: 'J1', pin: '1', pin_name: 'P', net: '/A' },
      { id: 'FIT', kind: 'population', requirement: 'REQ-POPULATION', source, reference: 'J2', dnp: false, in_bom: true, fits: ['DEFAULT'] },
      { id: 'MODE', kind: 'mode', requirement: 'REQ-MODE', source, reference: 'J1', field: 'Operating_Mode', allowed: ['low'], variant: 'DEFAULT' },
      {
        id: 'RAIL', kind: 'budget', requirement: 'REQ-BUDGET', source, net: '/A', variant: 'DEFAULT', limit: interval(0, 0.1, 'A'),
        loads: ['J1', 'J2'].map(reference => ({ reference, demand: interval(0, 20, 'mA'), reviewed_demand: { budget: 'rail' }, conditions: low })),
        exclusions: [], conditions: low,
      },
    ],
  };
  const save = (review = true) => {
    if (review) {
      value.review = { verdict: 'passed', reviewer: 'synthetic independent test reviewer', reviewed_at_utc: '2026-10-16T00:00:00Z', facts_sha256: '', evidence: structuredClone(source) };
      writeReviewed(contract, value as never);
    } else writeFileSync(contract, JSON.stringify(value));
  };
  save();
  return { root, board: BOARD, folder, schematic, pcb, spec, partManifest, designPath, contract, source, value, bound, interval, save };
}
