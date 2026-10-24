import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AgentEvent, AppApi, EngineNotification, EngineStatus } from './types'

const api: AppApi = {
  agent: {
    send: (text, ctx) => ipcRenderer.invoke('agent:send', text, ctx),
    cancel: () => ipcRenderer.invoke('agent:cancel'),
    reset: () => ipcRenderer.invoke('agent:reset'),
    onEvent: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, ev: AgentEvent): void => cb(ev)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    }
  },
  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  defaultProject: () => ipcRenderer.invoke('app:defaultProject'),
  setProjectRoot: (root) => ipcRenderer.invoke('app:setProjectRoot', root),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  boardGlb: (pcb) => ipcRenderer.invoke('board:glb', pcb),
  engine: {
    call: (method, params) => ipcRenderer.invoke('engine:call', method, params),
    status: () => ipcRenderer.invoke('engine:status'),
    kill: () => ipcRenderer.invoke('engine:kill'),
    onStatus: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, s: EngineStatus): void => cb(s)
      ipcRenderer.on('engine:status', listener)
      return () => ipcRenderer.removeListener('engine:status', listener)
    },
    onNotify: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, n: EngineNotification): void => cb(n)
      ipcRenderer.on('engine:notify', listener)
      return () => ipcRenderer.removeListener('engine:notify', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
