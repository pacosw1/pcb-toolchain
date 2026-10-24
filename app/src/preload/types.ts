// Types shared by main, preload and renderer for the engine bridge.
export type EngineState = 'starting' | 'ready' | 'restarting' | 'stopped'

export interface EngineStatus {
  state: EngineState
  port: number | null
  pid: number | null
  restarts: number
  lastError: string | null
}

export interface EngineApi {
  call: (method: string, params?: unknown) => Promise<unknown>
  status: () => Promise<EngineStatus>
  kill: () => Promise<void>
  onStatus: (cb: (s: EngineStatus) => void) => () => void
}
