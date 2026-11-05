// Gate admission of a route run: a G4 or G5 gate that the shared validator accepts, before any routing is spent.
import { pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { sha256File } from './json-file.ts';
import { resolvePath } from './py-path.ts';
import { readObject } from './json-file.ts';

export interface GateAdmission { stage: 'G4' | 'G5'; inputs: Record<string, string> }

/** Run the shared pure validator before routing. */
export async function validateGate(rootPath: string, board: string): Promise<GateAdmission> {
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(board)) throw new Error('invalid board ID');
  const root = resolvePath(rootPath), config = join(root, 'hardware-design/boards', board, 'gate.json');
  const core = join(root, 'tools/lib/gate-core.mjs');
  const files = [config, core];
  const inputs = Object.fromEntries(files.map(path => [path, sha256File(path)]));
  const module = await import(`${pathToFileURL(core).href}?sha256=${inputs[core]}`) as { validateConfig(config: unknown): string[] };
  const value = readObject<{ stage?: string }>(config), stage = value.stage ?? 'G4', errors = module.validateConfig(value);
  if (!['G4', 'G5'].includes(stage)) errors.push('controlled routing requires a G4 or G5 gate');
  if (errors.length) throw new Error('controlled routing gate configuration rejected: ' + errors.join('; '));
  if (files.some(path => sha256File(path) !== inputs[path])) throw new Error('gate configuration or validator changed during admission');
  return { stage: stage as GateAdmission['stage'], inputs: Object.fromEntries(files.map(path => [relative(root, path), inputs[path]])) };
}
