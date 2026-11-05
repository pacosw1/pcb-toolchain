// Check hierarchical block identity before preserving its placement as a unit: exact parts, pad definitions, injective
// net mapping and rigid quarter-turn placement. It grants no copper reuse or electrical qualification.
import { readBlock } from './block-reuse.ts';
import { Decimal, positiveDegrees } from './decimal.ts';
import { fingerprint } from './fingerprint.ts';
import { footprints, instanceOf, rotate, sourceSet, symbolOf, type Footprint } from './native-board.ts';
import { jsonCanonical } from './py-compat.mjs';
import { joinPath, resolvePath } from './py-path.ts';
import { field, type SList } from './sexpr.ts';

export interface Binding {
  schema: 'iot-lab.block-binding.v1';
  status: string;
  qualified: false;
  block_id: string;
  source_directory: string;
  source_sha256: string;
  target: string;
  target_inputs: Map<string, string>;
  instance_path: string;
  refs: Map<string, string>;
  net_map: Map<string, string>;
  transform: { rotation_quarters: number; translation_mm: [string, string] };
  declared_level: unknown;
  open_items: string[];
  facts_errors: string[];
  missing_block_files: string[];
  target_checks_required: string[];
  copper_reuse_approved: false;
}

interface Pad { net: string; shape: string }

const ASSEMBLY_FIELDS = ['attr', 'dnp', 'exclude_from_bom', 'exclude_from_pos_files'];
const QUARTERS = ['0', '90', '180', '270'].map(Decimal.of);
const same = (a: unknown, b: unknown): boolean => jsonCanonical(a ?? null) === jsonCanonical(b ?? null);

function padShape(pad: SList, footprint: Footprint): string {
  const shape: SList = [];
  for (const item of pad.slice(2)) {
    if (!Array.isArray(item)) {
      shape.push(item);
    } else if (item[0] === 'at') {
      const angle = item.length === 4 ? Decimal.of(item[3] as string) : Decimal.of('0');
      const local = positiveDegrees(angle.sub(footprint.pose[2]));
      shape.push(['at', Decimal.of(item[1] as string).normalize().toString(), Decimal.of(item[2] as string).normalize().toString(), local.normalize().toString()]);
    } else if (!['net', 'uuid', 'pinfunction', 'pintype'].includes(item[0] as string)) {
      shape.push(item);
    }
  }
  return fingerprint(shape);
}

function pads(footprint: Footprint): Map<string, Pad> {
  const result = new Map<string, Pad>();
  for (const pad of footprint.form.slice(1)) {
    if (!Array.isArray(pad) || pad[0] !== 'pad') continue;
    const number = pad[1] as string;
    if (!number || result.has(number)) throw new Error('unique numbered pads required for block binding');
    const net = (field(pad, 'net') ?? ['']).at(-1) as string;
    if (/^\p{Nd}+$/u.test(net)) throw new Error('legacy numeric pad net needs native normalization');
    result.set(number, { net, shape: padShape(pad, footprint) });
  }
  if (!result.size) throw new Error('block part has no numbered pads');
  return result;
}

function bySymbol(rows: Footprint[]): Map<string, Footprint> {
  const indexed = new Map(rows.map(row => [symbolOf(row.path), row]));
  if (!rows.length || indexed.has('') || indexed.size !== rows.length) throw new Error('missing or ambiguous schematic symbol identity');
  return indexed;
}

function checkPart(source: Footprint, target: Footprint, label: string): void {
  for (const name of ['MPN', 'LCSC', 'Value']) {
    const value = source.props.get(name);
    if (!value || value !== target.props.get(name)) throw new Error(`${label}: exact ${name} differs or missing`);
  }
  if (source.form[1] !== target.form[1] || !same(field(source.form, 'layer'), field(target.form, 'layer'))) {
    throw new Error(`${label}: footprint or side differs`);
  }
  for (const name of ASSEMBLY_FIELDS) {
    if (!same(field(source.form, name), field(target.form, name))) throw new Error(`${label}: assembly attribute differs: ${name}`);
  }
}

function checkPads(source: Footprint, target: Footprint, label: string, netMap: Map<string, string>): void {
  const before = pads(source), after = pads(target);
  if (before.size !== after.size || [...before.keys()].some(pin => !after.has(pin))) throw new Error(`${label}: pad identities differ`);
  for (const [pin, pad] of before) {
    const other = after.get(pin) as Pad;
    if (pad.shape !== other.shape) throw new Error(`${label}.${pin}: pad definition differs`);
    if (Boolean(pad.net) !== Boolean(other.net)) throw new Error(`${label}.${pin}: connectedness differs`);
    if (pad.net) {
      if ((netMap.get(pad.net) ?? other.net) !== other.net) throw new Error('one source net maps to multiple target nets');
      netMap.set(pad.net, other.net);
    }
  }
}

/** The rigid move from a source part to its target: quarter turns, then a translation. */
function transformOf(source: Footprint, target: Footprint): { quarters: number; x: Decimal; y: Decimal } {
  const delta = positiveDegrees(target.pose[2].sub(source.pose[2]));
  const quarters = QUARTERS.findIndex(angle => angle.equals(delta));
  if (quarters < 0) throw new Error('only rigid quarter-turn block placement supported');
  const [x, y] = rotate(source.pose[0], source.pose[1], quarters, value => value.neg());
  return { quarters, x: target.pose[0].sub(x), y: target.pose[1].sub(y) };
}

export function bindInstance(directory: string, target: string, instancePath: string): Binding {
  const folder = resolvePath(directory), board = resolvePath(target);
  const row = readBlock(folder);
  if (!instancePath.startsWith('/') || instancePath.endsWith('/')) throw new Error('exact hierarchical instance path required');
  const before = sourceSet(board);
  const sources = bySymbol(footprints(joinPath(folder, `${row.id}.kicad_pcb`)));
  const targets = bySymbol(footprints(board).filter(part => instanceOf(part.path) === instancePath));
  if (sources.size !== targets.size || [...sources.keys()].some(symbol => !targets.has(symbol))) {
    throw new Error('source/target instance component identities differ');
  }
  const refs = new Map<string, string>(), netMap = new Map<string, string>();
  const transforms = new Map<string, ReturnType<typeof transformOf>>();
  for (const [symbol, source] of sources) {
    const part = targets.get(symbol) as Footprint;
    const from = source.props.get('Reference'), to = part.props.get('Reference');
    if (!from || !to || refs.has(from) || [...refs.values()].includes(to)) throw new Error('ambiguous reference mapping');
    refs.set(from, to);
    const label = `${from}/${to}`;
    checkPart(source, part, label);
    const move = transformOf(source, part);
    const key = `${move.quarters} ${move.x.normalize().toString().replace(/^-0$/, '0')} ${move.y.normalize().toString().replace(/^-0$/, '0')}`;
    if (!transforms.has(key)) transforms.set(key, move);
    checkPads(source, part, label, netMap);
  }
  if (new Set(netMap.values()).size !== netMap.size) throw new Error('distinct block nets collapse to one target net');
  if (transforms.size !== 1) throw new Error('target block placement is no longer rigid');
  if (!same(before, sourceSet(board)) || row.source_sha256 !== readBlock(folder).source_sha256) {
    throw new Error('block or target changed during binding');
  }
  const [move] = transforms.values() as Iterable<ReturnType<typeof transformOf>>;
  const { quarters, x, y } = move as ReturnType<typeof transformOf>;
  return {
    schema: 'iot-lab.block-binding.v1', status: 'candidate', qualified: false,
    block_id: row.id, source_directory: folder, source_sha256: row.source_sha256,
    target: board, target_inputs: before, instance_path: instancePath,
    refs, net_map: netMap, transform: { rotation_quarters: quarters, translation_mm: [x.toString(), y.toString()] },
    declared_level: row.declared_level, open_items: row.open_items,
    facts_errors: row.facts_errors, missing_block_files: row.missing_files,
    target_checks_required: row.target_checks_required, copper_reuse_approved: false,
  };
}

/** A recorded binding must still equal a fresh one. Its fields come from a JSON file, so they are checked as text. */
export function verifyBinding(binding: Pick<Binding, 'source_directory' | 'target' | 'instance_path'>): Binding {
  const fresh = bindInstance(binding.source_directory, binding.target, binding.instance_path);
  if (!same(fresh, binding)) throw new Error('stale block binding; inspect source and target again');
  return fresh;
}
