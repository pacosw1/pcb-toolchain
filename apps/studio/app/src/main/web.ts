// Read-only web viewer server: the app's web build, JSON-RPC over WebSocket and project files, on one port. Port of
// engine/src/pcbstudio/web.py.
//
// Bind to 127.0.0.1 and publish with `tailscale serve` (HTTPS, tailnet only). Only viewing methods are allowed: no gate
// runs, no adopt, no edits.
//
// Access: a viewer token (random, kept in ~/Library/Application Support/pcbstudio/web-token, mode 600) is printed in the
// start URL. A request with `?t=TOKEN` gets an HttpOnly SameSite=Strict cookie and a redirect without the token; every
// other request needs the cookie (401 without). /rpc also refuses an Origin that is not this site.
//
// Files: /files serves only PDFs, 3D models (.glb) and images from the open project and the 3D-model cache, and never
// anything in a dot directory (.git, .gate, .env, ...). board.glb exports run one at a time; a second concurrent export
// request is refused (busy) instead of queuing more KiCad 3D exports.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { projectOpen, registry } from './api.ts'
import { subscribe, unsubscribe } from './events.ts'
import { resolveReal } from './project.ts'

export const READ_ONLY = new Set(['engine.ping', 'engine.info', 'project.open', 'board.geometry', 'board.bom', 'board.glb', 'file.resolve',
  'run.list', 'run.get', 'run.findings', 'run.candidate', 'board.parts', 'part.get', 'parts.index', 'board.watch', 'board.unwatch'])   // never op.*, run.adopt, gate.check or run.cancel

const FILE_TYPES = new Set(['.pdf', '.glb', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const COOKIE = 'pcbstudio_view'
const COOKIE_AGE_S = 30 * 86400
const HEARTBEAT_MS = 30_000
export const DEFAULT_TOKEN_FILE = '~/Library/Application Support/pcbstudio/web-token'
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain'
}

const home = (p: string): string => p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }
const mimeOf = (p: string): string => MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The viewer token from its file; a new one (mode 600) when the file does not exist. */
export function loadToken(file: string = DEFAULT_TOKEN_FILE): string {
  const p = home(file)
  if (isFile(p)) {
    const tok = fs.readFileSync(p, 'utf8').trim()
    if (tok.length >= 20) return tok
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tok = randomBytes(32).toString('base64url')
  fs.writeFileSync(p, tok + '\n', { mode: 0o600 })
  fs.chmodSync(p, 0o600)
  return tok
}

/** A resolved file inside one of the roots, of an allowed type, with no dot directory below that root. */
export function allowedFile(file: string, roots: string[]): boolean {
  for (const root of roots) {
    if (file.startsWith(root + path.sep)) {
      const parts = path.relative(root, file).split(path.sep)
      return FILE_TYPES.has(path.extname(file).toLowerCase()) && !parts.some(p => p.startsWith('.'))
    }
  }
  return false
}

const errorText = (id: unknown, message: string, code = -32601): string => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

function cookieOf(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim()
  }
  return ''
}

function plain(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** One file, with single-range support (the PDF and 3D viewers ask for ranges). */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, headers: Record<string, string>): void {
  const size = fs.statSync(file).size
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  let start = 0, end = size - 1, status = 200
  const all: Record<string, string | number> = { ...headers, 'Accept-Ranges': 'bytes' }
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    status = 206
    all['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  all['Content-Length'] = size ? end - start + 1 : 0
  res.writeHead(status, all)
  if (req.method === 'HEAD' || !size) res.end()
  else fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res)
}

export function makeServer(staticDir: string, project: string, glbDirGiven: string, token: string): Server {
  const projectRoot = resolveReal(path.resolve(project))
  fs.mkdirSync(glbDirGiven, { recursive: true })
  const glbDir = resolveReal(path.resolve(glbDirGiven)), staticRoot = resolveReal(path.resolve(staticDir))
  projectOpen(projectRoot)                          // the viewer serves one project
  let glbBusy = false

  const isHttps = (req: IncomingMessage): boolean => req.headers['x-forwarded-proto'] === 'https'
  const urlOf = (req: IncomingMessage): URL => new URL(req.url ?? '/', 'http://viewer.invalid')
  const hasCookie = (req: IncomingMessage): boolean => sameToken(cookieOf(req), token)

  function files(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const file = resolveReal(path.resolve(url.searchParams.get('path') ?? ''))
    if (!isFile(file) || !allowedFile(file, [projectRoot, glbDir])) return plain(res, 403, 'not a viewer file of the open project')
    const headers: Record<string, string> = { 'Content-Type': mimeOf(file), 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' }
    if (path.extname(file).toLowerCase() === '.svg') {       // an SVG can carry script: no script, no same origin
      headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    }
    sendFile(req, res, file, headers)
  }

  function staticFile(req: IncomingMessage, res: ServerResponse, url: URL): void {
    let rel: string
    try { rel = decodeURIComponent(url.pathname) } catch { return plain(res, 400, 'bad path') }
    if (rel === '/') return sendFile(req, res, path.join(staticRoot, 'index.html'), { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' })
    const file = resolveReal(path.join(staticRoot, rel))
    if (!file.startsWith(staticRoot + path.sep) || !isFile(file)) return plain(res, 404, 'not found')
    sendFile(req, res, file, { 'Content-Type': mimeOf(file) })
  }

  const server = http.createServer((req, res) => {
    const url = urlOf(req), given = url.searchParams.get('t')
    if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'read only')
    if (given !== null && sameToken(given, token)) {
      if (url.pathname !== '/rpc') {
        url.searchParams.delete('t')
        const rest = url.searchParams.size ? `?${url.searchParams}` : ''
        res.writeHead(302, {
          Location: url.pathname + rest,
          'Set-Cookie': `${COOKIE}=${token}; HttpOnly; Max-Age=${COOKIE_AGE_S}; Path=/; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`
        })
        return void res.end()
      }
    } else if (!hasCookie(req)) {
      return plain(res, 401, 'viewer token required: open the URL the server printed at start\n')
    }
    if (url.pathname === '/rpc') return plain(res, 426, 'this path takes a WebSocket')
    if (url.pathname === '/files') return files(req, res, url)
    staticFile(req, res, url)
  })

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

  async function answer(ws: WebSocket, raw: string, client: (text: string) => void): Promise<void> {
    let req: { id?: unknown, method?: unknown, params?: Record<string, unknown> } | null
    try { req = JSON.parse(raw) } catch { return }
    const isRequest = req !== null && typeof req === 'object' && !Array.isArray(req)
    const method = isRequest ? req!.method : undefined
    if (typeof method !== 'string' || !READ_ONLY.has(method)) {
      ws.send(errorText(isRequest ? req!.id : null, `${String(method)}: not available in the web viewer`))
      return
    }
    if (method === 'project.open') req!.params = { root: projectRoot }      // pinned project; ignore the client's root
    let reply: string | null
    if (method === 'board.glb') {
      req!.params = { ...(req!.params ?? {}), out_dir: glbDir }
      if (glbBusy) {
        ws.send(errorText(req!.id, 'board.glb: another 3D export is running; retry later', -32000))
        return
      }
      glbBusy = true
      try { reply = await registry.handle(JSON.stringify(req), client) } finally { glbBusy = false }
    } else {
      reply = await registry.handle(JSON.stringify(req), client)
    }
    if (reply !== null && ws.readyState === ws.OPEN) ws.send(reply)
  }

  function refuse(socket: Duplex, status: number, text: string): void {
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\nConnection: close\r\n\r\n${text}`)
  }

  server.on('upgrade', (req, socket, head) => {
    const url = urlOf(req), given = url.searchParams.get('t')
    if (!((given !== null && sameToken(given, token)) || hasCookie(req))) return refuse(socket, 401, 'viewer token required\n')
    if (url.pathname !== '/rpc') return refuse(socket, 404, 'not found\n')
    const origin = req.headers.origin
    if (origin !== undefined) {
      let host = ''
      try { host = new URL(origin).host } catch { /* no host: refused */ }
      const hosts = [req.headers.host, req.headers['x-forwarded-host']]
      if (!host || !hosts.includes(host)) return refuse(socket, 403, 'cross-site origin')
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let alive = true
      const send = (text: string): void => { ws.send(text) }
      subscribe(send)
      const beat = setInterval(() => {
        if (!alive) return ws.terminate()
        alive = false
        ws.ping()
      }, HEARTBEAT_MS)
      ws.on('pong', () => { alive = true })
      ws.on('close', () => {
        clearInterval(beat)
        unsubscribe(send)
      })
      ws.on('message', (raw, binary) => { if (!binary) void answer(ws, String(raw), send) })
    })
  })
  return server
}

export interface WebOptions { staticDir: string, project: string, glbDir: string, host: string, port: number, tokenFile: string }

export function serveWeb(o: WebOptions): void {
  const staticDir = path.resolve(home(o.staticDir))
  if (!isFile(path.join(staticDir, 'index.html'))) {
    console.error(`no web build at ${staticDir} (cd app && npm run build:web)`)
    process.exit(1)
  }
  const token = loadToken(o.tokenFile)
  makeServer(staticDir, home(o.project), home(o.glbDir), token).listen(o.port, o.host, () => {
    console.log(`web viewer on http://${o.host}:${o.port}/?t=${token} (project ${o.project}; the token is in ${home(o.tokenFile)})`)
  })
}
