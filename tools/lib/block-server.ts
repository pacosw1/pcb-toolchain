// The local viewer of blocks and boards, on the loopback address only. The page is tools/lib/block-viewer.html.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { detail, findItem, items, layoutOf, readLoose, revision, safePath, type Layout } from './block-sources.ts';
import { CACHE, drc, render } from './block-views.ts';
import { jsonDumps } from './py-compat.mjs';

const PAGE = new URL('block-viewer.html', import.meta.url);
const TYPES: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', glb: 'model/gltf-binary', pdf: 'application/pdf',
  json: 'application/json', html: 'text/html; charset=utf-8',
};

function send(response: ServerResponse, code: number, body: string | Buffer, type: string): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  response.writeHead(code, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' });
  response.end(bytes);
}

const sendJson = (response: ServerResponse, value: unknown, code = 200): void => send(response, code, jsonDumps(value), TYPES.json as string);

function sendFile(response: ServerResponse, path: string | null | undefined): void {
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    sendJson(response, { error: 'not found' }, 404);
    return;
  }
  send(response, 200, readFileSync(path), TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream');
}

const unquote = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

async function route(layout: Layout, parts: string[], response: ServerResponse): Promise<void> {
  const [head, second, third, fourth] = parts;
  if (!parts.length) return send(response, 200, readFileSync(PAGE), TYPES.html as string);
  if (head === 'api' && second === 'rev' && parts.length === 2) {
    const boards = items(layout).filter(item => item.kind === 'board').map(item => item.dir);
    return sendJson(response, { rev: revision([dirname(layout.lib), ...boards]) });
  }
  if (head === 'api' && second === 'items' && parts.length === 2) {
    return sendJson(response, items(layout).map(({ kind, id, dir }) => ({ kind, id, level: kind === 'block' ? readLoose(join(dir, 'facts.json')).level ?? null : null })));
  }
  if (head === 'api' && second === 'item' && parts.length === 4) {
    const found = detail(layout, third as string, fourth as string);
    return found ? sendJson(response, found) : sendJson(response, { error: 'not found' }, 404);
  }
  if (head === 'api' && second === 'drc' && parts.length === 4) return sendJson(response, await drc(layout, third as string, fourth as string));
  if (head === 'render' && parts.length === 4) {
    const result = await render(layout, second as string, third as string, fourth as string);
    return 'path' in result ? sendFile(response, result.path) : sendJson(response, { error: result.error }, 500);
  }
  if (head === 'file' && parts.length >= 4) {
    const item = findItem(layout, second as string, third as string);
    return sendFile(response, item ? safePath(item.dir, parts.slice(3).join('/')) : null);
  }
  if (head === 'datasheet' && parts.length === 2) return sendFile(response, safePath(join(layout.reg, 'datasheets'), second as string));
  if (head === 'evidence' && parts.length >= 2) return sendFile(response, safePath(layout.reg, parts.slice(1).join('/')));
  return sendJson(response, { error: 'not found' }, 404);
}

/** Runs until the process ends. */
export function serve(root: string, port: number): Promise<number> {
  const layout = layoutOf(root);
  const server = createServer((request, response) => {
    const parts = (request.url ?? '/').split('?')[0]?.split('/').filter(Boolean).map(unquote) ?? [];
    route(layout, parts, response).catch((error: unknown) => {
      const { name, message } = error as Error;
      sendJson(response, { error: `${name}: ${message}` }, 500);
    });
  });
  return new Promise((_done, fail) => {
    server.on('error', fail);
    server.listen(port, '127.0.0.1', () => console.log(`blocks: serving http://127.0.0.1:${port}  (cache ${CACHE})`));
  });
}
