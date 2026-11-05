// Native exports run only on a private copy. No save or editing API is exposed.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { find } from './cli.ts'
import { parseCsv } from '../bomcsv.ts'
import type { BoardInspection, InspectorSection } from '../../shared/inspector.ts'

async function execute(exe: string, args: string[], cwd: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = '', bytes = 0
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('KiCad export timed out after 30 seconds')) }, 30_000)
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) { child.kill('SIGKILL'); reject(new Error('KiCad output exceeded 2 MiB')) }
      else text += chunk.toString()
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, text }) })
  })
}
const section = <T>(state: InspectorSection<T>['state'], message: string): InspectorSection<T> => ({ state, data: null, message })
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

export async function inspectBoard(file: string, pcb: string): Promise<BoardInspection> {
  if (!file.endsWith('.kicad_pcb')) throw new Error('Select a KiCad PCB file')
  const bytes = await fs.readFile(file)
  const result: BoardInspection = { pcb, sourceSha256: hash(bytes), runtime: null, capturedAt: new Date().toISOString(),
    stats: section('unavailable', 'KiCad CLI is not configured.'), stackup: section('unavailable', 'KiCad CLI is not configured.'),
    bom: section('unavailable', 'KiCad CLI is not configured.') }
  const exe = find()
  if (!exe) return result
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcbstudio-inspect-'))
  try {
    const input = path.join(dir, path.basename(file))
    await fs.writeFile(input, bytes, { mode: 0o400 })
    // A project companion can contain board settings; copy bytes rather than allowing CLI access to the source.
    const projectFile = file.replace(/\.kicad_pcb$/, '.kicad_pro')
    try { await fs.writeFile(input.replace(/\.kicad_pcb$/, '.kicad_pro'), await fs.readFile(projectFile), { mode: 0o400 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const version = await execute(exe, ['version'], dir)
    result.runtime = version.code === 0 ? version.text.trim() : null
    async function exported<T>(kind: string, parse: (text: string) => T): Promise<InspectorSection<T>> {
      try {
        const help = await execute(exe!, ['pcb', 'export', kind, '--help'], dir)
        if (help.code !== 0) return section('unavailable', `This KiCad runtime does not offer ${kind} export.`)
        const output = path.join(dir, `export-${kind}`)
        const args = ['pcb', 'export', kind, ...(kind === 'bom' ? [] : ['--format', 'json']), '-o', output, input]
        const run = await execute(exe!, args, dir)
        if (run.code !== 0) return section('error', run.text.trim().slice(-1200) || `Export exited with code ${run.code}.`)
        if ((await fs.stat(output)).size > 8 * 1024 * 1024) throw new Error('Export exceeded 8 MiB')
        return { state: 'ready', data: parse(await fs.readFile(output, 'utf8')), message: null }
      } catch (error) { return section('error', String(error)) }
    }
    const object = (text: string): Record<string, unknown> => {
      const value: unknown = JSON.parse(text)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected export schema')
      return value as Record<string, unknown>
    }
    result.stats = await exported('stats', object)
    result.stackup = await exported('stackup', object)
    result.bom = await exported('bom', parseCsv)
    if (hash(await fs.readFile(file)) !== result.sourceSha256) throw new Error('Board changed during inspection. Refresh to inspect the current revision.')
    return result
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}
