// Inspect and change source-bound board placement rules.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { reseal, verifySeal } from './lib/cad-seal.ts';
import { runMain, UsageError } from './lib/cli.ts';
import { evaluate, nativeGeometry, normalizedRules, reviewedContract, RULE_FIELDS, SCHEMA, type Rule } from './lib/engineering-constraints.ts';
import { holdLock } from './lib/file-lock.ts';
import { atomicJson, readObject } from './lib/json-file.ts';
import { loadPlacementRules, placementRulesPath, placementServices } from './lib/placement-rules.ts';
import { boardConfig } from './lib/pcb-workflow.ts';
import { projectRoot } from './lib/project-root.mjs';
import { withSuffix } from './lib/py-path.ts';

const orderedValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(orderedValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, orderedValue(item)]));
  return value;
};

export function canonicalRules(rules: Rule[]): { schema: string; rules: object[] } {
  return { schema: SCHEMA, rules: [...rules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(rule => {
    const source = rule.source as Record<string, unknown>;
    const ordered: Record<string, unknown> = { ...rule, source: Object.fromEntries(['path', 'sha256', 'page', ...Object.keys(source).filter(key => !['path', 'sha256', 'page'].includes(key)).sort()].filter(key => key in source).map(key => [key, orderedValue(source[key])])) };
    return Object.fromEntries(['id', 'kind', 'source', ...RULE_FIELDS[rule.kind]!].filter(key => key in ordered).map(key => [key, key === 'source' ? ordered[key] : orderedValue((ordered as Record<string, unknown>)[key])]));
  }) };
}

export async function changeRules(root: string, board: string, options: { add?: string; remove?: string; reason?: string }): Promise<void> {
  if (!options.reason?.trim() || Boolean(options.add) === Boolean(options.remove)) throw new Error('choose --add or --remove and give --reason TEXT');
  const lock = await holdLock(join(root, '.gate/cad-seal', `${board}.lock`), { waitS: 5 });
  try {
    verifySeal(root, board);
    const path = placementRulesPath(root, board);
    let rules = existsSync(path) ? loadPlacementRules(root, board).rules : [];
    if (options.add) rules.push(readObject<Rule>(options.add));
    else {
      if (!rules.some(rule => rule.id === options.remove)) throw new Error(`unknown rule: ${options.remove}`);
      rules = rules.filter(rule => rule.id !== options.remove);
    }
    normalizedRules(root, { schema: SCHEMA, rules }, nativeGeometry(withSuffix(boardConfig(root, board).project, '.kicad_pcb')));
    atomicJson(path, canonicalRules(rules));
    reseal(root, board, { tool: 'pcb-constraints', run_id: null }, options.reason.trim());
  } finally { await lock.release(); }
}

function report(root: string, board: string) {
  const path = placementRulesPath(root, board);
  if (!existsSync(path)) return { board, rules: [], measurements: [] };
  const contract = reviewedContract(root, board, path, placementServices as never);
  return { board, rules: contract.rules, ...evaluate(contract, contract.geometry) };
}

async function main(given: string[]): Promise<number> {
  const argv = [...given];
  let root: string | undefined;
  if (argv[0] === '--project') { root = argv[1]; argv.splice(0, 2); }
  else if (argv[0]?.startsWith('--project=')) root = argv.shift()!.slice(10);
  argv.shift();
  const a = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, add: { type: 'string' }, remove: { type: 'string' }, reason: { type: 'string' } } });
  const [board, ...rest] = a.positionals;
  if (!board || rest.length) throw new UsageError('pcb constraints BOARD [--json] [--add SPEC.json | --remove ID] [--reason TEXT]');
  const base = projectRoot(root);
  if (a.values.add || a.values.remove) await changeRules(base, board, a.values);
  else verifySeal(base, board);
  const result = report(base, board);
  if (a.values.json) console.log(JSON.stringify(result));
  else {
    console.log(`${board}: ${result.rules.length} placement rules`);
    for (const rule of result.rules) {
      const measured = result.measurements.find(row => row.id === rule.id);
      console.log(`${rule.id} ${rule.kind}: ${JSON.stringify(measured ?? rule)}`);
    }
  }
  return 0;
}
runMain(import.meta.url, main);
