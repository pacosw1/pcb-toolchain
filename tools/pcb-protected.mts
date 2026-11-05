#!/usr/bin/env node
// Read coordinator-owned board versions into a separate working copy; never overwrite a local file.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './pcb-live-common.mts';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pcb protected list | pcb protected read --board ID --out FILE [--revision N]'); return;
  }
  const cfg = loadConfig(); if (!cfg) throw new Error('Live coordinator is not configured');
  const token = fs.readFileSync(cfg.tokenFile, 'utf8').trim(); if (token.length < 32) throw new Error('Coordinator token is invalid');
  const get = async (endpoint: string): Promise<Response> => {
    const response = await fetch(cfg.url + endpoint, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Coordinator returned HTTP ${response.status}`);
    return response;
  };
  if (command === 'list') {
    if (args.length) throw new Error('Usage: pcb protected list');
    let after = '', count = 0;
    do {
      const q = new URLSearchParams({ after, limit: '500' });
      const page = await (await get('/board-revisions/list?' + q)).json() as { boards: { board: string; revision: number; sha256: string }[]; next: string | null };
      if (!Array.isArray(page.boards) || (page.next !== null && typeof page.next !== 'string')) throw new Error('Invalid board list');
      for (const board of page.boards) { console.log(`${board.board}\trevision ${board.revision}\t${board.sha256}`); count++; }
      if (page.next && page.next <= after) throw new Error('Invalid board list cursor');
      after = page.next ?? '';
    } while (after && count < 100_000);
    if (!count) console.log('No protected board revisions yet.');
    if (after) throw new Error('Board list exceeds 100,000 entries');
    return;
  }
  if (command !== 'read') throw new Error('Usage: pcb protected list | pcb protected read --board ID --out FILE [--revision N]');
  const { values } = parseArgs({ args, options: { board: { type: 'string' }, out: { type: 'string' }, revision: { type: 'string' } } });
  if (!values.board || !values.out || (values.revision && !/^[1-9]\d*$/.test(values.revision))) throw new Error('Usage: pcb protected read --board ID --out FILE [--revision N]');
  const q = new URLSearchParams({ board: values.board }); if (values.revision) q.set('revision', values.revision);
  const response = await get('/board-revisions/content?' + q), expected = response.headers.get('x-board-sha256');
  if (!expected || !/^[0-9a-f]{64}$/.test(expected) || !response.body) throw new Error('Invalid protected board response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
    if (size > 20 * 1024 * 1024) { await reader.cancel(); throw new Error('Protected board exceeds 20 MiB'); } chunks.push(part.value); }
  const bytes = Buffer.concat(chunks, size);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Protected board hash does not match');
  const dest = path.resolve(values.out), tmp = path.join(path.dirname(dest), `.pcb-export-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 });
    fs.linkSync(tmp, dest); // fails if destination exists, including a symlink
  } finally { fs.rmSync(tmp, { force: true }); }
  console.log(`Exported revision ${response.headers.get('x-board-revision')} to ${dest}. This is a working copy.`);
}
void main().catch(error => { console.error('pcb protected:', error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
