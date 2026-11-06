// Compare native integer-coordinate exports. Never infer preservation from a
// rounded routing JSON value; the native writer truncates before KiCad reads it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const encoded = value => JSON.stringify(canonical(value));
function items(document) {
  assert.equal(document.schema, 'iot-lab.board.v1', 'native board export required');
  function integerCoordinates(value) {
    if (typeof value === 'number') assert.ok(Number.isSafeInteger(value), 'native geometry must use exact integer units');
    else if (value && typeof value === 'object') for (const child of Object.values(value)) integerCoordinates(child);
  }
  return document.board.copper.map(item => {
    const [[kind, value]] = Object.entries(item); integerCoordinates(value);
    const { id, ...geometry } = value;
    return { id, locked: value.locked, net: value.net, geometry: encoded([kind, geometry]), identity: encoded(item) };
  });
}
export function audit(before, after) {
  const a = items(before), b = items(after);
  const group = all => {
    const map = new Map();
    for (const item of all) { if (!map.has(item.net)) map.set(item.net, []); map.get(item.net).push(item.geometry); }
    for (const values of map.values()) values.sort();
    return map;
  };
  const x = group(a), y = group(b), nets = [...new Set([...x.keys(), ...y.keys()])].sort();
  const changed = nets.filter(net => encoded(x.get(net)) !== encoded(y.get(net)));
  const byId = new Map(b.map(item => [item.id, item]));
  const locked = a.filter(item => item.locked);
  const changedLocked = locked.filter(item => byId.get(item.id)?.identity !== item.identity);
  const lockedIds = new Set(locked.map(item => item.id));
  const unexpectedLocked = b.filter(item => item.locked && !lockedIds.has(item.id));
  return { schema: 'pcb.ref-feedback-geometry-audit.v1', basis: 'native exact integer nanometres; no geometric tolerance',
    source_board_sha256: before.board_sha256, candidate_board_sha256: after.board_sha256,
    source_copper: a.length, candidate_copper: b.length, changed_nets: changed,
    unchanged_nets: nets.filter(net => !changed.includes(net)),
    protected_locked_items: locked.length, candidate_locked_items: b.filter(item => item.locked).length,
    changed_locked_ids: changedLocked.map(item => item.id), unexpected_locked_ids: unexpectedLocked.map(item => item.id),
    protected_locked_unchanged: changedLocked.length === 0 && unexpectedLocked.length === 0,
    note: 'unlocked routed-item UUIDs are regenerated; geometry compares net/layer/coordinates/width/drill/type and lock state' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [before, after] = process.argv.slice(2); if (!before || !after) throw Error('BEFORE_NATIVE.json AFTER_NATIVE.json required');
  console.log(JSON.stringify(audit(JSON.parse(fs.readFileSync(before)), JSON.parse(fs.readFileSync(after))), null, 2));
}
