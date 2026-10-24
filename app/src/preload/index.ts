import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { EngineApi, EngineStatus } from './types'

const api: {
  engine: EngineApi
  openProjectDialog: () => Promise<string | null>
  defaultProject: () => Promise<string | null>
} = {
  openProjectDialog: () => ipcRenderer.invoke('dialog:openProject'),
  defaultProject: () => ipcRenderer.invoke('app:defaultProject'),
  engine: {
    call: (method, params) => ipcRenderer.invoke('engine:call', method, params),
    status: () => ipcRenderer.invoke('engine:status'),
    kill: () => ipcRenderer.invoke('engine:kill'),
    onStatus: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, s: EngineStatus): void => cb(s)
      ipcRenderer.on('engine:status', listener)
      return () => ipcRenderer.removeListener('engine:status', listener)
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
