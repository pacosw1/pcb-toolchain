import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadTransitions, parseTransitions, redoFor, widestKind, type Kind } from './transitions.ts';

const raw = (): Record<string, any> => JSON.parse(readFileSync(fileURLToPath(new URL('../pcb-transitions.json', import.meta.url)), 'utf8'));
const doc = readFileSync(fileURLToPath(new URL('../PCB-STATE-MACHINE.md', import.meta.url)), 'utf8');
const stateOf = (table: Record<string, any>, id: string) => table.states.find((state: { id: string }) => state.id === id);
const kindOf = (table: Record<string, any>, id: string) => table.kinds.find((kind: { id: string }) => kind.id === id);
const cells = (line: string): string[] => line.split('|').slice(1, -1).map(cell => cell.trim());
const ids = (text: string): string[] => text.match(/\b[AB]\d+\b/g) ?? [];

/** The rows of the Markdown table that follows `heading`. */
function rows(heading: string): string[][] {
  const start = doc.indexOf(heading), lines = doc.slice(start).split('\n'), first = lines.findIndex(line => line.startsWith('|'));
  const end = lines.findIndex((line, index) => index > first && !line.startsWith('|'));
  return lines.slice(first + 2, end).map(cells);
}
const documented = [...rows('## A. States of the board process'), ...rows('## B. States in the code')];

function refused(change: (table: Record<string, any>) => void, pattern: RegExp): void {
  const table = raw(); change(table);
  assert.throws(() => parseTransitions(table), pattern);
}

test('the table in the repository is valid', () => {
  const table = loadTransitions();
  assert.equal(table.schema, 'iot-lab.transitions.v1');
  assert.equal(table.states.length, 43);
});

test('each state of PCB-STATE-MACHINE.md is in the table with its status, inputs, outputs and transitions', () => {
  const table = raw();
  assert.equal(documented.length, 43);
  assert.deepEqual(table.states.map((state: { id: string }) => state.id), documented.map(row => row[0]!.split(' ')[0]));
  for (const [title, , input, output, next, , status] of documented) {
    const id = title!.split(' ')[0]!, state = stateOf(table, id), named = /^None/.test(input!), none = /^None/.test(output!);
    assert.ok(state, `${id} is in the table`);
    assert.equal(`\`${state.status}\``, status!.split(' ')[0], `${id} status`);
    if (!named) assert.ok(state.inputs.length, `${id} has inputs`);
    if (!none) assert.ok(state.outputs.length, `${id} has outputs`);
    const allowed = [...state.next, ...state.back.map((edge: { to: string }) => edge.to)];
    for (const target of ids(next!)) assert.ok(allowed.includes(target), `${id} may go to ${target}`);
  }
});

test('each state with a gap in section H has that gap in the table, and no other state has one', () => {
  const gaps = rows('## H. Input and output audit').map(row => row[0]!.split(' ')[0]);
  const table = raw();
  assert.deepEqual(table.states.filter((state: { gap?: string }) => state.gap).map((state: { id: string }) => state.id).sort(), [...gaps].sort());
});

test('each row of table G.3 has a kind with the same re-enter states', () => {
  const table = raw(), changes = rows('### G.3 Table of change kinds');
  assert.equal(changes.length, 22);
  const noKind = ['T5', 'T6', 'T10', 'T12', 'T13', 'T14', 'T17', 'T19'];   // the readers of the evidence find these; a kind would add no effect
  for (const [row, , , , reenter] of changes) {
    const kinds = table.kinds.filter((kind: { doc: string }) => kind.doc === row);
    assert.equal(kinds.length > 0, !noKind.includes(row!), `${row} has a kind, or is one of the rows with none`);
    for (const kind of kinds) for (const state of ids(reenter!)) assert.ok(kind.reenter.includes(state), `${row} re-enters ${state}`);
  }
});

test('the first row of a group is the widest row of the group', () => {
  const table = loadTransitions();
  for (const group of Object.keys(table.groups)) {
    const widest = widestKind(table, group);
    assert.equal(widest.group, group);
    for (const kind of table.kinds) if (kind.group === group) for (const item of kind.redo) assert.ok(widest.redo.includes(item), `${widest.id} redoes ${item}`);
  }
  assert.throws(() => widestKind(table, 'nothing'), /no kind/);
});

test('the validator refuses a table that can represent a bad state', () => {
  refused(table => { table.schema = 'old'; }, /schema/);
  refused(table => { table.extra = 1; }, /unknown key extra/);
  refused(table => { table.states.push({ ...table.states[0] }); }, /duplicate state A1/);
  refused(table => { stateOf(table, 'A1').status = 'fine'; }, /A1: status/);
  refused(table => { stateOf(table, 'A1').next = ['A99']; }, /A1: next A99 is not a state/);
  refused(table => { stateOf(table, 'A9').next = ['A7']; }, /A9: next A7 is not forward/);
  refused(table => { stateOf(table, 'A9').back = [{ to: 'A10', on: 'x' }]; }, /A9: back A10 is not backward/);
  refused(table => { stateOf(table, 'A9').back = [{ to: 'A7', on: '' }]; }, /A9: back A7 needs a code/);
  refused(table => { stateOf(table, 'A4').evidence = 'luck'; }, /A4: evidence luck/);
  refused(table => { stateOf(table, 'A1').inputs = []; }, /A1: inputs may be empty only with a gap/);
  refused(table => { stateOf(table, 'A4').outputs[0].path = '{nothing}/x'; }, /A4: unknown placeholder/);
  refused(table => { stateOf(table, 'A24').next = []; }, /A24: only the last state/);
  refused(table => { stateOf(table, 'A10').next = []; stateOf(table, 'A9').next = ['A9x']; }, /not a state/);
  refused(table => { stateOf(table, 'A9').next = ['A9'.replace('9', '10')]; stateOf(table, 'A8').next = ['A10']; }, /A9 cannot be reached/);
  refused(table => { table.kinds.push({ ...table.kinds[0] }); }, /duplicate kind/);
  refused(table => { kindOf(table, 'net_change').group = 'nothing'; }, /net_change: group/);
  refused(table => { kindOf(table, 'net_change').reenter = ['A99']; }, /net_change: reenter A99/);
  refused(table => { kindOf(table, 'net_change').reenter = []; }, /net_change: reenter/);
  refused(table => { kindOf(table, 'net_change').redo = ['luck']; }, /net_change: redo luck/);
  refused(table => { kindOf(table, 'net_change').approve = ['luck']; }, /net_change: approve luck/);
  refused(table => { kindOf(table, 'net_change').keep = ['gate']; }, /net_change: gate is in redo and keep/);
  refused(table => { kindOf(table, 'net_change').redo = [...kindOf(table, 'net_change').redo, 'design_assessment']; kindOf(table, 'net_change').keep = []; }, /widest/);
  refused(table => { kindOf(table, 'net_change').reenter = ['A1']; }, /widest/);
  refused(table => { kindOf(table, 'human_edit').redo = ['gate']; }, /human_edit: role delegate/);
  refused(table => { table.kinds = table.kinds.filter((kind: Kind) => kind.group !== 'rules'); }, /group rules has no kind/);
});

test('a problem list names all problems at once', () => {
  const table = raw(); stateOf(table, 'A1').status = 'fine'; kindOf(table, 'net_change').redo = ['luck'];
  assert.throws(() => parseTransitions(table), error => /A1: status/.test((error as Error).message) && /net_change: redo luck/.test((error as Error).message));
});

test('the table is frozen after load', () => {
  const table = loadTransitions();
  assert.throws(() => { (table.states[0] as { status: string }).status = 'enforced'; }, TypeError);
  assert.throws(() => { (table.kinds as Kind[]).pop(); }, TypeError);
});

test('redoFor asks each reader in table order and a reader that fails is not current', () => {
  const table = loadTransitions(), kind = table.kinds.find(row => row.id === 'part_swap_same_footprint')!;
  const seen = redoFor(kind, { part_review: () => 'current', bom: () => 'stale', gate: () => { throw new Error('no data'); } });
  assert.deepEqual(seen.map(row => row.evidence), kind.redo);
  assert.deepEqual(seen.slice(0, 2).map(row => row.status), ['current', 'stale']);
  assert.equal(seen.find(row => row.evidence === 'gate')!.status, 'unknown');
  assert.equal(seen.find(row => row.evidence === 'gate')!.cause, 'no data');
  assert.equal(seen.find(row => row.evidence === 'release')!.status, 'unknown');
});
