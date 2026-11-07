// Ground stitching vias after routing, for each signal net that changes layer (kicad-happy RP-001: a ground via within 1 mm of each
// signal via).
//
//   tools/stitch_all.ts BOARD.kicad_pcb --planes <board>/reference-planes.json [--skip GND,+3V3] [--via D,DRILL] [--clearance MM] [--through-pours NETS]
//
// For each net with a via (not a ground, not a --skip net): tools/pcbtool.ts stitch BOARD NET --best-effort. The board is changed in
// place: run it on the routed copy or on the board of a branch. Prints the vias added and the signal vias with no room. Run DRC and
// the gate after it. Route feature via_halo (tools/route-features.json, learn_noroom): the nets with no room are added to
// <board>/.gate/halo-nets.json; a router that reads it gives their vias the halo padstack.
// A net whose stitch fails (non-zero exit, or no "added N" line) is named as FAILED and the exit code is 1. The report records the options.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardJson } from './lib/board-json.ts';
import { vias } from './lib/board-types.ts';
import { parseFlags, runMain, UsageError } from './lib/cli.ts';
import { TS_NODE } from './lib/env.mjs';
import { readJson } from './lib/json-file.ts';
import { jsonDumps, sorted } from './lib/py-compat.mjs';
import { featureOn, haloFile, learnedHalo, loadFeatures, sourceFingerprint } from './lib/route-features.ts';

const USAGE = 'usage: tools/stitch_all.ts BOARD --planes PLANES [--skip NETS] [--via D,DRILL] [--clearance MM] [--through-pours NETS]';
const PCBTOOL = fileURLToPath(new URL('pcbtool.ts', import.meta.url));

/** What one stitch reported: the vias added and the signal vias with no room. */
export function stitchResult(output: string): { added: number; noRoom: number } {
  const added = Number(output.match(/added (\d+) /)?.[1] ?? 0);
  const missed = output.match(/no room for a \S+ via within [\d.]+ mm of (.*?); best effort/)?.[1];
  return { added, noRoom: missed === undefined ? 0 : missed.split('(').length - 1 };
}

/** True when one net stitch failed: a non-zero exit, or no "added N" line, which the tool prints at the end of every good run. */
export const stitchFailed = (status: number | null, output: string): boolean => status !== 0 || !/added \d+ /.test(output);

export interface StitchTotals { nets: number; added: number; noRoom: number; failed: string[]; options: Record<string, string> }
/** The lines of the final report. A failed net is named, and the options of the run are recorded. */
export const stitchReport = ({ nets, added, noRoom, failed, options }: StitchTotals): string[] => [
  `stitch_all: ${nets} nets, ${added} ground vias added, ${noRoom} signal vias with no room, ${failed.length} failed`,
  `stitch_all: options ${Object.entries(options).map(([name, value]) => `${name}=${value}`).join(' ')}`,
  ...(failed.length ? [`stitch_all: FAILED ${failed.join(', ')}`] : []),
];

/** The nets with a via that are not a ground and not skipped. */
export const netsToStitch = (viaNets: string[], grounds: string[], skip: string): string[] => {
  const left = new Set(viaNets);
  for (const net of [...grounds, ...skip.split(','), '']) left.delete(net);
  return sorted(left) as string[];
};

function main(argv: string[]): number {
  const { values, positionals } = parseFlags(argv, {
    planes: { type: 'string' }, skip: { type: 'string', default: '' }, via: { type: 'string', default: '' },
    clearance: { type: 'string', default: '' }, 'through-pours': { type: 'string', default: '' },
  }, USAGE);
  const [pcb] = positionals;
  if (pcb === undefined || positionals.length !== 1 || values.planes === undefined) throw new UsageError(USAGE);
  const { planes, skip, via, clearance } = values;
  const { grounds = ['GND'] } = readJson<{ grounds?: string[] }>(planes);
  const nets = netsToStitch(vias(boardJson(pcb).board).map(item => item.net), grounds, skip);
  const options = [...(via ? ['--via', via] : []), ...(values['through-pours'] ? ['--through-pours', values['through-pours']] : []), ...(clearance ? ['--clearance', clearance] : [])];
  let added = 0;
  let noRoom = 0;
  const noRoomNets: string[] = [];
  const failed: string[] = [];
  for (const net of nets) {
    const run = spawnSync(process.execPath, [...TS_NODE, PCBTOOL, 'stitch', pcb, net, '--best-effort', '--planes', planes, ...options], { encoding: 'utf8' });
    const result = stitchResult(`${run.stdout}${run.stderr}`);
    if (stitchFailed(run.status, `${run.stdout}${run.stderr}`)) {
      failed.push(net);
      console.log(`FAILED ${net}: exit ${run.status ?? run.error?.message ?? 'none'}: ${`${run.stderr}${run.stdout}`.trim().split('\n').at(-1) ?? ''}`);
      continue;
    }
    added += result.added;
    noRoom += result.noRoom;
    if (result.noRoom) {
      noRoomNets.push(net);
      console.log(`NOROOM ${net}`);   // Retained repair-loop status for nets without a stitch site.
    }
  }
  for (const line of stitchReport({ nets: nets.length, added, noRoom, failed, options: { skip, via, clearance, 'through-pours': values['through-pours'] ?? '' } })) console.log(line);
  const { features, folder } = loadFeatures(pcb);
  if (featureOn(features, 'via_halo') && features.via_halo!.learn_noroom && folder && noRoomNets.length) {
    const file = haloFile(folder);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, jsonDumps({ nets: sorted(new Set([...learnedHalo(pcb, folder), ...noRoomNets])), source_fingerprint: sourceFingerprint(pcb) }, 1));
    console.log(`stitch_all: via_halo learns ${noRoomNets.length} nets -> ${file}`);
  }
  return failed.length ? 1 : 0;
}

runMain(import.meta.url, main);
