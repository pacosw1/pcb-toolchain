import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { EngineSupervisor } from './engine'

// Dev: the engine project sits next to the app folder. A packaged build sets PCBSTUDIO_ENGINE_DIR (phase 1 ships
// the engine source beside the app; bundling it is a later step).
// A packaged .app lives elsewhere, so it falls back to the repo checkout until the engine is bundled.
function findEngineDir(): string {
  const candidates = [
    process.env.PCBSTUDIO_ENGINE_DIR,
    resolve(app.getAppPath(), '..', 'engine'),
    join(app.getPath('home'), 'code', 'pcb-studio', 'engine')
  ].filter((p): p is string => !!p)
  return candidates.find((p) => existsSync(join(p, 'pyproject.toml'))) ?? candidates[candidates.length - 1]
}
const engineDir = findEngineDir()
const engine = new EngineSupervisor(engineDir)

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'PCB Studio',
    backgroundColor: '#0e1014',
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.pcbstudio.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  ipcMain.handle('engine:call', (_e, method: string, params?: unknown) => engine.call(method, params))
  ipcMain.handle('engine:status', () => engine.status)
  ipcMain.handle('engine:kill', () => engine.kill())
  ipcMain.handle('app:defaultProject', () => process.env.PCBSTUDIO_PROJECT ?? null)
  ipcMain.handle('dialog:openProject', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Open hardware project', properties: ['openDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })
  engine.on('status', (s) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('engine:status', s)))
  engine.on('log', (line: string) => console.log('[engine]', line))
  engine.start()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => engine.stop())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
