// Differential-pair and impedance gate of a board. The spec and the rules are in tools/router/core/src/si/pairs.rs.
//
//   tools/si_pairs.ts BOARD.kicad_pcb SPEC.json [--dru RULES.kicad_dru] [--verbose]
//
// --dru defaults to the .kicad_dru next to the board. Exit 0: all PASS. 1: a FAIL. 2: tool error.
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { runChecker } from './lib/si-native.ts';

const USAGE = 'usage: tools/si_pairs.ts BOARD.kicad_pcb SPEC.json [--dru RULES.kicad_dru] [--verbose]';

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, { dru: { type: 'string' }, verbose: { type: 'boolean' } }, USAGE);
  const [board, spec] = positionals;
  if (board === undefined || spec === undefined || positionals.length !== 2) throw new UsageError(USAGE);
  return runChecker('si-pairs', board, spec, [...(values.dru ? ['--dru', values.dru] : []), ...(values.verbose ? ['--verbose'] : [])]);
}

runMain(import.meta.url, main);
