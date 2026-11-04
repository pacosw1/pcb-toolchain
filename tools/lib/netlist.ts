// The schematic netlist kicad-cli writes (sch export netlist --format kicadxml), as the net drivers read it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage, TimeoutExpired } from './lean-stage.ts';
import { deadlineAfter, remaining } from './lean-workflow.ts';
import { PyError, strip, tail } from './py-compat.mjs';
import { isFile, textOf } from './py-path.ts';
import { findText, iter, parseXml } from './xml-read.mjs';

const MAC_KICAD_CLI = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';
const EXPORT_SECONDS = 30;

/** Reference, pin number, pin name. */
export type Node = [ref: string, pin: string, name: string];

export interface Netlist {
  /** Reference: MPN, or value when it has no MPN. */
  comps: Map<string, string>;
  values?: Map<string, string>;
  nets: Map<string, Node[]>;
}

export const kicadCli = (env: NodeJS.ProcessEnv = process.env): string =>
  env.KICAD_CLI ?? (process.platform === 'darwin' ? MAC_KICAD_CLI : 'kicad-cli');

/** The pin name of a netlist node: KiCad 10 writes pinfunction as NAME_NUMBER. */
export function pinName(pin: string, pinFunction: string | null | undefined): string {
  const name = pinFunction ?? '';
  const suffix = `_${pin}`;
  return (name.endsWith(suffix) ? name.slice(0, -suffix.length) : name) || pin;
}

const text = (value: string | null): string => strip(value ?? '');

export function parseNetlist(xml: string): Required<Netlist> {
  const root = parseXml(xml);
  const comps = new Map<string, string>();
  const values = new Map<string, string>();
  for (const comp of iter(root, 'comp')) {
    const ref = comp.attributes.get('ref') as string;
    const fields = new Map([...iter(comp, 'field')].map(field => [field.attributes.get('name'), text(field.text)]));
    const value = text(findText(comp, 'value'));
    comps.set(ref, fields.get('MPN') || value);
    values.set(ref, value);
  }
  const nets = new Map<string, Node[]>();
  for (const net of iter(root, 'net')) {
    nets.set(net.attributes.get('name') as string, [...iter(net, 'node')].map(node => {
      const pin = node.attributes.get('pin') as string;
      return [node.attributes.get('ref') as string, pin, pinName(pin, node.attributes.get('pinfunction'))];
    }));
  }
  return { comps, values, nets };
}

/** Runs kicad-cli on the schematic and parses the netlist; at most 30 s, and never past `deadline`. */
export async function exportNetlist(schematic: string, deadline?: number | null): Promise<Required<Netlist>> {
  if (!isFile(schematic)) throw new PyError('OSError', `no schematic ${schematic} (needed for the net drivers)`);
  const bound = deadlineAfter(EXPORT_SECONDS);
  const limit = deadline === undefined || deadline === null ? bound : Math.min(bound, deadline);
  const folder = mkdtempSync(join(tmpdir(), 'netlist-'));
  try {
    const out = join(folder, 'net.xml');
    const result = await runStage([kicadCli(), 'sch', 'export', 'netlist', '--format', 'kicadxml', '-o', out, schematic],
      { stage: 'driver-netlist-export', deadline: limit, stdout: 'pipe', stderr: 'pipe' });
    if (result.returncode !== 0 || !isFile(out)) {
      throw new PyError('OSError', `kicad-cli netlist export failed for ${schematic}: ${tail(strip(result.stderr ?? ''), 300)}`);
    }
    const netlist = parseNetlist(textOf(out));
    if ((remaining(limit) ?? 1) <= 0) throw new TimeoutExpired(['driver-netlist-parse']);
    return netlist;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
