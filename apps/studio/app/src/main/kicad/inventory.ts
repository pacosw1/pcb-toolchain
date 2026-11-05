import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { find } from './cli.ts'
import { parse, children } from './sexpr.ts'
import { ReadOnlyIpc, ApiStatusError, field, decode, bufferField, integerField } from './ipc.ts'
import type { NativeInventory } from '../../shared/inspector.ts'

async function inventory(exe: string, file: string, socket: string, kind: 'pcb' | 'schematic'): Promise<NativeInventory['documents'][number]> {
  const child = spawn(exe, ['api-server', '--socket', socket, file], { cwd: path.dirname(file), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let ended = false, log = '', failure: Error | null = null
  const closed = new Promise<void>(resolve => {
    child.on('error', error => { failure = error; ended = true; resolve() })
    child.on('close', () => { ended = true; resolve() })
  })
  const append = (chunk: Buffer): void => { log = (log + chunk.toString()).slice(-2000) }
  child.stdout.on('data', append); child.stderr.on('data', append)
  const lifetime = setTimeout(() => {
    if (!ended && child.pid) {
      failure = new Error('KiCad API inspection exceeded 60 seconds')
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ }
    }
  }, 60_000)
  let client: ReadOnlyIpc | null = null
  try {
    const deadline = Date.now() + 15_000
    let version: Buffer | null = null
    while (Date.now() < deadline) {
      if (ended) throw failure ?? new Error(`Headless API unavailable: ${log.trim() || 'KiCad exited'}`)
      try {
        client ??= await ReadOnlyIpc.connect(socket)
        version = await client.request('GetVersion'); break
      } catch (error) {
        if (error instanceof ApiStatusError && error.status !== 4 && error.status !== 7) throw error
        client?.close(); client = null
        await delay(100)
      }
    }
    if (!client || !version) throw new Error('KiCad headless API did not become ready within 15 seconds')
    const versionFields = bufferField(version, 1)
    const versionText = bufferField(versionFields, 4).toString() || [1, 2, 3].map(tag => integerField(versionFields, tag)).join('.')
    const docs = decode(await client.request('GetOpenDocuments', Buffer.from([8, kind === 'pcb' ? 3 : 1]))).filter(([tag]) => tag === 1)
    if (!docs.length || docs.length > 1000) throw new Error('Unexpected number of open documents')
    const counts: Record<string, number> = Object.create(null)
    for (const [, doc] of docs) {
      if (!Buffer.isBuffer(doc)) throw new Error('Malformed document specifier')
      const reply = await client.request('GetItems', field(1, field(1, doc)))
      if (integerField(reply, 2) !== 1) throw new Error('KiCad could not enumerate document items')
      for (const [tag, item] of decode(reply)) {
        if (tag !== 3) continue
        if (!Buffer.isBuffer(item)) throw new Error('Malformed KiCad item')
        const type = bufferField(item, 1).toString().replace(/^type.googleapis.com\/kiapi\.(?:board|schematic)\.types\./, '')
        counts[type] = (counts[type] ?? 0) + 1
      }
    }
    return { kind, path: file, version: versionText, documents: docs.length, counts }
  } finally {
    clearTimeout(lifetime)
    client?.close()
    const stop = (signal: NodeJS.Signals): void => {
      if (ended || !child.pid) return
      try { if (process.platform === 'win32') child.kill(signal); else process.kill(-child.pid, signal) } catch { /* already gone */ }
    }
    stop('SIGTERM')
    await Promise.race([closed, delay(1500)])
    if (!ended) { stop('SIGKILL'); await Promise.race([closed, delay(1500)]) }
    if (!ended) throw new Error('KiCad API process cleanup could not be confirmed')
  }
}

export async function nativeInventory(root: string, pcb: string, sch: string | null): Promise<NativeInventory> {
  if (!pcb.endsWith('.kicad_pcb') || (sch !== null && !sch.endsWith('.kicad_sch'))) throw new Error('Expected KiCad PCB and schematic paths')
  if (process.platform === 'win32') throw new Error('Headless IPC inspection currently requires macOS or Linux')
  const exe = find()
  if (!exe) throw new Error('KiCad CLI is not configured')
  root = await fs.realpath(root)
  // Short path keeps Unix socket names below the macOS length limit.
  const temp = await fs.mkdtemp('/tmp/pcb-ipc-')
  const sources = new Map<string, { bytes: Buffer; relative: string }>()
  let total = 0
  try {
    async function copy(relative: string): Promise<string> {
      const file = await fs.realpath(path.resolve(root, relative))
      if (!file.startsWith(root + path.sep)) throw new Error('Schematic dependency leaves the project')
      const target = path.join(temp, path.relative(root, file))
      if (sources.has(file)) return target
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || sources.size >= 256) throw new Error('Project snapshot limit exceeded')
      const bytes = await fs.readFile(file)
      total += bytes.length
      if (total > 64 * 1024 * 1024) throw new Error('Project snapshot exceeds 64 MiB')
      sources.set(file, { bytes, relative: path.relative(root, file) })
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes, { mode: 0o400 })
      if (file.endsWith('.kicad_sch')) {
        const tree = parse(bytes.toString('utf8'))
        for (const sheet of children(tree, 'sheet')) {
          const property = children(sheet, 'property').find(p => String(p[1]).toLowerCase() === 'sheetfile')
          const name = property?.[2]
          if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('${')) throw new Error('Unsupported schematic sheet path')
          const dependency = path.resolve(path.dirname(file), name)
          // Preserve literal relative paths; symlink relocation would change sheet resolution.
          if (await fs.realpath(dependency) !== dependency) throw new Error('Linked schematic sheets are not supported')
          await copy(path.relative(root, dependency))
        }
      }
      return target
    }
    const board = await copy(pcb)
    const schematic = sch ? await copy(sch) : null
    for (const file of [pcb, sch].filter((s): s is string => s !== null)) {
      const companion = file.replace(/\.kicad_(pcb|sch)$/, '.kicad_pro')
      try { await copy(companion) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const documents = [await inventory(exe, board, path.join(temp, 'board.sock'), 'pcb')]
    documents[0].path = pcb
    if (schematic) { const doc = await inventory(exe, schematic, path.join(temp, 'sch.sock'), 'schematic'); doc.path = sch!; documents.push(doc) }
    const evidence: NativeInventory['sources'] = []
    for (const [file, source] of sources) {
      const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
      if (sha(await fs.readFile(file)) !== sha(source.bytes)) throw new Error('Project changed during API inspection. Refresh to inspect the current revision.')
      evidence.push({ path: source.relative, sha256: sha(source.bytes) })
    }
    return { capturedAt: new Date().toISOString(), sources: evidence, documents }
  } finally { await fs.rm(temp, { recursive: true, force: true }) }
}
