// The one kicad-cli wrapper. Every call of kicad-cli in the engine goes through this module.
// Async: a slow KiCad run must not block the engine's other calls.
//
// Executable: env PCBSTUDIO_KICAD_CLI, then `kicad-cli` on PATH, then the macOS KiCad app. Each run has a timeout;
// a failure raises KiCadCliError with the exit code and the end of the log.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MAC_APP = '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli'
const DEFAULT_TIMEOUT_S = 600
const VERSION_TIMEOUT_S = 20

export type Defines = Record<string, string>
export type Report = Record<string, unknown>

export class KiCadCliError extends Error {
  readonly returncode: number | null
  readonly log: string
  constructor(msg: string, returncode: number | null = null, log = '') {
    super(msg + (log ? `:\n${log.slice(-800)}` : ''))
    this.returncode = returncode
    this.log = log
  }
}

export interface Result {
  args: string[]
  returncode: number
  log: string                       // stdout and stderr, in arrival order
}

const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile() } catch { return false } }

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir || '.', name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (isFile(p)) return p
    } catch { /* next folder */ }
  }
  return null
}

export function find(): string | null {
  const env = process.env.PCBSTUDIO_KICAD_CLI
  if (env) return isFile(env) ? env : null
  return onPath('kicad-cli') ?? (isFile(MAC_APP) ? MAC_APP : null)
}

function executable(): string {
  const exe = find()
  if (!exe) throw new KiCadCliError('kicad-cli not found (set PCBSTUDIO_KICAD_CLI, add it to PATH or install KiCad)')
  return exe
}

interface Exit { code: number, log: string, stdout: string }

/** Run to its exit. Rejects with a KiCadCliError on a timeout or when it cannot start. */
function exec(cmd: string[], timeoutS: number, cwd?: string, env?: NodeJS.ProcessEnv): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], cmd.slice(1), { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const log: Buffer[] = [], stdout: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => { log.push(d); stdout.push(d) })
    child.stderr.on('data', (d: Buffer) => { log.push(d) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new KiCadCliError(`kicad-cli ${cmd.slice(1, 4).join(' ')} timed out after ${timeoutS} s`, null,
                               Buffer.concat(log).toString()))
    }, timeoutS * 1000)
    child.on('error', e => {
      clearTimeout(timer)
      reject(new KiCadCliError(`kicad-cli could not start: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, log: Buffer.concat(log).toString(), stdout: Buffer.concat(stdout).toString() })
    })
  })
}

const versions = new Map<string, string | null>()

/** kicad-cli version text (e.g. '10.0.6'), null when it is missing or does not answer. */
export async function version(): Promise<string | null> {
  const exe = find()
  if (!exe) return null
  if (!versions.has(exe)) {
    let text: string | null = null
    try {
      const r = await exec([exe, 'version'], VERSION_TIMEOUT_S)
      text = r.code === 0 ? r.stdout.trim() || null : null
    } catch { /* stays null */ }
    versions.set(exe, text)
  }
  return versions.get(exe) ?? null
}

export interface RunOptions { timeoutS?: number, cwd?: string, check?: boolean, env?: NodeJS.ProcessEnv }

/** kicad-cli ARGS. check (default true) raises KiCadCliError on a non-zero exit. */
export async function run(args: string[], options: RunOptions = {}): Promise<Result> {
  const { timeoutS = DEFAULT_TIMEOUT_S, cwd, check = true } = options
  const cmd = [executable(), ...args]
  const r = await exec(cmd, timeoutS, cwd, options.env)
  if (check && r.code !== 0) {
    throw new KiCadCliError(`kicad-cli ${args.slice(0, 3).join(' ')} failed (exit ${r.code})`, r.code, r.log)
  }
  return { args: cmd, returncode: r.code, log: r.log }
}

const defineArgs = (defines?: Defines): string[] => Object.entries(defines ?? {}).flatMap(([k, v]) => ['-D', `${k}=${v}`])

async function jsonReport(args: string[], src: string, timeoutS: number, defines?: Defines): Promise<Report> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcbstudio-'))
  try {
    const out = path.join(dir, 'report.json')
    const res = await run([...args, ...defineArgs(defines), '--format', 'json', '--severity-all', '-o', out, src],
                          { timeoutS, cwd: path.dirname(src) })
    if (!isFile(out)) throw new KiCadCliError(`kicad-cli ${args.slice(0, 2).join(' ')} wrote no report`, res.returncode, res.log)
    return JSON.parse(fs.readFileSync(out, 'utf8')) as Report
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export interface DrcOptions { schematicParity?: boolean, refillZones?: boolean, defines?: Defines, timeoutS?: number }

/** `pcb drc` JSON report (all severities, mm). Parity on by default: DRC without parity is not evidence. */
export function drc(pcb: string, options: DrcOptions = {}): Promise<Report> {
  const { schematicParity = true, refillZones = false, defines, timeoutS = DEFAULT_TIMEOUT_S } = options
  const args = ['pcb', 'drc', '--units', 'mm']
  if (schematicParity) args.push('--schematic-parity')
  if (refillZones) args.push('--refill-zones')
  return jsonReport(args, pcb, timeoutS, defines)
}

/** `sch erc` JSON report (all severities). */
export function erc(sch: string, options: { defines?: Defines, timeoutS?: number } = {}): Promise<Report> {
  return jsonReport(['sch', 'erc', '--units', 'mm'], sch, options.timeoutS ?? DEFAULT_TIMEOUT_S, options.defines)
}

/** `sch export netlist` to OUT; returns OUT. */
export async function netlist(sch: string, out: string, options: { fmt?: string, timeoutS?: number } = {}): Promise<string> {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  await run(['sch', 'export', 'netlist', '--format', options.fmt ?? 'kicadsexpr', '-o', out, sch],
            { timeoutS: options.timeoutS, cwd: path.dirname(sch) })
  return out
}

export interface GlbResult { path: string, size: number, warnings: string[] }

/** Binary glTF of the board with part models, tracks, pads, zones, silk and mask. Written to a temp name and moved
 *  into place, so a failed run never leaves a partial OUT. */
export async function exportGlb(pcb: string, out: string, options: { defines?: Defines, timeoutS?: number } = {}): Promise<GlbResult> {
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const { dir, name } = path.parse(out)
  const tmp = path.join(dir, name + '.tmp.glb')
  const res = await run(['pcb', 'export', 'glb', '--force', '--subst-models', '--include-tracks', '--include-pads',
                         '--include-zones', '--include-silkscreen', '--include-soldermask', '--no-dnp',
                         ...defineArgs(options.defines), '-o', tmp, pcb],
                        { timeoutS: options.timeoutS, cwd: path.dirname(pcb), check: false })
  if (res.returncode !== 0 || !isFile(tmp)) {
    fs.rmSync(tmp, { force: true })
    throw new KiCadCliError(`kicad-cli glb export failed (exit ${res.returncode})`, res.returncode, res.log)
  }
  fs.renameSync(tmp, out)
  const warnings = res.log.split(/\r\n|\r|\n/).filter(ln => /not found|could not/i.test(ln))
  return { path: out, size: fs.statSync(out).size, warnings: warnings.slice(0, 30) }
}
