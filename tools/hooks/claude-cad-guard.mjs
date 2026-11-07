#!/usr/bin/env node
// Claude Code PreToolUse hook for the CAD seal (tools/PCB-CLI.md, "CAD seal").
// Denies a direct edit of board CAD under hardware-design/ and asks a person before `pcb seal ... --accept`.
// Asks a person before an edit of gate.json or a check data file of a board (they are under the seal).
// Asks a person before an edit of a release approval file and before `pcb release-approval ... --approve`.
// Asks a person before `pcb layout ... --approve` and before an edit of a board layout-plan.json.
// Asks a person before an edit of registry/boards.json that writes design_contract_exempt or layout_plan_exempt.
// Standalone on purpose: no imports from tools/lib. It fails open for input it cannot read, so it never blocks an unrelated tool.
import {readFileSync} from 'node:fs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CAD_FILE = /(?:\.kicad_(pcb|sch|pro|dru)|\/placement-constraints\.json)$/;
const GATE_DATA_FILE = /\/hardware-design\/boards\/[^/]+\/(?:gate|reference-planes|diff-pairs|current-paths|rf-lines)\.json$/;
const RELEASE_RECORD_FILE = /\/hardware-design\/boards\/[^/]+\/release-approval[.\w-]*$/;
const EXEMPTION = /(?:design_contract|layout_plan)_exempt/;
const EXEMPTION_REASON = 'A person must decide an exemption from the design contract or the layout plan: with it, tools/pcb place and route run with no contract or no approved plan.';

const decision = (permissionDecision, permissionDecisionReason) => JSON.stringify({
  hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason},
});

export function guard(input) {
  const tool = input?.tool_name, args = input?.tool_input ?? {};
  if (EDIT_TOOLS.has(tool)) {
    const path = String(args.file_path ?? args.notebook_path ?? '').replaceAll('\\', '/');
    if (CAD_FILE.test(path) && path.includes('hardware-design/')) {
      return decision('deny', 'Board CAD changes only through tools/pcb: a direct edit breaks the CAD seal. Use the tools/pcb commands, or ask a person to edit in KiCad and run tools/pcb seal BOARD --accept --reason TEXT.');
    }
    if (GATE_DATA_FILE.test(path)) {
      return decision('ask', 'A person must approve a change of gate.json or a check data file: it is under the CAD seal, and a change can weaken the gate. Then run tools/pcb seal BOARD --accept --reason TEXT.');
    }
    if (RELEASE_RECORD_FILE.test(path)) {
      return decision('ask', 'A person must approve a change of a release approval record: it shows who approved the release.');
    }
    if (path.endsWith('/layout-plan.json') && path.includes('hardware-design/boards/')) {
      return decision('ask', 'A person must approve a change of the layout plan: it holds the approval that lets tools/pcb place and route run.');
    }
    const added = [args.content, args.new_string, ...(Array.isArray(args.edits) ? args.edits.map(edit => edit?.new_string) : [])].map(String).join('\n');
    if (path.endsWith('/hardware-design/registry/boards.json') && EXEMPTION.test(added)) return decision('ask', EXEMPTION_REASON);
  } else if (tool === 'Bash') {
    const command = String(args.command ?? '');
    if (command.includes('registry/boards.json') && EXEMPTION.test(command)) return decision('ask', EXEMPTION_REASON);
    if (/\bpcb\b[^\n;&|]*\blayout\b/.test(command) && /--approve\b/.test(command)) return decision('ask', 'A person must approve the layout plan: tools/pcb layout --approve lets place and route run on the current rules and route plan.');
    if (/\bpcb\b[^\n;&|]*\bconstraints\b/.test(command) && /--(?:add|remove)\b/.test(command)) return decision('ask', 'Approve the board placement rule change and its reason.');
    if (/\bpcb\b[^\n;&|]*\brelease-approval\b/.test(command) && /--approve\b/.test(command)) return decision('ask', 'A person must approve the release: tools/pcb release-approval --approve records the G5 approval of the candidate.');
    if (command.includes('pcb seal') && command.includes('--accept')) {
      return decision('ask', 'A person must approve an accepted CAD edit: tools/pcb seal --accept records the current CAD as the sealed state.');
    }
  }
  return null;
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
  if (input === null || typeof input !== 'object') throw new Error('hook input is not a JSON object');
} catch (error) {
  console.error(`claude-cad-guard: cannot read hook input, no decision: ${error.message}`);
  process.exit(0);
}
const out = guard(input);
if (out) process.stdout.write(`${out}\n`);
