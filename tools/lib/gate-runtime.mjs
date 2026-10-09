import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
export function runDirectory(parent) {
  mkdirSync(parent, {recursive: true});
  return mkdtempSync(join(parent, 'run-'));
}

// A report belongs to this invocation only. No shared JSON is used as fallback.
export async function runTool(dir, id, cmd, args) {
  let stdout = '', stderr = '', code = null;
  try {
    const result = await run(cmd, args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
    ({stdout, stderr} = result);
    code = 0;
  } catch (e) {
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? e.message;
    code = Number.isInteger(e.code) ? e.code : null;
  }
  writeFileSync(join(dir, `${id}.log`), `${stdout}\n[exit ${code ?? 'launch failure'}] ${stderr}`);
  return {stdout, stderr, code};
}

export function readReport(file, kind, result) {
  if (result.code !== 0) return null; // KiCad is called without --exit-code-violations.
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const violations = (v) => Array.isArray(v) && v.every(x => x && ['error', 'warning', 'info', 'exclusion'].includes(x.severity));
    if (kind === 'erc') {
      if (!Array.isArray(d.sheets) || !d.sheets.length || !d.sheets.every(s => violations(s.violations))) return null;
    } else if (!violations(d.violations) || !Array.isArray(d.schematic_parity) || !Array.isArray(d.unconnected_items)) return null;
    return d;
  } catch { return null; }
}

export function checkedText(result) {
  // These checkers use 1 for findings. A traceback/launch failure must never
  // supply an apparently successful count emitted before the crash.
  if (![0,1].includes(result.code) || /Traceback|SyntaxError|ModuleNotFoundError/.test(result.stderr + result.stdout) || (result.code===1 && result.stderr.trim())) return '';
  return result.stdout + (result.code===1 ? '\n[gate-check-exit:1]' : '');
}

export function readHappyResult(file, result) {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const count = n => Number.isSafeInteger(n) && n >= 0;
    if(d.schema_version !== 1 || d.completed !== true || !count(d.findings) || !count(d.stale_exemptions)) return null;
    const expectedExit = d.stale_exemptions ? 2 : d.findings ? 1 : 0;
    if(result.code !== expectedExit || d.exit !== expectedExit) return null;
    return d.findings + d.stale_exemptions;
  } catch { return null; }
}
