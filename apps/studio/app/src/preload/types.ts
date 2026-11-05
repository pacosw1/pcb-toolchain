// Types shared by main, preload and renderer for the engine bridge. Engine result shapes come from
// ../shared/generated (generated from the engine models); the ones here are app-side (process state, agent).
import type { GlbResult } from '../shared/generated'

export type * from '../shared/generated'
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
  selection: string | null // "@U101.41 #FSPI_D0"
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
  /** 'desktop' in Electron, 'web' in the read-only browser viewer. */
  mode: 'desktop' | 'web'
  /** URL the renderer can load for an absolute project (or 3D cache) file path. */
  fileUrl: (path: string) => string
  engine: EngineApi
  agent: AgentApi
  openProjectDialog: () => Promise<string | null>
  defaultProject: () => Promise<string | null>
  /** Tells main which folder pcbfile:// may serve. */
  setProjectRoot: (root: string) => Promise<void>
  openExternal: (url: string) => Promise<void>
  /** Export (or reuse) the board's 3D model; returns a pcbfile:// URL. */
  boardGlb: (pcb: string) => Promise<Pick<GlbResult, 'cached' | 'size'> & { url: string }>
  liveGlb: (cursor: number) => Promise<Pick<GlbResult, 'cached' | 'size' | 'warnings'> & { url: string }>
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
