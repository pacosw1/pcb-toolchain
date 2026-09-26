// Signal-integrity gates, shared by the board audits. Model: current-paths-check.mjs.
// Three gates: reference planes under high-speed nets, differential-pair rules, and vias in SMD pads.
// check(name, ok, detail) records one result. A tool failure is a failed check (fail closed).

import {execFileSync} from 'node:child_process';

// parseGateOutput is pure: no process spawn, so a test can call it directly with fake output.
// summaryRegex finds the one-line summary. failPrefix marks a failing detail line.
export function parseGateOutput(out, exit, summaryRegex, failPrefix) {
  const lines = out.split('\n');
  const summary = lines.find((line) => summaryRegex.test(line));
  if (!summary) {
    return {ok: false, ran: false, detail: `tool did not run (exit ${exit}): ${out.slice(0, 200)}`};
  }
  const fails = lines.filter((line) => line.startsWith(failPrefix));
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

export function planesCheck({python, tool, pcb, spec, check}) {
  const name = 'reference planes under high-speed nets (reference-planes.json, si_planes.py)';
  const {out, exit} = runGate({python, tool, args: [pcb, spec]});
  const {ok, detail} = parseGateOutput(out, exit, /reference-plane failures/, 'FAIL');
  check(name, ok, detail);
}

export function pairsCheck({python, tool, pcb, spec, check}) {
  const name = 'differential pairs meet impedance and reference-plane rules (diff-pairs.json, si_pairs.py)';
  const {out, exit} = runGate({python, tool, args: [pcb, spec]});
  const {ok, detail} = parseGateOutput(out, exit, /^si_pairs: \d+ PASS, \d+ FAIL/, 'FAIL');
  check(name, ok, detail);
}

// allow: REF.PAD entries where the datasheet land pattern requires a (tented) via in the pad.
export function viaPadsArgs(pcb, allow = []) {
  return ['viapads', pcb, ...(allow.length ? ['--allow', ...allow] : [])];
}

export function viaPadsCheck({python, tool, pcb, check, allow = []}) {
  const name = `no via lands inside an SMD pad (pcbtool.py viapads${allow.length ? `, allowed: ${allow.join(' ')}` : ''})`;
  const {out, exit} = runGate({python, tool, args: viaPadsArgs(pcb, allow)});
  const {ok, detail} = parseGateOutput(out, exit, /vias in SMD pads/, 'FAIL via in pad');
  check(name, ok, detail);
}

// kicad-happy (pinned clone, see tools/kicad_happy_gate.py): return path, return vias, via in pad, decoupling.
export const KICAD_HAPPY_SUMMARY = /kicad-happy findings/;

// exemptFile: JSON list of {rule, net, reason}; a stale entry fails the gate (exit 2).
export function kicadHappyArgs(pcb, exemptFile) {
  return [pcb, ...(exemptFile ? ['--exempt-file', exemptFile] : [])];
}

export function kicadHappyCheck({python, tool, pcb, check, exemptFile}) {
  const name = `kicad-happy GP-001 RP-001 DC-002 UC-001 (tools/kicad_happy_gate.py${exemptFile ? `, exempt: ${exemptFile}` : ''})`;
  const {out, exit} = runGate({python, tool, args: kicadHappyArgs(pcb, exemptFile)});
  const {ok, detail} = parseGateOutput(out, exit, KICAD_HAPPY_SUMMARY, 'FAIL');
  check(name, ok, detail);
}
