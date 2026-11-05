// Signal-integrity gates, shared by the board audits. Model: current-paths-check.mjs.
// Three gates: reference planes under high-speed nets, differential-pair rules, and vias in SMD pads.
// check(name, ok, detail) records one result. A tool failure is a failed check (fail closed).

import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TS_NODE} from './env.mjs';

const PCBTOOL = fileURLToPath(new URL('../pcbtool.ts', import.meta.url));

// parseGateOutput is pure: no process spawn, so a test can call it directly with fake output.
// summaryRegex finds the one-line summary. failPrefix (a string or a list of strings) marks a failing detail line.
export function parseGateOutput(out, exit, summaryRegex, failPrefix) {
  const lines = out.split('\n');
  const summary = lines.find((line) => summaryRegex.test(line));
  if (!summary) {
    return {ok: false, ran: false, detail: `tool did not run (exit ${exit}): ${out.slice(0, 200)}`};
  }
  const prefixes = [failPrefix].flat();
  const fails = lines.filter((line) => prefixes.some((p) => line.startsWith(p)));
  const ok = exit === 0 && fails.length === 0;
  return {ok, ran: true, detail: fails.length ? fails.slice(0, 8).join(' | ') : summary};
}

function runGate({python, tool, args}) {
  let out = '';
  let exit = 0;
  try {
    out = execFileSync(python, [tool, ...args], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (e) {
    out = String(e.stdout ?? '');
    exit = e.status ?? 1;
  }
  return {out, exit};
}

// Callers may still name the old Python tool. The check runs the TypeScript wrapper next to it, which runs iotroute.
const wrapperGate = (tool, args) => runGate({python: process.execPath, tool: TS_NODE[0], args: [...TS_NODE.slice(1), tool.replace(/\.py$/, '.ts'), ...args]});

export function planesCheck({tool, pcb, spec, check}) {
  const name = 'reference planes under high-speed nets (reference-planes.json, si_planes.ts)';
  const {out, exit} = wrapperGate(tool, [pcb, spec]);
  const {ok, detail} = parseGateOutput(out, exit, /reference-plane failures/, 'FAIL');
  check(name, ok, detail);
}

export function pairsCheck({tool, pcb, spec, check}) {
  const name = 'differential pairs meet impedance and reference-plane rules (diff-pairs.json, si_pairs.ts)';
  const {out, exit} = wrapperGate(tool, [pcb, spec]);
  const {ok, detail} = parseGateOutput(out, exit, /^si_pairs: \d+ PASS, \d+ FAIL/, 'FAIL');
  check(name, ok, detail);
}

// allow: REF.PAD entries where the datasheet land pattern requires a (tented) via in the pad.
export function viaPadsArgs(pcb, allow = []) {
  return ['viapads', pcb, ...(allow.length ? ['--allow', ...allow] : [])];
}

export function viaPadsCheck({pcb, check, allow = []}) {
  const name = `no via lands inside an SMD pad (pcbtool.ts viapads${allow.length ? `, allowed: ${allow.join(' ')}` : ''})`;
  const {out, exit} = runGate({python: process.execPath, tool: TS_NODE[0], args: [...TS_NODE.slice(1), PCBTOOL, ...viaPadsArgs(pcb, allow)]});
  const {ok, detail} = parseGateOutput(out, exit, /vias in SMD pads/, 'FAIL via in pad');
  check(name, ok, detail);
}

// kicad-happy (pinned clone, see tools/kicad_happy_gate.ts): return path, return vias, via in pad, decoupling.
export const KICAD_HAPPY_SUMMARY = /kicad-happy findings/;
// A finding line, or an exemption that matched no finding (the tool exits 2).
export const KICAD_HAPPY_FAIL = ['FAIL', 'STALE exempt'];

// exemptFile: JSON list of {rule, net, reason}; a stale entry fails the gate (exit 2).
export function kicadHappyArgs(pcb, exemptFile, grounds = []) {
  return [pcb, ...(exemptFile ? ['--exempt-file', exemptFile] : []), ...grounds.flatMap((g) => ['--ground', g])];
}

export function kicadHappyCheck({tool, pcb, check, exemptFile, grounds}) {
  const name = `kicad-happy GP-001 RP-001 DC-002 UC-001 (tools/kicad_happy_gate.ts${exemptFile ? `, exempt: ${exemptFile}` : ''})`;
  const {out, exit} = wrapperGate(tool, kicadHappyArgs(pcb, exemptFile, grounds));
  const {ok, detail} = parseGateOutput(out, exit, KICAD_HAPPY_SUMMARY, KICAD_HAPPY_FAIL);
  check(name, ok, detail);
}

// Port labels (tools/port_labels.ts): a F.SilkS name at each connector pin and a title.
// The tool reads <board>/port-labels.json (exemptions with a reason); a stale exemption fails.
export const PORT_LABELS_SUMMARY = /^port_labels: \d+ connectors/;
export const PORT_LABELS_FAIL = ['FAIL', 'STALE exempt'];

export function portLabelsCheck({python, tool, pcb, check}) {
  const name = 'connector port labels on F.SilkS (tools/port_labels.ts, port-labels.json)';
  const {out, exit} = runGate({python, tool, args: [pcb]});
  const {ok, detail} = parseGateOutput(out, exit, PORT_LABELS_SUMMARY, PORT_LABELS_FAIL);
  check(name, ok, detail);
}
