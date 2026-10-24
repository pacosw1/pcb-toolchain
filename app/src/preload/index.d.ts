import { ElectronAPI } from '@electron-toolkit/preload'
import type { EngineApi } from './types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: { engine: EngineApi }
  }
}
