// Mac-side gate admission for the Rust trial runner. The route image never needs Node.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { bind, PATCH } from './backend-quality.ts';
import { sha256File } from './json-file.ts';
import { resolvePath } from './py-path.ts';
import { readObject } from './json-file.ts';

export interface GateAdmission { stage: 'G4' | 'G5'; inputs: Record<string, string> }

/** Run the shared pure validator before expensive daemon admission, then ship its source bindings with the job. */
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

export interface BackendAdmission { policy: unknown; inputs: Record<string, string> }
/** Paths outside root must be staged and remapped by the job's existing file transport. */
export function validateBackend(root: string, binary: string, manifest: string | null): BackendAdmission {
  const policy = bind(binary, manifest), files = [fileURLToPath(new URL('./backend-quality.ts', import.meta.url))];
  if (manifest) {
    files.push(resolvePath(manifest), PATCH);
    const value = readObject<{ native_validation: { evidence: { path: string }[] } }>(manifest);
    files.push(...value.native_validation.evidence.map(row => row.path));
  }
  return { policy, inputs: Object.fromEntries(files.map(path => [path.startsWith(root + '/') ? relative(root, path) : path, sha256File(path)])) };
}
