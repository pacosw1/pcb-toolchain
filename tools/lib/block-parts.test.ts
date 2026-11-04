import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bom, checkParts, cost, jlcClass, JLC_EXTENDED_FEE_USD, kicadMeta, parseFootprints, resolveDatasheet, usedIn, validateFacts,
  type Part,
} from './block-parts.ts';

const PCB = `(kicad_pcb
	(footprint "Diode_SMD:D_SMA"
		(layer "F.Cu")
		(property "Reference" "D2"
			(at 0 0 0))
		(property "Value" "SS36")
		(property "Datasheet" "\${KIPRJMOD}/../../../../registry/datasheets/SS36.pdf")
		(property "LCSC" "C22452")
		(property "MPN" "SS36")
		(property "Description" "reverse polarity diode")
	)
	(footprint "Diode_SMD:D_SMA"
		(layer "F.Cu")
		(property "Reference" "D1")
		(property "Value" "SS36")
		(property "Datasheet" "SS36.pdf")
		(property "LCSC" "C22452")
		(property "MPN" "SS36")
	)
	(footprint "TestPoint:TP"
		(layer "F.Cu")
		(property "Reference" "TP1")
		(property "Value" "TP")
	)
	(group "PWR-24V-IN"
		(members "a" "b"))
)
`;
const parts = parseFootprints(PCB);
const row = (refs: string[], lcsc: string, price: number | null, jlc_class: string | null, qty = refs.length) =>
  ({ refs, qty, lcsc, evidence: price === null ? null : { date: '', stock: 0, verified: true, file: '', price, jlc_class } });

test('footprints and their properties', () => {
  assert.deepEqual(parts.map(part => part.ref), ['D2', 'D1', 'TP1']);
  assert.deepEqual(parts[0], {
    ref: 'D2', value: 'SS36', footprint: 'Diode_SMD:D_SMA', lcsc: 'C22452', mpn: 'SS36',
    description: 'reverse polarity diode', datasheet: 'SS36.pdf', url: '',
  });
  assert.equal(parts[2]?.lcsc, '');
});

test('a block group names the boards that use it', () => {
  const boards = new Map([['RELAY-4', PCB], ['BASE-PWR', '(kicad_pcb)']]);
  assert.deepEqual(usedIn(boards, 'PWR-24V-IN'), ['RELAY-4']);
});

test('a URL datasheet is a URL; a registry file by MPN wins over it', () => {
  const [part] = parseFootprints('(kicad_pcb\n\t(footprint "R:R"\n\t\t(property "Reference" "R1")\n'
    + '\t\t(property "Datasheet" "https://www.lcsc.com/datasheet/x_C25804.pdf")\n\t\t(property "MPN" "0603WAF1002T5E")\n\t)\n)');
  assert.deepEqual([part?.datasheet, part?.url], ['', 'https://www.lcsc.com/datasheet/x_C25804.pdf']);
  assert.equal(resolveDatasheet({ datasheet: '', mpn: '0603WAF1002T5E' }, new Set(['0603WAF1002T5E.pdf'])), '0603WAF1002T5E.pdf');
  assert.equal(resolveDatasheet({ datasheet: 'SS36.pdf', mpn: 'X' }, new Set()), 'SS36.pdf');
  const urlOnly = { ref: 'R1', lcsc: 'C25804', datasheet: '', url: 'https://x/y.pdf', mpn: 'Z' } as Part;
  assert.deepEqual(checkParts([urlOnly], new Map()), ['R1: datasheet is only a URL, not in registry/datasheets']);
});

test('BOM groups the same part, refs in natural order', () => {
  const rows = bom(parts);
  assert.deepEqual(rows[0]?.refs, ['D1', 'D2']);
  assert.equal(rows[0]?.qty, 2);
  assert.equal(rows[0]?.datasheet, 'SS36.pdf');
  assert.equal(rows[0]?.description, 'reverse polarity diode');
  assert.equal(rows[1]?.description, '');
  const many = ['C10', 'C2'].map(ref => ({ ...parts[2], ref }) as Part);
  assert.deepEqual(bom(many)[0]?.refs, ['C2', 'C10']);
});

test('part checks report C-number and datasheet faults', () => {
  const errors = checkParts(parts, new Map([['SS36.pdf', ['aa', 'aa']]]));
  assert.ok(errors.includes('TP1: no JLC C-number'));
  assert.ok(errors.includes('TP1: no datasheet'));
  assert.ok(!errors.some(error => error.startsWith('D')));
  assert.deepEqual(checkParts(parts.slice(0, 1), new Map([['SS36.pdf', ['aa', 'bb']]])), ['D2: SS36.pdf sha256 does not match its .source.json']);
  assert.deepEqual(checkParts(parts.slice(0, 1), new Map()), ['D2: SS36.pdf not in registry/datasheets']);
});

test('facts need a level and sourced rules', () => {
  assert.deepEqual(validateFacts({ level: 0, layout_rules: [{ rule: 'r', source: 'SS36.pdf p.3' }] }), []);
  const errors = validateFacts({ level: 3, layout_rules: [{ rule: 'r' }] });
  assert.ok(errors.includes('level must be 0, 1 or 2'));
  assert.ok(errors.includes('layout rule 1 has no source'));
});

test('KiCad metadata has three keys, no indent, no final newline', () => {
  const text = kicadMeta('24 V input', 'power tvs');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['description', 'keywords', 'fields']);
  assert.ok(!text.endsWith('\n'));
  assert.ok(text.startsWith('{\n"description"'));
});

test('cost totals unit price x qty and lists Extended parts', () => {
  const result = cost([row(['C1', 'C2'], 'C13585', 0.2653, 'Basic Part'), row(['F1'], 'C87383', 0.3748, 'Extended Part'), row(['TP1'], '', null, null)]);
  assert.equal(result.parts_usd, 0.9054);
  assert.deepEqual(result.extended, ['C87383']);
  assert.deepEqual(result.missing, ['TP1']);
});

test('the order fee is per unique Extended part', () => {
  const result = cost([row(['F1'], 'C87383', 0.3748, 'Extended Part'), row(['D3'], 'C224048', 0.2958, 'Extended Part'), row(['C1'], 'C13585', 0.2653, 'Basic Part')]);
  assert.equal(result.extended_fee_usd, 2 * JLC_EXTENDED_FEE_USD);
  assert.ok(Math.abs(result.first_board_usd - (0.9359 + 2 * JLC_EXTENDED_FEE_USD)) < 1e-4);
});

test('a price without a JLC class is listed, not counted as Basic', () => {
  const result = cost([row(['U1'], 'C1', 1, null)]);
  assert.deepEqual(result.unknown_class, ['C1']);
  assert.equal(result.extended_fee_usd, 0);
});

test('the API record decides the JLC class; Preferred pays no fee', () => {
  assert.equal(jlcClass({ componentLibraryType: 'expand', preferredComponentFlag: true }, 'Extended Part'), 'Preferred Extended Part');
  assert.equal(jlcClass({ componentLibraryType: 'expand', preferredComponentFlag: false }, null), 'Extended Part');
  assert.equal(jlcClass({ componentLibraryType: 'base' }, 'Extended Part'), 'Basic Part');
  assert.equal(jlcClass(null, 'Extended Part'), 'Extended Part');
  assert.deepEqual(cost([row(['U3'], 'C7562', 0.1, 'Preferred Extended Part')]).extended, []);
});
