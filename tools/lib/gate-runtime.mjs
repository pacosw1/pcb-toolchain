import {mkdtempSync, mkdirSync, readFileSync, appendFileSync, openSync, writeSync, closeSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
export function runDirectory(parent) {
  mkdirSync(parent, {recursive: true});
  return mkdtempSync(join(parent, 'run-'));
}

// Single writer (this gate process). Output activity is not proof of progress.
export function gateEvent(dir, type, data = {}) {
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({schema_version: 1, time: new Date().toISOString(), producer:'gate', type, ...data}) + '\n');
}

export function measuredSpan(stage, category) {
  const started = process.hrtime.bigint();
  const fields = {span_id:randomUUID(),stage,category,producer:'gate',started_unix_s:Date.now()/1000};
  return {fields,end:(status='passed')=>({...fields,ended_unix_s:Date.now()/1000,
    duration_s:Number(process.hrtime.bigint()-started)/1e9,duration_source:'producer_monotonic',status})};
}

// A report belongs to this invocation only. Logs are readable before exit;
// the callback's complete output retains the existing parser/failure semantics.
export async function runTool(dir, id, cmd, args) {
  const log = openSync(join(dir, `${id}.log`), 'wx');
  const span=measuredSpan(id,['erc','drc'].includes(id) ? 'kicad' : 'validation');
  gateEvent(dir, 'tool.start', {...span.fields,log: `${id}.log`});
  return new Promise(resolve => {
    const child = execFile(cmd, args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024}, (error, stdout, stderr) => {
      const code = error ? (Number.isInteger(error.code) ? error.code : null) : 0;
      const diagnostic = stderr ?? error?.message ?? '';
      // Both streams are already in the log. Only launch failures without
      // stderr need an extra diagnostic in the exit footer.
      writeSync(log, `\n[exit ${code ?? 'launch failure'}]${code === null && !diagnostic ? ` ${error?.message ?? ''}` : ''}`);
      closeSync(log);
      gateEvent(dir, 'tool.exit', {...span.end(code===0 ? 'passed' : code===null ? 'error' : 'failed'),code,signal: error?.signal ?? null,log: `${id}.log`});
      resolve({stdout: stdout ?? '', stderr: diagnostic, code});
    });
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', text => {
      writeSync(log, text);
      gateEvent(dir, 'tool.output', {stage: id,span_id:span.fields.span_id,stream,bytes: Buffer.byteLength(text),text:text.slice(0,1600),truncated:text.length>1600});
    });
  });
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
