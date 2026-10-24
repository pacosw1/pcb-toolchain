import { ElectronAPI } from '@electron-toolkit/preload'
import type { AppApi } from './types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: AppApi
  }
}
