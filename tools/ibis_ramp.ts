// Source-bound screening JSON of one IBIS model (D-124c).
//
//   tools/ibis_ramp.ts FILE.ibs MODEL
// Exit 1 on a bad file or an unknown model, 2 on bad usage.
import { Float, jsonCanonical, PyError } from './lib/py-compat.mjs';
import { runMain, UsageError } from './lib/cli.ts';
import { IbisError, load, rampEdges } from './lib/ibis.ts';

const USAGE = 'usage: tools/ibis_ramp.ts FILE.ibs MODEL';
const REASON = 'characterized source model; actual board load/package/PVT applicability unproved';

/** Every number of a model is a float: 50 prints as 50.0. */
function floats(value: unknown): unknown {
  if (typeof value === 'number') return new Float(value);
  if (Array.isArray(value)) return value.map(floats);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, floats(item)]));
}

function screen(file: string, name: string): unknown {
  const parsed = load(file);
  const model = parsed.models.get(name.toLowerCase());
  if (!model) throw new IbisError(`model not found: ${name}`);
  return {
    qualified_fastest_bound: false, kind: 'ibis_ramp_screen', source_path: parsed.source_path,
    source_sha256: parsed.source_sha256, model, edge_screen: Object.keys(model.ramp).length ? rampEdges(model) : null,
    reason: REASON,
  };
}

function main(argv: string[]): number {
  const [file, name] = argv;
  if (argv.length !== 2 || file === undefined || name === undefined) throw new UsageError(USAGE);
  try {
    console.log(jsonCanonical(floats(screen(file, name)), { separators: [', ', ': '] }));
    return 0;
  } catch (error) {
    if (!(error instanceof IbisError || error instanceof PyError)) throw error;
    console.error(error.message);
    return 1;
  }
}

runMain(import.meta.url, main);
