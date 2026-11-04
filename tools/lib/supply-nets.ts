// Which nets of a schematic are supplies, so that a current-paths spec cannot leave one out.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kicadCli } from './env.mjs';
import { CommandFailure } from './pcbtool-cli.ts';
import { sorted, strip } from './py-compat.mjs';

// JLC/EasyEDA bridge symbols have pin type "unspecified", so the pin name and the net name also mark a supply.
const SUPPLY_PIN = /^([AD]?V(CC|DD|IN|BUS|BAT|P|S|SYS|OUT)\d*|\d+V\d+O?|IN|OUT)$/;
const SUPPLY_NET = /(^|[_/+])(\d+V\d*[A-Z]?|[AD]?V(CC|DD|IN|BUS|BAT|SYS)[A-Z0-9]*)(_|$)/;

const beforeLast = (text: string, separator: string): string => {
  const at = text.lastIndexOf(separator);
  return at < 0 ? text : text.slice(0, at);
};
const allOf = (body: string, pattern: RegExp): string[] => [...body.matchAll(pattern)].map(match => match[1]!);

function supplyReason(leaf: string, body: string): string {
  const netClass = body.match(/\(class "([^"]*)"/)?.[1] ?? '';
  const types = sorted(new Set(allOf(body, /\(pintype "([a-z_]+)/g).filter(type => type === 'power_in' || type === 'power_out')));
  const pins = sorted(new Set(allOf(body, /\(pinfunction "([^"]*)"/g).map(pin => beforeLast(pin, '_')).filter(pin => SUPPLY_PIN.test(pin))));
  return [
    ...(types.length ? [`pin type ${types.join('/')}`] : []),
    ...(netClass.includes('POWER') || netClass.includes('PWR') ? [`class ${netClass}`] : []),
    ...(pins.length ? [`pin ${pins.join('/')}`] : []),
    ...(SUPPLY_NET.test(leaf) ? ['net name'] : []),
  ].join(', ');
}

/**
 * The supply nets of a kicad-cli kicadsexpr netlist with why: a power_in/power_out pin, a net class with POWER or PWR in the name,
 * a supply pin name (bridge style NAME_NUMBER) or a voltage/supply net name. Ground nets and unconnected-(...) pad nets are not supplies.
 */
export function supplyNets(netlist: string): Map<string, string> {
  const text = netlist.split(/\s+/).filter(Boolean).join(' ');
  const start = text.indexOf('(nets');
  if (start < 0) throw new Error('netlist has no nets');
  const supplies = new Map<string, string>();
  for (const body of text.slice(start).split('(net (code').slice(1)) {
    const name = body.match(/\(name "([^"]*)"/)?.[1];
    if (name === undefined) throw new Error('netlist net has no name');
    const leaf = name.slice(name.lastIndexOf('/') + 1);
    if (leaf.toUpperCase().includes('GND') || name.startsWith('unconnected-')) continue;
    const why = supplyReason(leaf, body);
    if (why) supplies.set(name, why);
  }
  return supplies;
}

export interface ExemptNet { net: string; reason: string }

/** The supply nets that are neither in the spec nets nor exempt, by name. Each exemption needs a reason. */
export function uncoveredSupplies(supplies: ReadonlyMap<string, string>, specNets: ReadonlySet<string>, exempt: readonly ExemptNet[]): [string, string][] {
  for (const item of exempt) if (strip(item.reason) === '') throw new Error(`exempt net ${item.net} has no reason`);
  const excused = new Set(exempt.map(item => item.net));
  return [...supplies].filter(([net]) => !specNets.has(net) && !excused.has(net)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The kicadsexpr netlist of the .kicad_sch next to a board. A failed export stops the check. */
export function schematicNetlist(pcb: string): string {
  const sch = pcb.replace(/\.[^./]*$/, '') + '.kicad_sch';
  const folder = mkdtempSync(join(tmpdir(), 'pcbtool-netlist-'));
  try {
    const out = join(folder, 'n.net');
    const run = spawnSync(kicadCli, ['sch', 'export', 'netlist', '--format', 'kicadsexpr', '-o', out, sch], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
    if (run.status !== 0 || !existsSync(out)) throw new CommandFailure(`netlist export of ${sch} failed (exit ${run.status}): ${strip(run.stderr ?? '').slice(0, 200)}`);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
