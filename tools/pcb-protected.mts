#!/usr/bin/env node
// Read coordinator-owned board versions into a separate working copy; never overwrite a local file.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, projectId } from './pcb-live-common.mts';

async function main(): Promise<void> {
  const argv = process.argv.slice(2); let project: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--project' && !argv[i].startsWith('--project=')) continue;
    if (project !== undefined) throw new Error('Project was specified more than once');
    if (argv[i] === '--project') { project = argv[i + 1]; argv.splice(i, 2); }
    else { project = argv[i].slice('--project='.length); argv.splice(i, 1); }
    if (!project) throw new Error('Missing project directory');
    i--;
  }
  if (argv[0] === 'protected') argv.shift();
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === 'help') {
    console.log('Usage: pcb protected list | pcb protected read --board ID --out FILE [--revision N]'); return;
  }
  const cfg = loadConfig(); if (!cfg) throw new Error('Live coordinator is not configured');
  const scope = project ? projectId(project, cfg) : null;
  if (project && !scope) throw new Error('Project is not registered with the live coordinator');
  const token = fs.readFileSync(cfg.tokenFile, 'utf8').trim(); if (token.length < 32) throw new Error('Coordinator token is invalid');
  const get = async (endpoint: string): Promise<Response> => {
    const response = await fetch(cfg.url + endpoint, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Coordinator returned HTTP ${response.status}`);
    return response;
  };
  if (command === 'list') {
    if (args.length) throw new Error('Usage: pcb protected list');
    let after = '', count = 0, scanned = 0;
    do {
      const q = new URLSearchParams({ after, limit: '500' });
      const page = await (await get('/board-revisions/list?' + q)).json() as { boards: { board: string; revision: number; sha256: string }[]; next: string | null };
      if (!Array.isArray(page.boards) || (page.next !== null && typeof page.next !== 'string')) throw new Error('Invalid board list');
      scanned += page.boards.length;
      for (const board of page.boards) if (!scope || board.board.startsWith(scope + '/')) { console.log(`${board.board}\trevision ${board.revision}\t${board.sha256}`); count++; }
      if (page.next && page.next <= after) throw new Error('Invalid board list cursor');
      after = page.next ?? '';
    } while (after && scanned < 100_000);
    if (!count) console.log('No protected board revisions yet.');
    if (after) throw new Error('Board list exceeds 100,000 entries');
    return;
  }
  if (command !== 'read') throw new Error('Usage: pcb protected list | pcb protected read --board ID --out FILE [--revision N]');
  const { values } = parseArgs({ args, options: { board: { type: 'string' }, out: { type: 'string' }, revision: { type: 'string' } } });
  if (!values.board || !values.out || (values.revision && !/^[1-9]\d*$/.test(values.revision))) throw new Error('Usage: pcb protected read --board ID --out FILE [--revision N]');
  const board = scope && values.board.startsWith('hardware-design/') ? `${scope}/${values.board}` : values.board;
  if (scope && !board.startsWith(scope + '/')) throw new Error('Board does not belong to the selected project');
  const q = new URLSearchParams({ board }); if (values.revision) q.set('revision', values.revision);
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
