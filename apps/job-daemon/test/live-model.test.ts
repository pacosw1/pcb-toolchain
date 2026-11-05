import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { Worker } from '../../../tools/pcb-live-worker.mts';
import { exportModel } from '../../../tools/pcb-live-model.mts';
import { createHash } from 'node:crypto';
import { createServer } from '../src/server.ts';
import { rig, TOKEN } from './helpers.ts';

test('snapshot 3D export runs on its source worker and returns a verified model', async () => {
  const r = rig(), root = path.join(r.dir, 'project'), cad = path.join(root, 'hardware-design/boards/DEMO/cad');
  fs.mkdirSync(cad, { recursive: true }); fs.writeFileSync(path.join(cad, 'demo.kicad_pcb'), 'board bytes');
  const token = path.join(r.dir, 'token'), fake = path.join(r.dir, 'kicad-cli');
  fs.writeFileSync(token, TOKEN);
  fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s' "$HOME" > '${path.join(r.dir, 'export-home')}'\nwhile [ "$1" != "-o" ]; do shift; done\nprintf "glTF12345678" > "$2"\n`, { mode: 0o755 });
  const prior = process.env.PCBSTUDIO_KICAD_CLI; process.env.PCBSTUDIO_KICAD_CLI = fake;
  const server = createServer(r.mgr); await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const post = async (endpoint: string, body: unknown) => fetch(url + endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const worker = new Worker({ project: root, projectId: 'project', host: 'mini', url, tokenFile: token, stateFile: path.join(r.dir, 'state'), interval: 1, discover: false, once: true });
  try {
    await worker.syncEpoch(); await worker.scanBoards();
    const state = await (await fetch(url + '/live/state', { headers })).json() as { events: { cursor: number; kind: string }[] };
    const cursor = state.events.find(e => e.kind === 'board.snapshot')!.cursor;
    const request = await (await post('/live/models', { cursor })).json() as { id: string; status: string };
    assert.equal(request.status, 'pending');
    await worker.processModels();
    const result = await (await fetch(url + '/live/models/' + request.id, { headers })).json() as { status: string; modelSha: string };
    assert.equal(result.status, 'ready');
    const bytes = Buffer.from(await (await fetch(url + '/blobs/' + result.modelSha, { headers })).arrayBuffer());
    assert.equal(bytes.toString(), 'glTF12345678');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.modelSha);
    if (process.platform === 'darwin') {
      const exportHome = fs.readFileSync(path.join(r.dir, 'export-home'), 'utf8');
      assert.notEqual(exportHome, process.env.HOME);
      assert.equal(fs.existsSync(exportHome), false, 'temporary KiCad home is removed after export');
    }
    await assert.rejects(exportModel({ root, boardPath: '../escape.kicad_pcb', boardSha: createHash('sha256').update('board bytes').digest('hex'), bytes: Buffer.from('board bytes'), maxBytes: 1024 }), /invalid board path/);
    const failed = path.join(r.dir, 'failed-kicad'); fs.writeFileSync(failed, '#!/bin/sh\nexit 42\n', { mode: 0o755 });
    await assert.rejects(exportModel({ root, boardPath: 'hardware-design/boards/DEMO/cad/demo.kicad_pcb', boardSha: createHash('sha256').update('board bytes').digest('hex'), bytes: Buffer.from('board bytes'), maxBytes: 1024, executable: failed }), /exit 42/);
  } finally {
    if (prior === undefined) delete process.env.PCBSTUDIO_KICAD_CLI; else process.env.PCBSTUDIO_KICAD_CLI = prior;
    server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); r.cleanup();
  }
});
