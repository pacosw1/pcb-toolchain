// Design blocks and boards: live parsers and a local viewer. Nothing generated is stored in the repo.
//
//   tools/blocks.ts serve [--port 8765]      viewer on http://127.0.0.1:8765
//   tools/blocks.ts check [ID ...]           parts, datasheets and facts of blocks; exit 1 on an error
//   tools/blocks.ts new ID "description" "keywords"   empty block folder (KiCad-native)
//   tools/blocks.ts find "USB" [--mpn MPN]   retrieve candidates without qualifying them
//   tools/blocks.ts reuse ID                 inspect a fingerprinted reuse proposal
//   tools/blocks.ts inventory BOARD          native block identities and binding failures
//   tools/blocks.ts bind ID TARGET --instance PATH [--output NEW_FILE]   draft binding only
//   tools/blocks.ts native ID --output DIR  fresh standalone ERC/DRC/parity evidence
//   tools/blocks.ts qualify ID --binding FILE --evidence FILE --output FILE
//   tools/blocks.ts status RECEIPT           recheck source-bound qualification
//
// Sources of truth (read at request time, never copied):
//   hardware-design/blocks/iot-lab.kicad_blocks/<ID>.kicad_block/
//       <ID>.kicad_sch, <ID>.kicad_pcb, <ID>.json   KiCad 10 design block (json: description, keywords, fields)
//       <ID>.kicad_pro, <ID>.kicad_dru              test-bed project: net classes and rules for DRC
//       facts.json                                  what no parser can derive: validation level, datasheet
//                                                   layout rules with their source (file + page)
//   hardware-design/boards/<B>/cad/<B>/<B>.kicad_pcb/.kicad_sch     boards
//   hardware-design/registry/datasheets/<file>.pdf + .source.json   datasheets (sha256 checked live)
//   hardware-design/registry/evidence/<date>/<C-number>.json        dated JLC catalog snapshots
// Declared facts levels remain historical. Qualification receipts derive levels: 0 = draft/stale, 1 = source and
// target gates plus applicability reviews, 2 = attributable measured bring-up evidence on that exact target instance.
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { kicadMeta } from './lib/block-parts.ts';
import { bindInstance } from './lib/block-bindings.ts';
import { inventory, native, qualify, reuseQualified, status, type NativeTools } from './lib/block-qualification.ts';
import { find, reuse, targetPlan, type TargetPlan } from './lib/block-reuse.ts';
import { serve } from './lib/block-server.ts';
import { detail, items, layoutOf, type Layout } from './lib/block-sources.ts';
import { errorText, runMain } from './lib/cli.ts';
import { readPyJson } from './lib/json-file.ts';
import { runStage } from './lib/lean-stage.ts';
import { deadlineAfter, remaining } from './lib/lean-workflow.ts';
import { kicadCli } from './lib/netlist.ts';
import { pyFloat } from './lib/py-numbers.ts';
import { which } from './lib/py-path.ts';
import { jsonDumps, parseArgs, pyStr, SystemExit } from './lib/py-compat.mjs';
import { projectRoot } from './lib/project-root.mjs';
import { isDict, type Dict } from './lib/py-values.ts';

const PROG = 'blocks.ts';
const COMMANDS = ['serve', 'check', 'new', 'find', 'reuse', 'plan', 'bind', 'inventory', 'native', 'qualify', 'status'];
const option = (flag: string, required = false) => ({ flag, required });

function cmdCheck(layout: Layout, ids: string[]): number {
  let bad = false;
  for (const { kind, id } of items(layout)) {
    if (kind !== 'block' || (ids.length && !ids.includes(id))) continue;
    const row = detail(layout, kind, id) as Dict;
    const errors = [...row.part_errors as string[], ...row.fact_errors as string[]];
    const count = (row.bom as { qty: number }[]).reduce((total, line) => total + line.qty, 0);
    const level = (row.facts as Dict).level;
    const used = (row.used_in as string[]).join(', ') || 'none';
    console.log(`${id}: level ${level === undefined ? '?' : pyStr(level)}, ${count} parts, used in ${used}, ${errors.length} errors`);
    for (const error of errors) console.log(`  ${error}`);
    bad ||= errors.length > 0;
  }
  return bad ? 1 : 0;
}

function cmdNew(layout: Layout, id: string, description: string, keywords: string): number {
  const folder = join(layout.lib, `${id}.kicad_block`);
  if (existsSync(folder)) {
    console.error(`blocks: ${folder} exists`);
    return 1;
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), kicadMeta(description, keywords));
  writeFileSync(join(folder, 'facts.json'), `${jsonDumps({ level: 0, layout_rules: [] }, 1)}\n`);
  console.log(`blocks: new ${folder}; add ${id}.kicad_sch/.kicad_pcb/.kicad_pro/.kicad_dru`);
  return 0;
}

/** A qualification command prints one JSON report and a one-line PASS or FAIL. */
function qualificationResult(result: Dict): number {
  console.log(jsonDumps(result, 2));
  const failed = result.status === 'error' || result.status === 'stale';
  console.error((failed ? 'FAIL: ' : 'PASS: ') + String(result.cause ?? result.qualification ?? 'block command completed'));
  return failed ? 1 : 0;
}

function writeReceipt(output: string, result: unknown): void {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${jsonDumps(result, 2)}\n`, { flag: 'wx' });
}

function qualification(command: string, argv: string[], root: string, { lib }: Layout): number {
  const prog = `${PROG} ${command}`;
  try {
    if (command === 'inventory') return qualificationResult(inventory(root, lib, parseArgs({ prog, positionals: ['board'], options: [] }, argv).board));
    if (command === 'status') return qualificationResult(status(parseArgs({ prog, positionals: ['receipt'], options: [] }, argv).receipt));
    const args = parseArgs({ prog, positionals: ['id'], options: [option('--binding', true), option('--evidence', true), option('--output', true), option('--bench')] }, argv);
    if (existsSync(args.output)) throw new Error('qualification receipt already exists; use a new output path');
    const result = qualify(lib, args.id, args.binding, args.evidence, root, args.bench);
    writeReceipt(args.output, result);
    return qualificationResult(result);
  } catch (error) {
    if (error instanceof SystemExit) throw error;
    const cause = errorText(error);
    console.log(jsonDumps({ status: 'error', level: 0, qualification: 'draft', cause }));
    console.error(`FAIL: block qualification: ${cause}`);
    return 2;
  }
}

/** Fresh evidence only: the owned runner rejects timeout or uncertain cleanup. */
async function nativeQualification(argv: string[], { lib }: Layout): Promise<number> {
  try {
    const args = parseArgs({ prog: `${PROG} native`, positionals: ['id'], options: [option('--output', true), { flag: '--timeout', fallback: '600' }] }, argv);
    const timeout = pyFloat(args.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('native timeout must be finite and positive');
    const row = reuse(lib, args.id);
    const binary = which(kicadCli());
    if (!binary) throw new Error('KiCad CLI unavailable; set KICAD_CLI');
    const deadline = deadlineAfter(timeout);
    const tools: NativeTools = {
      binary,
      remaining: () => remaining(deadline) ?? 0,
      version: async (binary, seconds) => {
        if (seconds <= 0) throw new Error('native deadline reached');
        const versionDeadline = Math.min(deadline, deadlineAfter(seconds));
        const result = await runStage([binary, '--version'], { stage: 'block native version', deadline: versionDeadline, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
        if (result.returncode !== 0) throw new Error(`native version probe failed (exit ${result.returncode})`);
        return result.stdout ?? '';
      },
      runOwned: async (command, options) => {
        const log = openSync(options.log, 'w');
        try {
          const result = await runStage(command, { stage: options.label, cwd: options.cwd, deadline, stdin: 'ignore', stdout: log, stderr: log });
          // runStage returns only after the broker has confirmed cleanup.
          return { returncode: result.returncode, cleanup: { complete: true }, settled: true };
        } finally { closeSync(log); }
      },
    };
    return qualificationResult(await native(row.source_directory, args.output, tools));
  } catch (error) {
    if (error instanceof SystemExit) throw error;
    const cause = errorText(error);
    console.log(jsonDumps({ status: 'error', level: 0, qualification: 'draft', cause }));
    console.error(`FAIL: block qualification: ${cause}`);
    return 2;
  }
}

function retrieved(command: string, argv: string[], { lib }: Layout): { result: unknown; verified: boolean } {
  const prog = `${PROG} ${command}`;
  if (command === 'find') {
    const args = parseArgs({ prog, positionals: ['query'], options: [option('--mpn'), option('--footprint')] }, argv);
    return { result: find(lib, args.query, args.mpn, args.footprint), verified: false };
  }
  if (command === 'reuse') {
    const args = parseArgs({ prog, positionals: ['id'], options: [option('--expect-sha256'), option('--receipt')] }, argv);
    const result = args.receipt ? reuseQualified(lib, args.id, args.expect_sha256, args.receipt) : reuse(lib, args.id, args.expect_sha256);
    return { result, verified: Boolean(args.receipt) };
  }
  if (command === 'bind') {
    const args = parseArgs({ prog, positionals: ['id', 'target'], options: [option('--instance', true), option('--output')] }, argv);
    const result = bindInstance(reuse(lib, args.id).source_directory, args.target, args.instance);
    if (args.output) writeReceipt(args.output, result);
    return { result, verified: false };
  }
  const args = parseArgs({ prog, positionals: ['id', 'target_manifest'], options: [option('--mapping')] }, argv);
  const mapping = args.mapping ? readPyJson<unknown>(args.mapping) : null;
  if (mapping !== null && !isDict(mapping)) throw new Error('mapping must be a plan object');
  return { result: targetPlan(lib, args.id, args.target_manifest, mapping as TargetPlan | null), verified: false };
}

function retrieval(command: string, argv: string[], layout: Layout): number {
  try {
    const { result, verified } = retrieved(command, argv, layout);
    console.log(jsonDumps(result, 2));
    console.error(verified ? 'PASS: qualification verified for the recorded target instance only' : 'PASS: discovery only; target qualification still required');
    return 0;
  } catch (error) {
    if (error instanceof SystemExit) throw error;
    console.error(`FAIL: block retrieval: ${errorText(error)}`);
    return 1;
  }
}

function dispatch(argv: string[]): number | Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command)) {
    const choices = COMMANDS.map(name => `'${name}'`).join(', ');
    console.error(`usage: ${PROG} [-h] {${COMMANDS.join(',')}} ...`);
    console.error(command ? `${PROG}: error: argument cmd: invalid choice: '${command}' (choose from ${choices})` : `${PROG}: error: the following arguments are required: cmd`);
    return 2;
  }
  const root = projectRoot();
  const layout = layoutOf(root);
  if (command === 'native') return nativeQualification(rest, layout);
  if (['inventory', 'qualify', 'status'].includes(command)) return qualification(command, rest, root, layout);
  if (['find', 'reuse', 'plan', 'bind'].includes(command)) return retrieval(command, rest, layout);
  if (command === 'serve') {
    const args = parseArgs({ prog: `${PROG} serve`, positionals: [], options: [{ flag: '--port', type: 'int', fallback: 8765n }] }, rest);
    return serve(root, Number(args.port));
  }
  if (command === 'check') return cmdCheck(layout, rest);
  const args = parseArgs({ prog: `${PROG} new`, positionals: ['id', 'description', 'keywords'], options: [] }, rest);
  return cmdNew(layout, args.id, args.description, args.keywords);
}

async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (error) {
    if (error instanceof SystemExit) return error.code;
    throw error;
  }
}

runMain(import.meta.url, main);
