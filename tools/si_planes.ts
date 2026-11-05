// Reference-plane gate of a board. The spec and the rules are in tools/router/core/src/si/planes/mod.rs.
//
//   tools/si_planes.ts BOARD.kicad_pcb SPEC.json [--verbose]
//
// Exit 0: pass. 1: a FAIL. 2: tool error (missing board, bad spec, no board JSON).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { runChecker } from './lib/si-native.ts';

const USAGE = 'usage: tools/si_planes.ts BOARD.kicad_pcb SPEC.json [--verbose]';

/** This folder holds edge-rates.json and driver-edges.json; their evidence is in its parent. */
const TOOLS = dirname(fileURLToPath(import.meta.url));

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { verbose: { type: 'boolean' } }, USAGE);
  const [board, spec] = positionals;
  if (board === undefined || spec === undefined || positionals.length !== 2) throw new UsageError(USAGE);
  return runChecker('si-planes', board, spec, ['--tools', TOOLS, ...(values.verbose ? ['--verbose'] : [])]);
}

runMain(import.meta.url, main);
