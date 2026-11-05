// pcbtool: reads of a board and its copper, and batch edits from a JSON spec. The agent writes the spec (every position, track
// point, width, layer and via is still chosen by the agent: hand routing, no auto-router), runs one command, reads the summary,
// tweaks the spec and runs again. A read is one entry of COMMANDS; the writing commands are in lib/pcbtool-write.ts.
//
//   tools/pcbtool.ts viapads BOARD [--allow REF.PAD ...] [--filled]    via holes in SMD pads
//   tools/pcbtool.ts paths   BOARD SPEC.json [--limit 4] [--verbose]   widest copper path between power pads >= design current;
//                                                                      every supply net listed or exempt
//   tools/pcbtool.ts drc     BOARD                          DRC --schematic-parity summary
//   tools/pcbtool.ts netcheck BOARD NET                     DRC on a temp copy: one total line + this net only
//   tools/pcbtool.ts corridor BOARD NET [--margin 3] [--cell 0.25] [--pair N] [--box X1 Y1 X2 Y2]  unconnected pad pairs + ASCII free/blocked map
//   tools/pcbtool.ts suggest BOARD NET [--pair N] [--pads A B] [--box X1 Y1 X2 Y2] [--layers F.Cu,B.Cu (+ In2.Cu mixed, slow nets)] [--via-cost 8]
//                            [--k 3] [--margin 3] [--cell 0.1] [--width W] [--return-via-r R] [--probe-thermals] [--max-nodes N] [--planes P] [--verify]
//                                                           A* proposals as connect lines (writes nothing)
//   tools/pcbtool.ts place   BOARD SPEC.json                set positions, then DRC summary
//   tools/pcbtool.ts route   BOARD SPEC.json                add tracks and vias, DRC summary
//   tools/pcbtool.ts unroute BOARD NET [NET ...] [--no-drc] remove the tracks and vias of nets
//   tools/pcbtool.ts widen   BOARD NET W [--layer L] [--box X0 Y0 X1 Y1]   widen the net's thinner tracks, DRC
//   tools/pcbtool.ts connect BOARD INTENT [--planes P]      intent lines to 0/45/90 tracks, class width and via, clearance check
//   tools/pcbtool.ts stitch  BOARD NET [--r 1.0] [--planes P] [--best-effort] [--through-pours NETS] [--via D,DRILL] [--clearance MM]
//   tools/pcbtool.ts art     BOARD SPEC.json                silkscreen art group (waves, circles, lines, texts)
//   tools/pcbtool.ts setcolors BOARD MASK SILK FINISH       write the stackup colours
//
// Place spec:  {"place": {"R1": [x, y, rot]}, "grids": [{"refs": [...], "origin": [x, y], "pitch": [dx, dy], "cols": n, "rot": 0}]}
// Route spec:  {"clear": ["NET"], "routes": [{"net": "VBAT", "width": 1.5, "layer": "F.Cu", "path": [[x, y], [x, y], {"via": [x, y]}, [x, y]]}],
//               "move_vias": [{"net": "GND", "from": [x, y], "to": [x, y]}]}
//   A {"via": [x, y]} point adds a via and changes the layer (F.Cu <-> B.Cu). Segments must be 0/45/90 degrees unless the route has "any_angle": true.
// Intent line: NET REF.PAD -> REF.PAD [layer=F.Cu] [width=0.3|auto] [via=auto|0.6/0.3] [through x,y] [via x,y] ...
//   Waypoints in order; `via x,y` changes the layer. Each leg: half straight, 45 degrees, half straight.
//   A conflict with other-net copper (class clearance, board edge) writes nothing. '#' starts a comment.
// --budget [N] on netcheck, paths, viapads, corridor, suggest: cut the output to N chars (default 2000); the last lines say what was
//   cut. netcheck then lists all the net's items that fit (not 3).
// Coordinates: KiCad mm, Y down.
import { existsSync, readFileSync } from 'node:fs';
import { boardJson } from './lib/board-json.ts';
import { projectOf } from './lib/board-obstacles.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { CommandFailure, parseCommand, runCommand, type Command, type LineKind } from './lib/pcbtool-cli.ts';
import { corridor } from './lib/pcbtool-corridor.ts';
import { drc, netcheck } from './lib/pcbtool-read.ts';
import { suggest } from './lib/pcbtool-suggest.ts';
import { writeCommands } from './lib/pcbtool-write.ts';
import { powerPathReport } from './lib/power-paths.ts';
import { jsonLoad } from './lib/py-compat.mjs';
import { planesPath } from './lib/reference-planes.ts';
import { realSteps, verifyCandidates } from './lib/suggest-verify.ts';
import { schematicNetlist, supplyNets } from './lib/supply-nets.ts';
import { padThermals } from './lib/thermal-spokes.ts';
import { requireThroughVias } from './lib/through-vias.ts';
import { viaPadReport } from './lib/via-pads.ts';

const USAGE = 'usage: tools/pcbtool.ts COMMAND BOARD ...';
const DEFAULT_MAX_NODES = 250_000;

const word = (line: string, index: number): string | null => line.trim().split(/\s+/)[index] ?? null;
const pathKinds: LineKind = line => {
  if (line.startsWith('LOW ')) return ['pairs below current', word(line, 1)];
  if (line.startsWith('OK ')) return ['OK pairs', word(line, 1)];
  if (line.startsWith('MISSING ')) return ['supply nets not covered', word(line, 1)];
  return [null, null];
};
const viaPadKinds: LineKind = line => (line.startsWith('FAIL via in pad') && word(line, 5) !== null ? ['vias in pads', word(line, 5)] : [null, null]);
const netcheckKinds: LineKind = line => {
  if (line.startsWith('  E ') || line.startsWith('  W ')) return ['violations', null];
  return line.startsWith('  U ') ? ['unconnected', null] : [null, null];
};
const suggestKinds: LineKind = line => (/^\d+\) /.test(line) ? ['alternatives', null] : [null, null]);
const corridorKinds: LineKind = line => {
  if (line.startsWith('map ')) return ['maps', null];
  if (/^\s*\d/.test(line)) return ['map rows', null];
  return /^ {2}[A-Za-z?] /.test(line) ? ['pairs', null] : [null, null];
};

const druOf = (pcb: string): string | null => {
  const file = `${pcb.replace(/\.[^./]*$/, '')}.kicad_dru`;
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
};

export const COMMANDS: Record<string, Command> = {
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
  drc: { positionals: [{ name: 'board' }], run: (args, print) => drc(args.board as string, print) },
  netcheck: {
    positionals: [{ name: 'board' }, { name: 'net' }],
    budget: { kind: netcheckKinds, keepLast: false },
    run: (args, print) => netcheck(args.board as string, args.net as string, args.budget as number | null, print),
  },
  corridor: {
    positionals: [{ name: 'board' }, { name: 'net' }],
    options: [{ name: 'margin', type: 'float', fallback: 3 }, { name: 'cell', type: 'float', fallback: 0.25 }, { name: 'pair', type: 'int' }, { name: 'box', type: 'float', count: 4 }],
    budget: { kind: corridorKinds, keepLast: false },
    run: (args, print) => {
      const pcb = args.board as string;
      requireThroughVias(pcb);
      return corridor(boardJson(pcb).board, projectOf(pcb), druOf(pcb), {
        net: args.net as string, margin: args.margin as number, cell: args.cell as number, pair: args.pair as number | null, box: args.box as number[] | null,
      }, print);
    },
  },
  suggest: {
    positionals: [{ name: 'board' }, { name: 'net' }],
    options: [
      { name: 'width', type: 'float' }, { name: 'pads', count: 2 }, { name: 'return-via-r', type: 'float' }, { name: 'probe-thermals', type: 'flag' },
      { name: 'max-nodes', type: 'int', fallback: DEFAULT_MAX_NODES }, { name: 'pair', type: 'int' }, { name: 'box', type: 'float', count: 4 },
      { name: 'layers', fallback: 'F.Cu,B.Cu' }, { name: 'via-cost', type: 'float', fallback: 8 }, { name: 'k', type: 'int', fallback: 3 },
      { name: 'margin', type: 'float', fallback: 3 }, { name: 'cell', type: 'float', fallback: 0.1 }, { name: 'verify', type: 'flag' }, { name: 'planes' },
    ],
    budget: { kind: suggestKinds, keepLast: false },
    run: (args, print) => {
      const pcb = args.board as string;
      const net = args.net as string;
      const planes = planesPath(pcb, args.planes as string | null);
      requireThroughVias(pcb);
      return suggest({
        board: boardJson(pcb).board, project: projectOf(pcb), thermals: padThermals(readFileSync(pcb, 'utf8')),
        verdicts: lines => verifyCandidates(pcb, net, lines, realSteps(planes)),
      }, {
        net, planes, layers: args.layers as string, width: args.width as number | null, pads: args.pads as string[] | null,
        returnViaR: args.return_via_r as number | null, probeThermals: args.probe_thermals as boolean, maxNodes: args.max_nodes as number,
        pair: args.pair as number | null, box: args.box as number[] | null, viaCost: args.via_cost as number, k: args.k as number,
        margin: args.margin as number, cell: args.cell as number, verify: args.verify as boolean,
      }, print);
    },
  },
};

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const write = name === undefined ? undefined : writeCommands[name];
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!write && !command) throw new UsageError(USAGE);
  try {
    if (write) return write(rest);
    return await runCommand(command!, parseCommand(command!, rest, `usage: tools/pcbtool.ts ${name} ...`));
  } catch (error) {
    if (!(error instanceof CommandFailure)) throw error;
    console.error(error.message);
    return 1;
  }
}

runMain(import.meta.url, main);
