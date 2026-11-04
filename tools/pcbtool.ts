// pcbtool: batch PCB edits from a JSON spec, then one compact DRC summary. The agent writes the spec (every position, track
// point, width, layer and via is still chosen by the agent: hand routing, no auto-router), runs one command, reads the summary,
// tweaks the spec and runs again. The writing commands are in lib/pcbtool-write.ts; a read command joins the table here.
//
//   tools/pcbtool.ts place   BOARD SPEC.json                set positions, then DRC summary
//   tools/pcbtool.ts route   BOARD SPEC.json                add tracks and vias, DRC summary
//   tools/pcbtool.ts unroute BOARD NET [NET ...] [--no-drc] remove the tracks and vias of nets
//   tools/pcbtool.ts widen   BOARD NET W [--layer L] [--box X0 Y0 X1 Y1]   widen the net's thinner tracks, DRC
//   tools/pcbtool.ts connect BOARD INTENT [--planes P]      intent lines to 0/45/90 tracks, class width and via, clearance check
//   tools/pcbtool.ts stitch  BOARD NET [--r 1.0] [--planes P] [--best-effort] [--through-pours NETS] [--via D,DRILL] [--clearance MM]
//   tools/pcbtool.ts art     BOARD SPEC.json                silkscreen art group (waves, circles, lines, texts)
//   tools/pcbtool.ts setcolors BOARD MASK SILK FINISH       write the stackup colours
import { runMain, UsageError } from './lib/cli.ts';
import { writeCommands } from './lib/pcbtool-write.ts';

const commands = { ...writeCommands };

function main([name, ...argv]: string[]): number {
  const command = name === undefined ? undefined : commands[name];
  if (!command) throw new UsageError(`usage: tools/pcbtool.ts {${Object.keys(commands).join(',')}} ...`);
  return command(argv);
}

runMain(import.meta.url, main);
