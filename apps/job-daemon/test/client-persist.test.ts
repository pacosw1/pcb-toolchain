import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { persist, ResultsNotReady } from '../src/client.ts';
import type { PersistIo } from '../src/client.ts';

/** A clock that only the fake sleep moves, and a die that throws what it was given. */
function io(): PersistIo {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    die: (msg, code) => { throw new Error(`${code}: ${msg}`); },
  };
}

describe('persist', () => {
  it('an unreachable daemon is reported as unreachable', async () => {
    await assert.rejects(persist('status', async () => { throw new Error('ECONNREFUSED'); }, io()), /^Error: 3: .*daemon unreachable/);
  });

  it('results that never become ready are not reported as an unreachable daemon', async () => {
    await assert.rejects(
      persist('results', async () => { throw new ResultsNotReady(); }, io()),
      (e: Error) => /results/.test(e.message) && !/unreachable/.test(e.message) && !e.message.startsWith('Error: 3:'),
    );
  });

  it('a result that becomes ready ends the wait', async () => {
    let calls = 0;
    const got = await persist('results', async () => {
      if (++calls < 3) throw new ResultsNotReady();
      return 'done';
    }, io());
    assert.equal(got, 'done');
    assert.equal(calls, 3);
  });
});
