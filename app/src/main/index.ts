import { app, shell, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { join, resolve, sep } from 'path'
import { realpathSync } from 'fs'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { EngineSupervisor } from './engine'
import { AgentHost, type AgentContext } from './agent'
import { engineDir } from './config'

// pcbfile://local/<absolute path> serves files of the open project only (datasheet PDFs for Chromium's viewer).
// The open project is the root of the engine's last project.open result: main reads it from the engine reply,
// never from a renderer argument.
let projectRoot: string | null = null
const engine = new EngineSupervisor(engineDir(app.getAppPath(), process.resourcesPath))
const agent = new AgentHost(
  engine,
  (e) => BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('agent:event', e)),
  () => projectRoot
)

async function engineCall(method: string, params?: unknown): Promise<unknown> {
  const result = await engine.call(method, params)
  if (method === 'project.open') {
    const root = (result as { root?: unknown }).root
    if (typeof root === 'string') projectRoot = realpathSync(root)
  }
  return result
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}
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
    const path = realOrNull(resolve(decodeURIComponent(new URL(req.url).pathname)))
    if (!path) return new Response('not found', { status: 404, headers: cors })
    const inside = (root: string | null): boolean => !!root && path.startsWith(root + sep)
    if (!inside(projectRoot) && !inside(realOrNull(glbDir()))) {
      return new Response('outside the open project', { status: 403, headers: cors })
    }
    const r = await net.fetch(pathToFileURL(path).toString())
    const headers = new Headers(r.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    if (path.toLowerCase().endsWith('.pdf')) headers.set('Content-Type', 'application/pdf')
    if (path.toLowerCase().endsWith('.glb')) headers.set('Content-Type', 'model/gltf-binary')
    return new Response(r.body, { status: r.status, headers })
  })

  ipcMain.handle('engine:call', (_e, method: string, params?: unknown) => engineCall(method, params))
  ipcMain.handle('engine:status', () => engine.status)
  ipcMain.handle('engine:kill', () => engine.kill())
  ipcMain.handle('agent:send', (_e, text: string, ctx: AgentContext) => {
    void agent.send(text, ctx)
  })
  ipcMain.handle('agent:cancel', () => agent.cancel())
  ipcMain.handle('agent:reset', () => agent.reset())
  ipcMain.handle('board:glb', async (_e, pcb: string) => {
    const r = (await engine.call('board.glb', { pcb, out_dir: glbDir() })) as { path: string; cached: boolean; size: number }
    return { ...r, url: 'pcbfile://local' + encodeURI(r.path) }
  })
  ipcMain.handle('app:defaultProject', () => process.env.PCBSTUDIO_PROJECT || null)
  // Kept for the renderer API: main already took the root from the engine's project.open reply. A different root is
  // refused (the renderer cannot widen pcbfile://).
  ipcMain.handle('app:setProjectRoot', (_e, root: string) => {
    if (realOrNull(resolve(String(root))) !== projectRoot) {
      throw new Error('setProjectRoot: not the project the engine opened')
    }
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
