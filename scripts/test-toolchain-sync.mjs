// node --test scripts/test-toolchain-sync.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/toolchain_sync.mjs')
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sync-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const project = path.join(root, 'project')
  fs.mkdirSync(project)
  execFileSync('git', ['-C', project, 'init', '-q'])
  const bundle = (name, version, files) => {
    const dir = path.join(root, name)
    write(path.join(dir, 'VERSION'), version + '\n')
    fs.mkdirSync(path.join(dir, 'bin'))
    fs.copyFileSync(script, path.join(dir, 'bin/toolchain_sync.mjs'))
    for (const [k, v] of Object.entries(files)) write(path.join(dir, 'tools', k), v)
    return args => spawnSync('node', [path.join(dir, 'bin/toolchain_sync.mjs'), ...args], { encoding: 'utf8' })
  }
  return { project, bundle, exclude: () => fs.readFileSync(path.join(project, '.git/info/exclude'), 'utf8') }
}

test('copies read-only, skips bytecode, and a rerun does nothing', t => {
  const { project, bundle, exclude } = setup(t)
  const run = bundle('b', '1.0.0 aaa', { 'a.py': 'a', 'lib/x.mjs': 'x', '__pycache__/a.pyc': 'c' })
  const first = run([project])
  assert.equal(first.status, 0)
  assert.match(first.stderr, /^PASS: .*2 copied, 0 identical, excluded/)
  assert.equal(fs.statSync(path.join(project, 'tools/a.py')).mode & 0o777, 0o444)
  assert.equal(fs.existsSync(path.join(project, 'tools/__pycache__')), false)
  assert.ok(exclude().includes('/tools/lib/x.mjs'))
  assert.equal(run([project]).stderr, '')
})

test('an upgrade removes old files and replaces the exclude block, keeping other lines', t => {
  const { project, bundle, exclude } = setup(t)
  write(path.join(project, '.git/info/exclude'), '*.log\n')
  bundle('b1', '1.0.0 aaa', { 'old.py': 'o' })([project])
  assert.equal(bundle('b2', '2.0.0 bbb', { 'new.py': 'n' })([project]).status, 0)
  assert.equal(fs.existsSync(path.join(project, 'tools/old.py')), false)
  assert.ok(exclude().startsWith('*.log\n'))
  assert.ok(!exclude().includes('old.py'))
  assert.equal(exclude().match(/pcb-toolchain begin/g).length, 1)
})

test('a block written by the Python version is replaced', t => {
  const { project, bundle, exclude } = setup(t)
  write(path.join(project, '.git/info/exclude'), '# pcb-toolchain begin (bin/toolchain_sync.py)\n/tools/gone.py\n# pcb-toolchain end\n')
  bundle('b', '1.0.0 aaa', { 'a.py': 'a' })([project])
  assert.ok(!exclude().includes('gone.py'))
})

test('a differing project file fails and changes nothing', t => {
  const { project, bundle } = setup(t)
  write(path.join(project, 'tools/b.py'), 'mine')
  const run = bundle('b', '1.0.0 aaa', { 'a.py': 'a', 'b.py': 'b' })([project])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /^FAIL: .*tools\/b\.py differs/)
  assert.equal(fs.existsSync(path.join(project, 'tools/a.py')), false)
})

test('a worktree writes the exclude of its common git dir', t => {
  const { project, bundle, exclude } = setup(t)
  const git = (...a) => execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a])
  git('commit', '-q', '--allow-empty', '-m', 'x')
  const worktree = project + '-wt'
  git('worktree', 'add', '-q', worktree)
  assert.equal(bundle('b', '1.0.0 aaa', { 'a.py': 'a' })([worktree]).status, 0)
  assert.ok(exclude().includes('/tools/a.py'))
})

test('the 3D viewer and its metadata helper are listed and copied together', t => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const shared = new Set(fs.readFileSync(path.join(repo, 'manifest/shared-paths.txt'), 'utf8').split(/\r?\n/))
  const files = ['tools/board_3d.sh', 'tools/board3d/index.html', 'tools/board3d/metadata.mjs', 'tools/board3d/metadata.test.mjs']
  for (const name of files) assert.ok(shared.has(name), `${name} missing from shared manifest`)
  const { project, bundle } = setup(t)
  const content = Object.fromEntries(files.map(name => [name.slice('tools/'.length), fs.readFileSync(path.join(repo, name))]))
  const result = bundle('board3d', '1.0.0 board3d', content)([project])
  assert.equal(result.status, 0, result.stderr)
  for (const name of files) assert.deepEqual(fs.readFileSync(path.join(project, name)), fs.readFileSync(path.join(repo, name)))
})
