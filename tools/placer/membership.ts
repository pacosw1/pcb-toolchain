// Block and component membership from the schematic, before placement (CLAUDE.md 4: blocks and components).
//
//   node --experimental-strip-types --no-warnings tools/placer/membership.ts derive BOARD.kicad_sch BOARD.kicad_pcb -o members.json
//        [--draw OUT.kicad_pcb] [--tighten] [--reference REF.kicad_pcb]
//
// Sources (they exist before placement, so a spread board gets the same answer as a compact one):
//   - Component = the schematic "Group" field of each symbol (the generator writes one group per schematic section: soc, pwr,
//     eth1, ...). Without the field: the bold section title above the symbol.
//   - Block = one IC (ref U, more than 3 pads) plus the passives its datasheet requires, in the same group. A passive (R, C, L, FB,
//     D, Y) joins the IC that its schematic Description names ("U4 VIN 4.7 uF next to pin 4"); else the block with the largest net
//     affinity: sum over its nets (not GND) of 1 / (parts on the net - 1) x (block members on the net). A part with a signal net
//     (RAIL_DEG parts or fewer) ties through its signal nets only (an LED series resistor does not join an IC through the 3.3 V
//     rail); a part on rails only (a decap) ties through the rails. Assignment is greedy, the strongest tie first, so a chain
//     (crystal -> load cap) follows its IC. A part whose Description names a connector of its group and no IC is connector support:
//     not in a block. Connectors, switches, indicator LEDs (Description "LED"), test points and mounting holes are not in a block.
//     A block has 2 or more parts.
//   - Pad nets come from the board (the board nets are the schematic nets: parity 0).
//
// --draw, --tighten: membership-board.ts. --reference: the match of the derived blocks with the User.1 borders of a reference board
// (validation only). `iotplace read --blocks members.json` takes the explicit membership.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { saveBoard } from '../lib/board-edit.ts';
import { boardJson } from '../lib/board-json.ts';
import type { Board } from '../lib/board-types.ts';
import { parseFlags, runMain, UsageError } from '../lib/cli.ts';
import { jsonDumps } from '../lib/py-compat.mjs';
import { drawnBoard, fixedRefs, referenceBlocks } from './membership-board.ts';
import { derive, match, parseSchematic } from './membership-derive.ts';

const USAGE = 'usage: membership.ts derive BOARD.kicad_sch BOARD.kicad_pcb -o members.json [--draw OUT.kicad_pcb] [--tighten] [--reference REF.kicad_pcb]';

export interface Services { board: (pcb: string) => Board; save: typeof saveBoard }

/** `text` as the board at `out`, saved by KiCad 10 with the project of `pcb`. */
function saveCopy(pcb: string, source: string, out: string, save: typeof saveBoard): void {
  if (resolve(pcb) === resolve(out)) throw new Error('--draw writes a copy only: the output must differ from the input board');
  const work = mkdtempSync(join(tmpdir(), 'membership-'));
  try {
    copyFileSync(save(pcb, source, work).board, out);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function main(argv: string[], services: Services = { board: pcb => boardJson(pcb).board, save: saveBoard }): number {
  const options = { output: { type: 'string', short: 'o' }, draw: { type: 'string' }, tighten: { type: 'boolean' }, reference: { type: 'string' } } as const;
  const { values, positionals } = parseFlags(argv, options, USAGE);
  const [command, sch, pcb] = positionals;
  if (command !== 'derive' || !sch || !pcb || positionals.length !== 3 || !values.output) throw new UsageError(USAGE);
  const board = services.board(pcb);
  const members = derive(parseSchematic(readFileSync(sch, 'utf8')).parts, new Map(board.footprints.map(fp => [fp.reference, fp.pads.map(p => p.net)])));
  const held = fixedRefs(board);
  const soft = [...members.blocks].filter(([, refs]) => refs.some(r => held.includes(r))).map(([name]) => name).sort();
  const out = new Map<string, unknown>([...Object.entries(members), ['source', { schematic: resolve(sch), board: resolve(pcb) }], ['fixed', held], ['soft_blocks', soft]]);
  let share: unknown = null;
  if (values.reference) {
    const reference = referenceBlocks(services.board(values.reference));
    const found = match(members.blocks, reference);
    share = found.share;
    out.set('match', { ...found, reference_blocks: reference });
  }
  let tightened = 0;
  if (values.draw) {
    const drawn = drawnBoard(readFileSync(pcb, 'utf8'), board, members, values.tighten ? held : null);
    if (values.tighten) {
      out.set('tightened', drawn.tightened);
      tightened = drawn.tightened.size;
    }
    saveCopy(pcb, drawn.text, values.draw, services.save);
  }
  writeFileSync(values.output, jsonDumps(out, 1));
  console.log(jsonDumps({ blocks: members.blocks.size, soft_blocks: soft, components: members.components.size, match_share: share, tightened }));
  return 0;
}

runMain(import.meta.url, main);
