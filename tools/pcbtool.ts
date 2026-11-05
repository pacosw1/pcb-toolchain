// pcbtool: reads of a board and its copper, and batch edits from a JSON spec. The agent writes the spec (every position, track
// point, width, layer and via is still chosen by the agent: hand routing, no auto-router), runs one command, reads the summary,
// tweaks the spec and runs again. A read is one entry of COMMANDS; the writing commands are in lib/pcbtool-write.ts.
//
//   tools/pcbtool.ts viapads BOARD [--allow REF.PAD ...] [--filled]    via holes in SMD pads
//   tools/pcbtool.ts paths   BOARD SPEC.json [--limit 4] [--verbose]   widest copper path between power pads >= design current;
//                                                                      every supply net listed or exempt
//   tools/pcbtool.ts place   BOARD SPEC.json                set positions, then DRC summary
//   tools/pcbtool.ts route   BOARD SPEC.json                add tracks and vias, DRC summary
//   tools/pcbtool.ts unroute BOARD NET [NET ...] [--no-drc] remove the tracks and vias of nets
//   tools/pcbtool.ts widen   BOARD NET W [--layer L] [--box X0 Y0 X1 Y1]   widen the net's thinner tracks, DRC
//   tools/pcbtool.ts connect BOARD INTENT [--planes P]      intent lines to 0/45/90 tracks, class width and via, clearance check
//   tools/pcbtool.ts stitch  BOARD NET [--r 1.0] [--planes P] [--best-effort] [--through-pours NETS] [--via D,DRILL] [--clearance MM]
//   tools/pcbtool.ts art     BOARD SPEC.json                silkscreen art group (waves, circles, lines, texts)
//   tools/pcbtool.ts setcolors BOARD MASK SILK FINISH       write the stackup colours
//
// --budget [N] on paths and viapads: cut the output to N chars (default 2000); the last lines say what was cut.
// Coordinates: KiCad mm, Y down.
import { boardJson } from './lib/board-json.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { CommandFailure, parseCommand, runCommand, type Command, type LineKind } from './lib/pcbtool-cli.ts';
import { writeCommands } from './lib/pcbtool-write.ts';
import { powerPathReport } from './lib/power-paths.ts';
import { jsonLoad } from './lib/py-compat.mjs';
import { schematicNetlist, supplyNets } from './lib/supply-nets.ts';
import { requireThroughVias } from './lib/through-vias.ts';
import { viaPadReport } from './lib/via-pads.ts';

const USAGE = 'usage: tools/pcbtool.ts COMMAND BOARD ...';

const word = (line: string, index: number): string | null => line.trim().split(/\s+/)[index] ?? null;
const pathKinds: LineKind = line => {
  if (line.startsWith('LOW ')) return ['pairs below current', word(line, 1)];
  if (line.startsWith('OK ')) return ['OK pairs', word(line, 1)];
  if (line.startsWith('MISSING ')) return ['supply nets not covered', word(line, 1)];
  return [null, null];
};
const viaPadKinds: LineKind = line => (line.startsWith('FAIL via in pad') && word(line, 5) !== null ? ['vias in pads', word(line, 5)] : [null, null]);

const COMMANDS: Record<string, Command> = {
  viapads: {
    positionals: [{ name: 'board' }],
    options: [{ name: 'allow', count: 'any', fallback: [] }, { name: 'filled', type: 'flag' }],
    budget: { kind: viaPadKinds, keepLast: true },
    run: (args, print) => viaPadReport(boardJson(args.board as string).board, args.allow as string[], args.filled as boolean, print),
  },
  paths: {
    positionals: [{ name: 'board' }, { name: 'spec' }],
    options: [{ name: 'limit', type: 'int', fallback: 4 }, { name: 'verbose', type: 'flag' }],
    budget: { kind: pathKinds, keepLast: true },
    run: (args, print) => {
      const pcb = args.board as string;
      const spec = jsonLoad(args.spec as string);
      requireThroughVias(pcb);
      return powerPathReport(boardJson(pcb, { refill: true }).board, spec, {
        limit: args.limit as number, verbose: args.verbose as boolean, print, supplies: () => supplyNets(schematicNetlist(pcb)),
      });
    },
  },
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const write = name === undefined ? undefined : writeCommands[name];
  if (write) return write(rest);
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command) throw new UsageError(USAGE);
  try {
    return await runCommand(command, parseCommand(command, rest, `usage: tools/pcbtool.ts ${name} ...`));
  } catch (error) {
    if (!(error instanceof CommandFailure)) throw error;
    console.error(error.message);
    return 1;
  }
}

runMain(import.meta.url, main);
