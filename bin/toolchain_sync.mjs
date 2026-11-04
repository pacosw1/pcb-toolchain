#!/usr/bin/env node
// Copy the tools/ tree of this pcb-toolchain release into a project, read-only, ignored by git.
//
//   node bin/toolchain_sync.mjs PROJECT [--no-exclude]
//
// The project tracks only its own scripts in tools/ (board builders, fab scripts). The pinned release supplies the
// rest. After this, PROJECT/tools/... holds both, at the same paths as before the split, so file-relative tool code
// and gate provenance (tools/<path> + sha256) do not change.
//
// - PROJECT/tools/.toolchain-version holds "<version> <sha>"; same stamp and all files present = nothing to do.
// - PROJECT/tools/.toolchain-files lists the copied files; a new version first removes the old list.
// - A project file at a toolchain path is an error, unless its content is identical (then it is left alone).
// - Copies are read-only: change a tool in the pcb-toolchain repo and release it, not here.
// - Unless --no-exclude, the copied paths go into the git common dir info/exclude (one marked block).
// Prints one line: PASS/FAIL.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The marker names the old script on purpose: projects already hold blocks with this exact text.
const BEGIN = '# pcb-toolchain begin (bin/toolchain_sync.py)'
const END = '# pcb-toolchain end'

const digest = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const lexists = p => { try { fs.lstatSync(p); return true } catch { return false } }
const isFile = p => { try { return fs.statSync(p).isFile() } catch { return false } }
const read = p => fs.readFileSync(p, 'utf8')

function releaseFiles(bundle) {
  const tools = path.join(bundle, 'tools')
  const out = []
  const walk = folder => {                          // files of a folder first, then its folders; links to folders are skipped
    const dirs = [], files = []
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      const p = path.join(folder, e.name)
      if (e.isDirectory()) dirs.push(e.name)
      else if (!(e.isSymbolicLink() && fs.existsSync(p) && fs.statSync(p).isDirectory())) files.push(e.name)
    }
    for (const name of files.sort()) if (!name.endsWith('.pyc')) out.push(path.relative(tools, path.join(folder, name)))
    for (const name of dirs.sort()) if (name !== '__pycache__') walk(path.join(folder, name))
  }
  walk(tools)
  return out
}

function exclude(project, rels) {
  let common
  try {
    common = execFileSync('git', ['-C', project, 'rev-parse', '--git-common-dir'],
                          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return 'no git' }
  const file = path.resolve(project, common, 'info', 'exclude')   // resolve, not join: a worktree's common dir is absolute
  fs.mkdirSync(path.dirname(file), { recursive: true })
  let text = fs.existsSync(file) ? read(file) : ''
  if (text.includes(BEGIN) && text.includes(END)) {
    const at = text.indexOf(BEGIN), rest = text.slice(at + BEGIN.length)
    text = text.slice(0, at) + rest.slice(rest.indexOf(END) + END.length).replace(/^\n+/, '')
  }
  const block = [BEGIN, '/tools/.toolchain-version', '/tools/.toolchain-files', ...rels.map(r => '/tools/' + r), END]
  fs.writeFileSync(file, text.replace(/\n+$/, '') + (text.trim() ? '\n' : '') + block.join('\n') + '\n')
  return 'excluded'
}

function main(argv) {
  const args = argv.filter(a => !a.startsWith('--'))
  if (args.length !== 1) { console.error('usage: toolchain_sync.mjs PROJECT [--no-exclude]'); return 2 }
  let project = path.resolve(args[0])
  try { project = fs.realpathSync(project) } catch { /* a missing project is created below, as a path */ }
  const bundle = path.dirname(path.dirname(fs.realpathSync(fileURLToPath(import.meta.url))))
  const stampText = read(path.join(bundle, 'VERSION')).trim()
  const tools = path.join(project, 'tools')
  const stamp = path.join(tools, '.toolchain-version')
  const listing = path.join(tools, '.toolchain-files')
  const rels = releaseFiles(bundle)
  if (fs.existsSync(stamp) && read(stamp).trim() === stampText && rels.every(r => fs.existsSync(path.join(tools, r)))) return 0
  const ours = new Set(fs.existsSync(listing) ? read(listing).split('\n').filter(Boolean) : [])
  const collision = r => console.error(`FAIL: toolchain_sync: project file tools/${r} differs from pcb-toolchain ${stampText}; ` +
                                       'move it to the pcb-toolchain repo or rename it')
  for (const r of rels) {                           // check every path first: a collision changes nothing
    const src = path.join(bundle, 'tools', r), dst = path.join(tools, r)
    if (!ours.has(r) && lexists(dst) && !(isFile(dst) && digest(dst) === digest(src))) { collision(r); return 1 }
  }
  for (const r of ours) {
    const p = path.join(tools, r)
    if (lexists(p)) { fs.chmodSync(p, 0o600); fs.unlinkSync(p) }
  }
  const copied = []
  let kept = 0
  for (const r of rels) {
    const src = path.join(bundle, 'tools', r), dst = path.join(tools, r)
    if (lexists(dst)) {
      if (isFile(dst) && digest(dst) === digest(src)) { kept += 1; continue }
      collision(r)
      return 1
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
    const st = fs.statSync(src)
    fs.utimesSync(dst, st.atime, st.mtime)
    fs.chmodSync(dst, st.mode & 0o100 ? 0o555 : 0o444)
    copied.push(r)
  }
  fs.writeFileSync(listing, copied.join('\n') + '\n')
  fs.writeFileSync(stamp, stampText + '\n')
  const how = argv.includes('--no-exclude') ? 'not excluded' : exclude(project, copied)
  console.error(`PASS: toolchain_sync: pcb-toolchain ${stampText} -> ${tools} (${copied.length} copied, ${kept} identical, ${how})`)
  return 0
}

process.exit(main(process.argv.slice(2)))
