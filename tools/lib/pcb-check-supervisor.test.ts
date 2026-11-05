import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { startCheck } from './pcb-check-start.ts';
import { status } from './pcb-runs.ts';
import { verify } from './pcb-evidence.ts';

const needsBinary = { skip: iotrouteMissing() };
const terminal = new Set(['passed', 'failed', 'error', 'cancelled', 'timeout']);

async function settled(folder: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 300; i++) {
    const state = status(folder);
    if (terminal.has(String(state.get('status'))) && state.get('controller_alive') !== true)
      return JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8')) as Record<string, unknown>;
    await delay(100);
  }
  throw new Error(`check did not settle: ${readFileSync(join(folder, 'worker.log'), 'utf8')}`);
}

function fixture(t: { after(fn: () => void): void }, body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'pcb-check-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'hardware-design/boards/X'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'hardware-design/boards/X/gate.json'), '{"project":"cad/X","checks":{"erc":true}}');
  writeFileSync(join(root, 'tools/gate.mjs'), body);
  return root;
}

const gate = (code: number, end = true) => `
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
const dir=process.argv[process.argv.indexOf('--evidence-dir')+1]; mkdirSync(dir,{recursive:true});
appendFileSync(dir+'/events.jsonl', JSON.stringify({schema_version:1,time:new Date().toISOString(),type:'gate.start'})+'\\n');
${end ? "appendFileSync(dir+'/events.jsonl', JSON.stringify({schema_version:1,time:new Date().toISOString(),type:'gate.end'})+'\\n');" : ''}
writeFileSync(dir+'/result.json',JSON.stringify({exit:${code},changedDuringRun:false,metrics:{erc_errors:${code}},provenance:{input_sha256:'a'.repeat(64),tools:{kicad:'fixture'}},checks:{erc:{status:${JSON.stringify(code ? 'failed' : 'passed')},metrics:{erc_errors:${code}}}}}));
process.exitCode=${code};`;

test('check seals a matching gate only after the owned worker settles', needsBinary, async t => {
  const root = fixture(t, gate(0));
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 1 });
  const result = await settled(folder);
  assert.equal(result.status, 'passed');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
  assert.equal((verify(folder)).get('status'), 'passed');
  assert.equal(JSON.parse(readFileSync(join(folder, 'worker-owner.json'), 'utf8')).cleanup.complete, true);
  assert.ok(readFileSync(join(folder, 'events.jsonl'), 'utf8').includes('"type": "run.end"'));
});

test('check never passes without gate.end', needsBinary, async t => {
  const root = fixture(t, gate(0, false));
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 20, heartbeat: 1 });
  const result = await settled(folder);
  assert.equal(result.status, 'error');
  assert.match(String(result.cause), /terminal evidence disagree/);
});

test('deadline cancels the owned gate and never produces a pass', needsBinary, async t => {
  const root = fixture(t, 'setTimeout(() => {}, 30000);');
  const folder = await startCheck({ root, base: join(root, '.gate/cli'), board: 'X', timeout: 0.5, heartbeat: 0.1 });
  const result = await settled(folder);
  assert.equal(result.status, 'timeout');
  assert.equal((result.cleanup as { complete?: boolean }).complete, true);
  assert.equal(existsSync(join(folder, 'gate/result.json')), false);
});
