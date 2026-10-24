// Types shared by main, preload and renderer for the engine bridge.
export type EngineState = 'starting' | 'ready' | 'restarting' | 'stopped'

export interface EngineStatus {
  state: EngineState
  port: number | null
  pid: number | null
  restarts: number
  lastError: string | null
}

export interface AgentContext {
  projectRoot: string | null
  pcb: string | null
  gate: string | null
  selection: string | null
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'viewer'; ref?: string; x?: number; y?: number }
  | { kind: 'done'; costUsd?: number; durationMs?: number; turns?: number }
  | { kind: 'error'; message: string }

export interface AgentApi {
  send: (text: string, ctx: AgentContext) => Promise<void>
  cancel: () => Promise<void>
  reset: () => Promise<void>
  onEvent: (cb: (e: AgentEvent) => void) => () => void
}

export interface AppApi {
  engine: EngineApi
  agent: AgentApi
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
  /** Engine notifications (run.event, run.state, ...). */
  onNotify: (cb: (n: EngineNotification) => void) => () => void
}

export interface EngineNotification {
  method: string
  params: Record<string, unknown>
}
