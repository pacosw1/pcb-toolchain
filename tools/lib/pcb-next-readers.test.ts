import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iotrouteMissing } from './iotroute-bin.ts';
import { now } from './lean-clock.ts';
import { encodeDeadline } from './lean-workflow.ts';
import { nextReaders } from './pcb-next-readers.ts';

const needsBinary = { skip: iotrouteMissing() };

test('next input verification captures an owned probe and preserves its nonzero verdict', needsBinary, async () => {
  const result = await nextReaders.runStage([process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7'],
    { stage: 'next-test', timeoutS: 10, env: process.env });
  assert.deepEqual(result, { returncode: 7, stdout: 'out', stderr: 'err' });
});

test('next input verification cancels an owned probe at the deadline', needsBinary, async () => {
  await assert.rejects(nextReaders.runStage([process.execPath, '-e', 'setTimeout(() => {}, 10000)'],
    { stage: 'next-timeout-test', timeoutS: 0.1, env: process.env }),
  (error: unknown) => (error as { type?: string; cleanup?: { complete?: boolean } }).type === 'subprocess.TimeoutExpired'
    && (error as { cleanup?: { complete?: boolean } }).cleanup?.complete === true);
});

test('next input verification cannot extend an inherited expired deadline', needsBinary, async () => {
  await assert.rejects(nextReaders.runStage([process.execPath, '-e', 'process.exit(0)'], {
    stage: 'next-inherited-deadline', timeoutS: 10,
    env: { ...process.env, IOT_LEAN_DEADLINE: encodeDeadline(now() - 1) },
  }), (error: unknown) => (error as { type?: string }).type === 'subprocess.TimeoutExpired');
});
