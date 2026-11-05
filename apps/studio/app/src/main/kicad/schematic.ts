import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { run, version } from './cli.ts'
import { parse, children } from './sexpr.ts'
import type { SchematicExport } from '../../shared/inspector.ts'

const DARK_THEME = {
  "meta": {
    "name": "Studio Dark",
    "version": 5
  },
  "schematic": {
    "background": "rgb(23,27,34)",
    "wire": "rgb(100,216,145)",
    "junction": "rgb(100,216,145)",
    "bus": "rgb(115,170,255)",
    "bus_junction": "rgb(115,170,255)",
    "component_body": "rgb(39,45,54)",
    "component_outline": "rgb(235,179,105)",
    "pin": "rgb(235,179,105)",
    "pin_name": "rgb(136,211,216)",
    "pin_number": "rgb(241,168,150)",
    "reference": "rgb(136,211,216)",
    "value": "rgb(136,211,216)",
    "label_local": "rgb(230,234,240)",
    "label_global": "rgb(241,168,150)",
    "label_hier": "rgb(235,207,130)",
    "note": "rgb(143,180,255)",
    "worksheet": "rgb(114,126,146)",
    "fields": "rgb(217,163,226)",
    "sheet": "rgb(235,179,105)",
    "sheet_name": "rgb(136,211,216)",
    "sheet_filename": "rgb(235,207,130)",
    "no_connect": "rgb(143,180,255)",
    "sheet_background": "rgba(0,0,0,0)",
    "note_background": "rgba(0,0,0,0)",
    "override_item_colors": true,
    "dnp_marker": "rgba(255,128,128,0.9)"
  }
}

/** Copy the assigned schematic and its in-project sheet closure before native export. */
export async function exportSchematic(root: string, schematic: string, outDir: string): Promise<SchematicExport> {
  root = await fs.realpath(root)
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-schematic-'))
  const inputs = new Map<string, Buffer>()
  let bytes = 0
  try {
    async function copy(relative: string): Promise<string> {
      const file = await fs.realpath(path.resolve(root, relative))
      if (!file.startsWith(root + path.sep)) throw new Error('Schematic sheet leaves the project')
      const dest = path.join(scratch, path.relative(root, file))
      if (inputs.has(file)) return dest
      const stat = await fs.stat(file)
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024 || inputs.size >= 256) throw new Error('Schematic snapshot limit exceeded')
      const content = await fs.readFile(file)
      bytes += content.length
      if (bytes > 64 * 1024 * 1024) throw new Error('Schematic snapshot exceeds 64 MiB')
      inputs.set(file, content)
      await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, content, { mode: 0o400 })
      if (file.endsWith('.kicad_sch')) {
        for (const sheet of children(parse(content.toString('utf8')), 'sheet')) {
          const property = children(sheet, 'property').find(p => String(p[1]).toLowerCase() === 'sheetfile')
          const name = property?.[2]
          if (typeof name !== 'string' || path.isAbsolute(name) || name.includes('${')) throw new Error('Unsupported schematic sheet path')
          const child = path.resolve(path.dirname(file), name)
          if (await fs.realpath(child) !== child) throw new Error('Linked child schematic files are not supported')
          await copy(path.relative(root, child))
        }
      }
      return dest
    }
    if (!schematic.endsWith('.kicad_sch')) throw new Error('Select a KiCad schematic')
    const input = await copy(schematic)
    const companion = schematic.replace(/\.kicad_sch$/, '.kicad_pro')
    try { await copy(companion) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const runtime = await version()
    const digest = createHash('sha256').update(root).update(runtime ?? '').update(JSON.stringify(DARK_THEME)).update('schematic-svg-dark-v1')
    for (const [file, content] of [...inputs].sort(([a], [b]) => a.localeCompare(b))) digest.update(file).update(content)
    const revision = digest.digest('hex')
    const rendered = path.join(scratch, 'svg')
    await fs.mkdir(rendered)
    const config = path.join(scratch, 'config'), configVersion = runtime?.match(/^(\d+\.\d+)/)?.[1] ?? '10.0'
    for (const directory of [path.join(config, 'colors'), path.join(config, configVersion, 'colors')]) {
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'studio-dark.json'), JSON.stringify(DARK_THEME))
    }
    await run(['sch', 'export', 'svg', '--theme', 'studio-dark', '--no-background-color', '--define-var', `IOT_LAB=${root}`,
      '--define-var', `KIPRJMOD=${path.dirname(path.resolve(root, schematic))}`, '-o', rendered, input], { timeoutS: 90, cwd: path.dirname(input), env: { KICAD_CONFIG_HOME: config } })
    for (const [file, content] of inputs) if (!(await fs.readFile(file)).equals(content)) throw new Error('Schematic changed during export. Refresh to load the current revision.')
    const rootSheet = path.basename(schematic, '.kicad_sch') + '.svg'
    const outputs = (await fs.readdir(rendered)).filter(name => name.toLowerCase().endsWith('.svg')).sort((a, b) =>
      a === rootSheet ? -1 : b === rootSheet ? 1 : a.localeCompare(b, undefined, { numeric: true }))
    if (!outputs.length) throw new Error('KiCad exported no schematic sheets')
    const cache = path.join(outDir, `schematic-${revision.slice(0, 24)}`)
    await fs.mkdir(cache, { recursive: true })
    const sheets: SchematicExport['sheets'] = []
    for (const name of outputs) {
      const file = path.join(rendered, name), stat = await fs.lstat(file)
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Unexpected schematic export file')
      const svg = await fs.readFile(file)
      if (!svg.toString('utf8', 0, 1000).includes('<svg')) throw new Error('KiCad exported an invalid SVG')
      const target = path.join(cache, name)
      const staged = target + `.${randomUUID()}.tmp`
      await fs.writeFile(staged, svg); await fs.rename(staged, target)
      sheets.push({ name: path.basename(name, '.svg'), path: target })
    }
    return { source: schematic, revision, runtime, sheets }
  } finally { await fs.rm(scratch, { recursive: true, force: true }) }
}
