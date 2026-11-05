import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BlobStore } from '../src/blobs.ts';
import { LiveEvents } from '../src/live-events.ts';
import { rig } from './helpers.ts';

test('cache sweep retains replay frames and their source board within the history window', () => {
  const r = rig();
  const dir = path.join(r.dir, 'live-blobs'), incoming = path.join(r.dir, 'incoming-live');
  const blobs = new BlobStore(dir, incoming, 1), events = new LiveEvents(path.join(r.dir, 'live-test.sqlite'));
  const frame = 'a'.repeat(64), base = 'b'.repeat(64), unrelated = 'c'.repeat(64);
  try {
    for (const hash of [frame, base, unrelated]) {
      const file = path.join(dir, hash); fs.writeFileSync(file, hash); fs.utimesSync(file, new Date(1), new Date(1));
    }
    events.append({ source: 'mini', eventId: 'frame', host: 'mini', board: 'p/B', run: 'r', kind: 'route.preview', data: { sha256: frame, baseSha256: base } });
    events.append({ source: 'mini', eventId: 'next', host: 'mini', board: 'p/B', run: 'r', kind: 'route.preview', data: { sha256: 'd'.repeat(64) } });
    const now = Date.now();
    assert.equal(events.history('mini', 'p/B', 'r', 0, now + 1).expired, true);
    assert.equal(events.history('mini', 'p/B', 'r', 0, now + 1).events.length, 0);
    blobs.sweep(now, () => events.retainedBlobs(now - 86_400_000));
    assert.equal(fs.existsSync(path.join(dir, frame)), true);
    assert.equal(fs.existsSync(path.join(dir, base)), true);
    assert.equal(fs.existsSync(path.join(dir, unrelated)), false);
  } finally { events.close(); r.cleanup(); }
});
