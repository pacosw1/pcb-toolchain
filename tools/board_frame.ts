// Fast 2D board frame from the DSN/SES text (tools/lib/board-frame.ts), and the timelapse of a run.
//
//   tools/board_frame.ts OUTDIR [--ses FILE] [--dsn FILE] [--out PNG] [--stamp TEXT] [--width 1200]
//       one frame from OUTDIR/board.dsn and OUTDIR/board.ses, with the open connections of OUTDIR/report.json, else
//       OUTDIR/open-triage.json. Default output: OUTDIR/frame.png.
//   tools/board_frame.ts --mp4 OUTDIR [--seconds 60] [--keep]
//       the frames OUTDIR/snapshots/NNNN.png into OUTDIR/timelapse.mp4 with ffmpeg, the whole run in --seconds. The PNG
//       frames are deleted after a good MP4 unless --keep. Without ffmpeg the frames stay and the tool says so (exit 2).
import { parseArgs } from 'node:util';
import { DEFAULT_WIDTH, frame, mp4 } from './lib/board-frame.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { fixed } from './lib/py-compat.mjs';

const USAGE = `usage: tools/board_frame.ts OUTDIR [--ses FILE] [--dsn FILE] [--out PNG] [--stamp TEXT] [--width 1200]
       tools/board_frame.ts --mp4 OUTDIR [--seconds 60] [--keep]`;
const DEFAULT_SECONDS = 60;

function integer(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[+-]?\d+$/.test(value)) throw new UsageError(`${USAGE}\nboard_frame: --${name}: not an integer: ${value}`);
  return Number(value);
}

function options(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        ses: { type: 'string' }, dsn: { type: 'string' }, out: { type: 'string' }, stamp: { type: 'string' },
        width: { type: 'string' }, mp4: { type: 'boolean' }, seconds: { type: 'string' }, keep: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new UsageError(`${USAGE}\nboard_frame: ${(error as Error).message}`);
  }
}

function main(argv: string[]): number {
  const { values, positionals } = options(argv);
  const [outdir] = positionals;
  if (outdir === undefined || positionals.length > 1) throw new UsageError(USAGE);
  const width = integer('width', values.width, DEFAULT_WIDTH);
  const seconds = integer('seconds', values.seconds, DEFAULT_SECONDS);
  if (values.mp4) return mp4(outdir, seconds, values.keep) ? 0 : 2;
  const started = performance.now();
  const { ses, dsn, out, stamp } = values;
  const path = frame(outdir, { ses, dsn, out, stamp, width });
  console.log(`board_frame: ${path} in ${fixed((performance.now() - started) / 1000, 2)} s`);
  return 0;
}

runMain(import.meta.url, main);
