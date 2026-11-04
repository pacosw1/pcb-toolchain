// WebSocket JSON-RPC server on 127.0.0.1. Prints one READY line with the port, then serves until stdin closes. Port of
// engine/src/pcbstudio/server.py.
//
// Authentication: the app generates a random token and gives it in the environment (PCBSTUDIO_ENGINE_TOKEN, not on the
// command line, so `ps` does not show it). The server removes it from its own environment (tools/pcb children do not
// inherit it) and refuses every WebSocket handshake that does not carry it as `?t=TOKEN` or `Authorization: Bearer
// TOKEN`. A handshake with an Origin header comes from a browser page, never from the app's main process: refused.
// Without the variable (manual runs, tests) the server makes a token and prints it on the READY line.
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocketServer } from 'ws'
import { registry } from './api.ts'
import { subscribe, unsubscribe } from './events.ts'

const TOKEN_ENV = 'PCBSTUDIO_ENGINE_TOKEN'

/** The token a handshake carries (query `t` or a Bearer header), or ''. */
function requestToken(req: IncomingMessage): string {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('t')
  if (q) return q
  const auth = req.headers.authorization ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : ''
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function serve(port = 0, watchStdin = true): Promise<void> {
  const given = process.env[TOKEN_ENV] ?? ''
  delete process.env[TOKEN_ENV]
  const token = given || randomBytes(32).toString('base64url')
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1', port, perMessageDeflate: false,
      verifyClient: (info, done) => {
        if (info.req.headers.origin !== undefined) done(false, 403, 'browser origins are not allowed')
        else if (!sameToken(requestToken(info.req), token)) done(false, 401, 'engine token required')
        else done(true)
      }
    })
    wss.on('error', reject)
    wss.on('connection', ws => {
      const send = (text: string): void => { ws.send(text) }
      subscribe(send)
      ws.on('close', () => unsubscribe(send))
      ws.on('message', raw => {
        // Each request is its own promise, so a slow method does not block notifications or other calls.
        void registry.handle(String(raw), send).then(reply => { if (reply !== null && ws.readyState === ws.OPEN) ws.send(reply) })
      })
    })
    wss.on('listening', () => {
      const bound = (wss.address() as { port: number }).port
      console.log('READY ' + JSON.stringify(given ? { port: bound } : { port: bound, token }))
      if (!watchStdin) return
      // The app owns the engine: when its pipe closes, the engine exits (no orphan processes).
      process.stdin.resume()
      process.stdin.on('end', () => wss.close(() => resolve()))
    })
  })
}
