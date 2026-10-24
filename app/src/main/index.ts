import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { join, resolve, sep } from 'path'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { EngineSupervisor } from './engine'
import { AgentHost, type AgentContext } from './agent'

// Dev: the engine project sits next to the app folder. A packaged .app lives elsewhere, so it falls back to the repo
// checkout until the engine is bundled.
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
const agent = new AgentHost(engine, (e) =>
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('agent:event', e))
)

// pcbfile://local/<absolute path> serves files of the open project only (datasheet PDFs for Chromium's viewer).
let projectRoot: string | null = null
const glbDir = (): string => join(app.getPath('userData'), 'glb')
protocol.registerSchemesAsPrivileged([
  { scheme: 'pcbfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

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
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      plugins: true // Chromium PDF viewer for datasheets
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('http')) shell.openExternal(details.url)
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

  protocol.handle('pcbfile', async (req) => {
    const cors = { 'Access-Control-Allow-Origin': '*' }
    const path = resolve(decodeURIComponent(new URL(req.url).pathname))
    const inside = (root: string | null): boolean => !!root && (path === root || path.startsWith(root + sep))
    if (!inside(projectRoot) && !inside(glbDir())) {
      return new Response('outside the open project', { status: 403, headers: cors })
    }
    const r = await net.fetch(pathToFileURL(path).toString())
    const headers = new Headers(r.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    if (path.toLowerCase().endsWith('.pdf')) headers.set('Content-Type', 'application/pdf')
    if (path.toLowerCase().endsWith('.glb')) headers.set('Content-Type', 'model/gltf-binary')
    return new Response(r.body, { status: r.status, headers })
  })

  ipcMain.handle('engine:call', (_e, method: string, params?: unknown) => engine.call(method, params))
  ipcMain.handle('engine:status', () => engine.status)
  ipcMain.handle('engine:kill', () => engine.kill())
  ipcMain.handle('agent:send', (_e, text: string, ctx: AgentContext) => {
    void agent.send(text, ctx)
  })
  ipcMain.handle('agent:cancel', () => agent.cancel())
  ipcMain.handle('agent:reset', () => agent.reset())
  ipcMain.handle('board:glb', async (_e, pcb: string) => {
    const r = (await engine.call('board.glb', { pcb, out_dir: glbDir() }, 600_000)) as { path: string; cached: boolean; size: number }
    return { ...r, url: 'pcbfile://local' + encodeURI(r.path) }
  })
  ipcMain.handle('app:defaultProject', () => process.env.PCBSTUDIO_PROJECT || null)
  ipcMain.handle('app:setProjectRoot', (_e, root: string) => {
    projectRoot = resolve(root)
  })
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
  ipcMain.handle('dialog:openProject', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { title: 'Open hardware project', properties: ['openDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : r.filePaths[0]
  })
  engine.on('status', (s) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('engine:status', s)))
  engine.on('notify', (n) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('engine:notify', n)))
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
