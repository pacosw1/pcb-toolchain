import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

const CLIENT = new URL('../src/client.ts', import.meta.url).pathname;
const NOT_TAKEN = 76;

/** A daemon that answers every request with `status`, and a project with one board. -> the exit of `pcb-job submit`. */
async function submit(t: TestContext, status: number, args = ['--', 'true']): Promise<{ code: number | null; stderr: string; jobRequests: number }> {
  let jobRequests = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/jobs') jobRequests++;
    req.resume();
    res.statusCode = req.url === '/blobs/missing' ? 404 : status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'fixture answer', id: 'J1' }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const root = mkdtempSync(join(tmpdir(), 'client-exit-'));
  t.after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'toolchain/tools'), { recursive: true });
  mkdirSync(join(root, 'project/B'), { recursive: true });
  writeFileSync(join(root, 'project/B/B.kicad_pcb'), 'x');
  const env = { PATH: process.env.PATH ?? '', JOBD_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, JOBD_TOKEN: 't',
    PCB_TOOLCHAIN_ROOT: join(root, 'toolchain'), IOT_LAB: join(root, 'project') };
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', CLIENT, 'submit', 'B', ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  const code = await new Promise<number | null>(r => child.on('close', r));
  return { code, stderr, jobRequests };
}

test('the client exits 76 only when it proved that the daemon took no job', async t => {
  const refused = await submit(t, 429);
  assert.equal(refused.code, NOT_TAKEN, refused.stderr);
  assert.match(refused.stderr, /429/);
  const unauthorized = await submit(t, 401);
  assert.equal(unauthorized.code, NOT_TAKEN, unauthorized.stderr);
  const usage = await submit(t, 200, ['--bogus', '1', '--', 'true']);
  assert.equal(usage.code, NOT_TAKEN, usage.stderr);
  assert.equal(usage.jobRequests, 0, 'a usage error sends no job request');
});

test('a server error at submit may come after the job record, so the exit stays 2', async t => {
  const failed = await submit(t, 500);
  assert.equal(failed.jobRequests, 1);
  assert.equal(failed.code, 2, failed.stderr);
  assert.match(failed.stderr, /^pcb-job: 500: /m);
});
