// A job on this host keeps the daemon's layout: in/ holds the inputs, the command writes out/, and a failure stops the tool.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type DaemonJob, runJobHere } from './daemon-job.ts';

test('a local job reads in/, writes out/ and stops on a failure', () => {
  const folder = mkdtempSync(join(tmpdir(), 'daemon-job-test-')), input = join(folder, 'board.txt');
  try {
    writeFileSync(input, 'copper');
    const job = (script: string): DaemonJob => ({ label: 'test job', inputs: [input], image: 'none', timeoutS: 10, cpus: 1, memGb: 1, command: ['sh', '-c', script] });
    let seen = '';
    runJobHere(job('mkdir out && cp in/board.txt out/result.txt'), out => { seen = readFileSync(join(out, 'result.txt'), 'utf8'); });
    assert.equal(seen, 'copper');
    assert.throws(() => runJobHere(job('echo broken >&2; exit 3'), () => assert.fail('no result of a failed job')), /test job ended with 3: broken/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
