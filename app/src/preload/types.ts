// Types shared by main, preload and renderer for the engine bridge.
export type EngineState = 'starting' | 'ready' | 'restarting' | 'stopped'

export interface EngineStatus {
  state: EngineState
  port: number | null
  pid: number | null
  restarts: number
  lastError: string | null
}

export interface AppApi {
  engine: EngineApi
  openProjectDialog: () => Promise<string | null>
  defaultProject: () => Promise<string | null>
  /** Tells main which folder pcbfile:// may serve. */
  setProjectRoot: (root: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
}

export interface EngineApi {
  call: (method: string, params?: unknown) => Promise<unknown>
  status: () => Promise<EngineStatus>
  kill: () => Promise<void>
  onStatus: (cb: (s: EngineStatus) => void) => () => void
}
