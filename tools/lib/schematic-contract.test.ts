// Functional mutations use the real native identity and review readers on isolated CAD. The export is replaced by a small
// reader of current placed values, fields and attached labels, independent of the contract; these tests make no
// native-runtime claim. PDF pages come from a fake pdfinfo: the synthetic PDF has one page.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Decimal } from './decimal.ts';
import { sha256File } from './json-file.ts';
import { fakePdfinfo, writeReviewed } from './part-fixture.ts';
import { Atom, dump, item, items, parse, type CadList } from './pq-cadlib.ts';
import { Float } from './py-compat.mjs';
import { canonicalValue, checkContract, checkNativeIdentity, dependencyFiles, number, parseExport, RESULT, type Exporter, type SchematicReport } from './schematic-contract.ts';
import { changeProperty, makeFunctionalFixture, placed, type FunctionalFixture } from './schematic-fixture.ts';

type Json = Record<string, any>;
const d = (text: string) => Decimal.of(text);
const jsonFile = (path: string): Json => JSON.parse(readFileSync(path, 'utf8'));
const esc = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

describe('native export identity', () => {
  const part = (fields: Record<string, unknown>) => new Map([['TP1', { mpn: '', pin_map: new Map(), pad_net_map: new Map(), ...fields }]]) as never;
  const exported = (value: string, fields: Record<string, string> = {}) => ({
    comps: new Map([['TP1', fields.MPN || value]]), fields: new Map([['TP1', new Map(Object.entries(fields))]]), pins: new Map(),
  }) as never;
  const free = { identity_free: { basis: 'single_bare_copper_pad_outside_bom_and_placement' } };

  test('an identity-free pad may export its net name as the value', () => {
    assert.doesNotThrow(() => checkNativeIdentity(part(free), exported('USB_VBUS')));
  });

  test('a part with no proof, a real MPN or a missing export row still differs', () => {
    assert.throws(() => checkNativeIdentity(part({}), exported('USB_VBUS')), /native export part identity differs: TP1/);
    assert.throws(() => checkNativeIdentity(part(free), exported('USB_VBUS', { MPN: 'PART' })), /native export part identity differs: TP1/);
    assert.throws(() => checkNativeIdentity(part(free), exported('USB_VBUS', { LCSC: 'C1' })), /native export part identity differs: TP1/);
    assert.throws(() => checkNativeIdentity(part(free), { comps: new Map(), fields: new Map(), pins: new Map() } as never), /native export part identity differs: TP1/);
  });
});

describe('quantities', () => {
  test('equivalent units and resistor notation are exact', () => {
    for (const text of ['1uF', '1000nF', '0.001mF', '1µF']) {
      const [value, unit] = canonicalValue(text, 'F');
      assert.ok(value.equals(d('0.000001')), text);
      assert.equal(unit, 'F');
    }
    for (const text of ['4k7', '4.7kOhm', '4700Ohm', '4700Ω']) assert.ok(canonicalValue(text, 'Ohm')[0].equals(d('4700')), text);
    assert.ok(canonicalValue('4R7', 'Ohm')[0].equals(d('4.7')));
    for (const text of ['1W', 'nan', '1bogus']) assert.throws(() => canonicalValue(text, 'F'));
    for (const value of [true, false, new Float(NaN), new Float(Infinity)]) assert.throws(() => number(value));
  });

  test('a product keeps the exponent Python gives it', () => {
    assert.equal(String(canonicalValue('10uF', 'F')[0]), '0.000010');
    assert.equal(String(canonicalValue('1uF', 'F')[0]), '0.000001');
    assert.equal(String(number(new Float(1e-6))), '0.000001');
    assert.equal(String(number(12n)), '12');
  });
});

describe('schematic contract', () => {
  let root: string;
  let fx: FunctionalFixture;
  let exports = 0;
  let sequence = 0;
  let afterExport: () => void;

  const fixtureExport: Exporter = async (schematic, artifacts) => {
    exports += 1;
    const tree = parse(readFileSync(schematic, 'utf8'));
    const at = (row: CadList) => (item(row, 'at') as CadList).slice(1, 3).map(atom => (atom as Atom).text ?? atom).join(',');
    const labels = new Map(items(tree, 'label').map(row => [at(row), row[1] as string]));
    const comps: string[] = [];
    const grouped = new Map<string, string[]>();
    for (const row of items(tree, 'symbol')) {
      const fields = new Map(items(row, 'property').map(property => [property[1] as string, property[2] as string]));
      const ref = fields.get('Reference') as string;
      const cells = [...fields].map(([name, value]) => `<field name="${esc(name)}">${esc(value)}</field>`).join('');
      comps.push(`<comp ref="${ref}"><value>${esc(fields.get('Value') as string)}</value><fields>${cells}</fields></comp>`);
      const net = `/${labels.get(at(row))}`;
      grouped.set(net, [...(grouped.get(net) ?? []), ref]);
    }
    const nets = [...grouped].map(([net, refs]) => `<net name="${net}">${refs.map(ref => `<node ref="${ref}" pin="1" pinfunction="P"/>`).join('')}</net>`);
    const raw = `<export><components>${comps.join('')}</components><nets>${nets.join('')}</nets></export>`;
    const path = join(artifacts, 'native-netlist.xml');
    writeFileSync(path, raw);
    const parsed = parseExport(raw);
    afterExport();
    return { parsed, evidence: { [path]: sha256File(path) }, tools: {} };
  };

  const check = (): Promise<SchematicReport> => {
    sequence += 1;
    return checkContract(root, fx.board, fx.contract, join(root, `report-${sequence}.json`), fixtureExport);
  };
  const requirement = (report: SchematicReport, id: string) => report.requirement_results[id]?.status;
  const rail = (report: SchematicReport) => report.assertions.find(row => row.id === 'RAIL') as Json;
  const causes = (report: SchematicReport) => report.assertions.map(row => row.cause ?? '');
  const budgetRow = () => fx.value.assertions.at(-1);
  const setValue = (value: string) => {
    changeProperty(fx.schematic, 'symbol', 'J1', 'Value', value);
    changeProperty(fx.pcb, 'footprint', 'J1', 'Value', value);
  };
  /** Edits the part review and rebinds the contract to it. */
  const editParts = (mutate: (parts: Json) => void) => {
    const parts = jsonFile(fx.partManifest);
    mutate(parts);
    writeReviewed(fx.partManifest, parts as never);
    fx.value.part_review = fx.bound(fx.partManifest);
  };
  const editDesign = (mutate: (design: Json) => void) => {
    const design = jsonFile(fx.designPath);
    mutate(design);
    writeFileSync(fx.designPath, JSON.stringify(design));
    fx.value.design_contract = fx.bound(fx.designPath);
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'schematic-')));
    fx = makeFunctionalFixture(root);
    process.env.PDFINFO = fakePdfinfo(root);
    exports = 0;
    sequence = 0;
    afterExport = () => {};
  });
  afterEach(() => {
    delete process.env.PDFINFO;
    rmSync(root, { recursive: true, force: true });
  });

  test('a complete source-bound contract passes only declared functions', async () => {
    const report = await check();
    assert.equal(report.status, 'passed', JSON.stringify(report.blockers));
    assert.equal(report.schema, RESULT);
    assert.equal(Object.keys(report.requirement_results).length, 5);
    assert.equal((report.coverage as Json).passed_assertions, 5);
    assert.equal(report.qualified, false);
    assert.equal((report.native_export_cache as Json).hit, false);
    assert.equal((report.native_export_cache as Json).reusable, false);
    assert.equal(rail(report).actual.max, '0.040');
    assert.deepEqual(rail(report).covered_references, ['J1', 'J2']);
  });

  test('a wrong actual value blocks and equivalent notation passes', async () => {
    setValue('1000nF');
    assert.equal((await check()).status, 'passed');
    setValue('10uF');
    const report = await check();
    assert.equal(report.status, 'blocked');
    assert.equal(requirement(report, 'REQ-VALUE'), 'blocked');
  });

  test('a schematic/PCB value disagreement fails on its own', async () => {
    changeProperty(fx.schematic, 'symbol', 'J1', 'Value', '10uF');
    assert.ok(causes(await check()).some(cause => cause.includes('schematic/PCB nominal')));
  });

  test('a wrong schematic pin net blocks even when the PCB matches the review', async () => {
    const tree = parse(readFileSync(fx.schematic, 'utf8'));
    (items(tree, 'label')[0] as CadList)[1] = 'B';
    writeFileSync(fx.schematic, dump(tree));
    const report = await check();
    assert.equal(report.status, 'blocked');
    assert.match(report.blockers[0]?.detail as string, /actual schematic\/PCB connected pin differs/);
  });

  test('a native DNP change is not hidden by an unchanged contract', async () => {
    // Isolates the population assertion from the part-review budget, which would catch J2 by itself.
    editParts(parts => { parts.budgets = []; });
    fx.save();
    const sheet = parse(readFileSync(fx.schematic, 'utf8'));
    (item(placed(sheet, 'symbol', 'J2'), 'dnp') as CadList)[1] = new Atom('yes');
    writeFileSync(fx.schematic, dump(sheet));
    const board = parse(readFileSync(fx.pcb, 'utf8'));
    (items(board, 'footprint')[1] as CadList).push([new Atom('attr'), new Atom('smd'), new Atom('dnp')]);
    writeFileSync(fx.pcb, dump(board));
    const report = await check();
    assert.equal(report.status, 'blocked');
    assert.ok(causes(report).some(cause => cause.includes('population differs')), JSON.stringify(report.blockers));
  });

  test('a wrong native mode blocks the values and budgets that need it', async () => {
    changeProperty(fx.schematic, 'symbol', 'J1', 'Operating_Mode', 'high');
    const report = await check();
    assert.equal(report.status, 'blocked');
    for (const id of ['REQ-MODE', 'REQ-VALUE', 'REQ-BUDGET']) assert.equal(requirement(report, id), 'blocked');
  });

  test('aggregate loads and complete native branch coverage are required', async () => {
    budgetRow().limit = fx.interval(0, 30, 'mA');
    fx.save();
    assert.equal(requirement(await check(), 'REQ-BUDGET'), 'blocked');
    budgetRow().loads.pop();
    fx.save();
    assert.ok(causes(await check()).some(cause => cause.includes('coverage')));
  });

  test('a local budget cannot understate reviewed current demands', async () => {
    for (const load of budgetRow().loads) load.demand = fx.interval(0, 1, 'mA');
    budgetRow().limit = fx.interval(0, 3, 'mA');
    editDesign(design => { design.requirements.at(-1).acceptance = { kind: 'interval', ...fx.interval(0, 3, 'mA') }; });
    fx.save();
    const report = await check();
    assert.equal(requirement(report, 'REQ-BUDGET'), 'blocked');
    assert.ok(causes(report).some(cause => cause.includes('exact reviewed part-use demand')));
  });

  test('omitted load demands use the selected reviewed budget', async () => {
    for (const load of budgetRow().loads) delete load.demand;
    fx.save();
    let report = await check();
    assert.equal(report.status, 'passed', JSON.stringify(report.blockers));
    assert.ok(number(rail(report).actual.max).equals(d('.04')));
    assert.equal(rail(report).actual.unit, 'A');
    assert.deepEqual(rail(report).reviewed_demand_bindings.map((row: Json) => row.budget), ['rail', 'rail']);
    editParts(parts => { for (const load of parts.budgets[0].loads) load.required.max = 0.03; });
    fx.save();
    report = await check();
    assert.equal(report.status, 'passed', JSON.stringify(report.blockers));
    assert.ok(number(rail(report).actual.max).equals(d('.06')));
  });

  test('an explicit demand stays exact after unit normalization', async () => {
    for (const load of budgetRow().loads) load.demand = fx.interval(0, 0.02, 'A');
    fx.save();
    assert.equal((await check()).status, 'passed');
    budgetRow().loads[0].demand = fx.interval(0, 21, 'mA');
    fx.save();
    const report = await check();
    assert.equal(requirement(report, 'REQ-BUDGET'), 'blocked');
    assert.ok(causes(report).some(cause => cause.includes('exact reviewed part-use demand')));
  });

  test('a missing or wrong reviewed demand binding is no budget pass', async () => {
    const load = budgetRow().loads[0];
    for (const selector of [null, { budget: 'unknown' }, { budget: 'rail', rating: 'supply' }]) {
      if (selector === null) delete load.reviewed_demand;
      else load.reviewed_demand = selector;
      fx.save();
      assert.equal(requirement(await check(), 'REQ-BUDGET'), 'blocked');
    }
  });

  test('a non-load classification cannot erase a positive reviewed load', async () => {
    budgetRow().loads.pop();
    budgetRow().exclusions = [{ reference: 'J2', reason: 'synthetic incorrect passive classification', source: fx.source }];
    budgetRow().limit = fx.interval(0, 30, 'mA');
    fx.save();
    const report = await check();
    assert.equal(requirement(report, 'REQ-BUDGET'), 'blocked');
    assert.ok(causes(report).some(cause => cause.includes('positive reviewed load')));
  });

  const addRating = (id: string, required: number) => editParts(parts => {
    for (const part of parts.parts.slice(0, 2)) {
      const { path, sha256, page } = part.datasheets[0];
      part.ratings.push({ id, quantity: 'current', limit: { min: 0, max: 0.1, unit: 'A', source: { path, sha256, page } }, required: fx.interval(0, required, 'A'), conditions: [] });
    }
  });

  test('a lower rating selector cannot override a reviewed net budget', async () => {
    addRating('other-current', 0.001);
    for (const load of budgetRow().loads) Object.assign(load, { reviewed_demand: { rating: 'other-current' }, demand: fx.interval(0, 1, 'mA') });
    for (const explicit of [true, false]) {
      if (!explicit) for (const load of budgetRow().loads) delete load.demand;
      fx.save();
      const report = await check();
      assert.equal(requirement(report, 'REQ-BUDGET'), 'blocked');
      assert.ok(causes(report).some(cause => cause.includes('another scoped reviewed net demand')));
    }
  });

  test('a part rating\'s required current can bind a load', async () => {
    addRating('load-current', 0.02);
    for (const load of budgetRow().loads) load.reviewed_demand = { rating: 'load-current' };
    for (const explicit of [true, false]) {
      if (!explicit) for (const load of budgetRow().loads) delete load.demand;
      fx.save();
      const report = await check();
      assert.equal(report.status, 'passed', JSON.stringify(report.blockers));
      assert.deepEqual(rail(report).reviewed_demand_bindings.map((row: Json) => row.rating), ['load-current', 'load-current']);
      assert.ok(number(rail(report).actual.max).equals(d('.04')));
    }
  });

  test('no implicit tolerance, wrong dimension, boolean or text quantity', async () => {
    const expected = fx.value.assertions[0].expected;
    for (const changes of [{ unit: 'W' }, { min: true }, { max: null }, { min: '1' }]) {
      const original = structuredClone(expected);
      Object.assign(expected, changes);
      fx.save();
      assert.equal((await check()).status, 'blocked', JSON.stringify(changes));
      for (const key of Object.keys(expected)) delete expected[key];
      Object.assign(expected, original);
    }
  });

  test('a stale review and an unknown requirement fail before the export', async () => {
    fx.value.assertions[0].mpn = 'WRONG';
    fx.save(false);
    assert.equal((await check()).status, 'blocked');
    assert.equal(exports, 0);
    fx.value.assertions[0].requirement = 'NOT-A-REQUIREMENT';
    fx.save();
    assert.equal((await check()).status, 'blocked');
    assert.equal(exports, 0);
  });

  test('variant absence is bound and unknown overrides fail closed', async () => {
    const variants = join(fx.folder, 'variants.json');
    writeFileSync(variants, '{}');
    assert.equal((await check()).status, 'blocked');
    assert.equal(exports, 0);
    unlinkSync(variants);
    fx.value.assertions[0].tolerance = 0.5;
    fx.save();
    assert.equal((await check()).status, 'blocked');
  });

  test('a source changed during the export is caught before any pass', async () => {
    afterExport = () => writeFileSync(fx.schematic, `${readFileSync(fx.schematic, 'utf8')}\n`);
    const report = await check();
    assert.equal(report.status, 'blocked');
    assert.match(report.blockers.at(-1)?.detail as string, /changed during verification/);
  });

  test('the closure is complete and assertion order does not matter', async () => {
    fx.value.assertions.reverse();
    fx.save();
    assert.equal((await check()).status, 'passed');
    const files = dependencyFiles(root, fx.contract);
    for (const path of [fx.designPath, fx.partManifest, fx.spec, fx.schematic, fx.pcb]) assert.ok(files.includes(path.slice(root.length + 1)), path);
    assert.ok(files.includes('hardware-design/registry/datasheets/SYNTHETIC-TP.pdf'));
  });

  test('a design numeric acceptance cannot be relaxed by a local assertion', async () => {
    editDesign(design => { design.requirements[0].acceptance = { kind: 'interval', ...fx.interval(0, 100, 'nF') }; });
    fx.save();
    const report = await check();
    assert.equal(requirement(report, 'REQ-VALUE'), 'blocked');
    assert.ok(causes(report).some(cause => cause.includes('named design requirement')));
  });

  test('a numeric requirement cannot be met by an unrelated mode', async () => {
    editDesign(design => { design.requirements[3].acceptance = { kind: 'interval', ...fx.interval(0, 1, 'A') }; });
    fx.save();
    assert.equal(requirement(await check(), 'REQ-MODE'), 'blocked');
  });

  test('a wrong design board and an invalid PDF page fail closed', async () => {
    editDesign(design => { design.identity.board = 'OTHER'; });
    fx.save();
    assert.equal((await check()).status, 'blocked');
    assert.equal(exports, 0);
    editDesign(design => { design.identity.board = fx.board; });
    const pdf = join(root, 'hardware-design/registry/datasheets/SYNTHETIC-TP.pdf');
    fx.value.assertions[0].expected.source = { path: pdf.slice(root.length + 1), sha256: sha256File(pdf), page: 2 };
    fx.save();
    assert.equal((await check()).status, 'blocked');
  });
});
