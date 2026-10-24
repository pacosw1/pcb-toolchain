// Browser (web viewer) implementation of window.api: JSON-RPC over the engine's /rpc WebSocket on the same origin.
// Read-only: the server pins the project and allows only viewing methods; chat runs in the desktop app.
import type { AppApi, EngineNotification, EngineStatus } from '../../preload/types'

export function installWebApi(): void {
  let ws: WebSocket | null = null
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const statusCbs = new Set<(s: EngineStatus) => void>()
  const notifyCbs = new Set<(n: EngineNotification) => void>()
  let restarts = 0
  let status: EngineStatus = { state: 'starting', port: null, pid: null, restarts: 0, lastError: null }
  const setStatus = (patch: Partial<EngineStatus>): void => {
    status = { ...status, ...patch }
    statusCbs.forEach((cb) => cb(status))
  }

  const connect = (): void => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`
    const sock = new WebSocket(url)
    sock.onopen = () => {
      ws = sock
      setStatus({ state: 'ready', restarts, lastError: null })
    }
    sock.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.id === undefined && typeof msg.method === 'string') {
        notifyCbs.forEach((cb) => cb({ method: msg.method, params: msg.params }))
        return
      }
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
    }
    sock.onclose = () => {
      ws = null
      pending.forEach((p) => p.reject(new Error('connection lost')))
      pending.clear()
      restarts++
      setStatus({ state: 'restarting', lastError: 'connection lost; reconnecting' })
      setTimeout(connect, 1500)
    }
  }
  connect()

  const call = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!ws) return reject(new Error('not connected'))
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })

  const fileUrl = (path: string): string => `/files?path=${encodeURIComponent(path)}`
  const desktopOnly = (): Promise<never> => Promise.reject(new Error('Claude chat runs in the PCB Studio desktop app'))

  const api: AppApi = {
    mode: 'web',
    fileUrl,
    engine: {
      call,
      status: async () => status,
      kill: async () => undefined,
      onStatus: (cb) => {
        statusCbs.add(cb)
        return () => statusCbs.delete(cb)
      },
      onNotify: (cb) => {
        notifyCbs.add(cb)
        return () => notifyCbs.delete(cb)
      }
    },
    agent: {
      send: desktopOnly,
      cancel: async () => undefined,
      reset: async () => undefined,
      onEvent: () => () => undefined
    },
    openProjectDialog: async () => null,
    defaultProject: async () => 'server', // the server pins the project
    setProjectRoot: async () => undefined,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener')
    },
    boardGlb: async (pcb) => {
      const r = (await call('board.glb', { pcb })) as { path: string; cached: boolean; size: number }
      return { ...r, url: fileUrl(r.path) }
    }
  }
  ;(window as unknown as { api: AppApi }).api = api
}
