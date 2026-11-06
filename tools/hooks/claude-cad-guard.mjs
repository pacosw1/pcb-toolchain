#!/usr/bin/env node
// Claude Code PreToolUse hook for the CAD seal (tools/PCB-CLI.md, "CAD seal").
// Denies a direct edit of board CAD under hardware-design/ and asks a person before `pcb seal ... --accept`.
// Standalone on purpose: no imports from tools/lib. It fails open for input it cannot read, so it never blocks an unrelated tool.
import {readFileSync} from 'node:fs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CAD_FILE = /\.kicad_(pcb|sch|pro|dru)$/;

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
  } else if (tool === 'Bash') {
    const command = String(args.command ?? '');
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
