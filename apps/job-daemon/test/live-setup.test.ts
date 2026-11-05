import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const setup = path.resolve('..', '..', 'tools/pcb-live-setup.mts');
const guard = path.resolve('..', '..', 'tools/pcb-live-guard.mts');
const node = process.execPath;
test('registers all worktrees without overwriting another coordinator', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-live-setup-'))), root = path.join(tmp, 'project'), other = path.join(tmp, 'other');
  try {
    fs.mkdirSync(root); assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
    assert.equal(spawnSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'test']).status, 0);
    assert.equal(spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '--detach', other]).status, 0);
    const token = path.join(tmp, 'token'), config = path.join(tmp, 'config.json'); fs.writeFileSync(token, 'x'.repeat(40), { mode: 0o600 });
    const args = ['--experimental-strip-types', '--no-warnings', setup, '--project', root, '--project-id', 'project', '--url', 'http://127.0.0.1:1234', '--token-file', token, '--config', config];
    const run = () => spawnSync(node, args, { encoding: 'utf8' });
    assert.equal(run().status, 0);
    const contents = fs.readFileSync(config, 'utf8'), parsed = JSON.parse(contents) as { projects: Record<string, string> };
    assert.equal(parsed.projects[fs.realpathSync(path.join(root, '.git'))], 'project');
    const registered = spawnSync(node, ['--experimental-strip-types', '--no-warnings', guard, '--registered', other], { env: { ...process.env, PCB_LIVE_CONFIG: config } });
    assert.equal(registered.status, 0);
    args[args.indexOf('--url') + 1] = 'http://127.0.0.1:4321';
    assert.notEqual(run().status, 0); assert.equal(fs.readFileSync(config, 'utf8'), contents);
    fs.writeFileSync(path.join(other, '.pcb-live.json'), JSON.stringify({ projectId: 'different' }));
    const mismatch = spawnSync(node, ['--experimental-strip-types', '--no-warnings', guard, '--registered', other], { env: { ...process.env, PCB_LIVE_CONFIG: config } });
    assert.equal(mismatch.status, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
