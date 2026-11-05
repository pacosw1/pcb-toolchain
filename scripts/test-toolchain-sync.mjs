// node --test scripts/test-toolchain-sync.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeBundleManifest } from './write-bundle-manifest.mjs'
import { gateTools } from '../tools/lib/gate-inputs.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/toolchain_sync.mjs')
const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }

test('release manifest is sorted, source-bound, and ASCII escaped', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-manifest-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  write(path.join(root, 'z', 'é.txt'), 'abc')
  write(path.join(root, 'a'), 'abc')
  write(path.join(root, '2'), 'abc')
  write(path.join(root, '10'), 'abc')
  assert.equal(writeBundleManifest(root, 'v☃', 'abc123'), 4)
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), `{
 "files": {
  "10": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "2": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "a": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "z/\\u00e9.txt": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
 },
 "schema": "pcb-toolchain.manifest.v1",
 "source_sha": "abc123",
 "version": "v\\u2603"
}`)
})

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

test('candidate build and snapshot share their complete static source policy after sync', t => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const shared = new Set(fs.readFileSync(path.join(repo, 'manifest/shared-paths.txt'), 'utf8').split(/\r?\n/))
  const entries = ['tools/lib/pcb-workflow.ts', 'tools/lib/pcb-sources.ts']
  const files = gateTools(repo, entries.map(name => path.join(repo, name))).map(name => path.relative(repo, name))
  assert.ok(files.includes('tools/lib/pcb-source-policy.ts'))
  for (const name of files) assert.ok(shared.has(name), `${name} missing from shared manifest`)
  const { project, bundle } = setup(t)
  const content = Object.fromEntries(files.map(name => [name.slice('tools/'.length), fs.readFileSync(path.join(repo, name))]))
  const result = bundle('build-sources', '1.0.0 build-sources', content)([project])
  assert.equal(result.status, 0, result.stderr)
  for (const name of entries) {
    const module = pathToFileURL(path.join(project, name)).href
    const imported = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(module)})`], { cwd: project, encoding: 'utf8' })
    assert.equal(imported.status, 0, `${name}: ${imported.stderr}`)
  }
})

test('release archive and project sync keep guarded entrypoints importable', { timeout: 30000 }, t => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-bundle-')))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const repo = path.join(temp, 'repo'), bundle = path.join(temp, 'bundle'), project = path.join(temp, 'project')
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const recipe = fs.readFileSync(path.join(source, 'scripts/build-bundle.sh'), 'utf8')
  assert.match(recipe, /git archive --format=tar HEAD tools bin/)
  for (const name of ['tools', 'bin']) {
    fs.cpSync(path.join(source, name), path.join(repo, name), { recursive: true, filter: p => !['node_modules', 'target', '__pycache__'].includes(path.basename(p)) && !p.endsWith('.pyc') })
  }
  const app = path.join(repo, 'apps/job-daemon/src')
  fs.mkdirSync(app, { recursive: true })
  for (const name of ['client.ts', 'types.ts']) fs.copyFileSync(path.join(source, 'apps/job-daemon/src', name), path.join(app, name))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024 })
  git('init', '-q'); git('add', 'tools', 'bin', 'apps'); git('-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  fs.mkdirSync(bundle); fs.mkdirSync(project)
  const unpack = (data, args = []) => {
    const result = spawnSync('tar', ['-xf', '-', '-C', bundle, ...args], { input: data, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  unpack(git('archive', '--format=tar', 'HEAD', 'tools', 'bin'))
  fs.mkdirSync(path.join(bundle, 'tools/pcb-job'), { recursive: true })
  const clientArchive = git('archive', '--format=tar', 'HEAD', 'apps/job-daemon/src/client.ts', 'apps/job-daemon/src/types.ts')
  const client = spawnSync('tar', ['-xf', '-', '-C', path.join(bundle, 'tools/pcb-job'), '--strip-components=3'], { input: clientArchive, encoding: 'utf8' })
  assert.equal(client.status, 0, client.stderr)
  fs.writeFileSync(path.join(bundle, 'VERSION'), '0.0.0 fixture\n')
  const sync = spawnSync(process.execPath, [path.join(bundle, 'bin/toolchain_sync.mjs'), project], { encoding: 'utf8' })
  assert.equal(sync.status, 0, sync.stderr)

  // Import without running a board or a daemon. The files must be resolvable in
  // the project after the real archive-and-sync path, including job client files.
  const modules = ['tools/pcbtool.ts', 'tools/kicad_happy_gate.ts', 'tools/rf_lines.ts', 'tools/placement_outcomes.ts', 'tools/pcb-job/client.ts']
  for (const module of modules) {
    const url = pathToFileURL(path.join(project, module)).href
    const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { cwd: project, encoding: 'utf8', env: { ...process.env, IOT_LAB: project } })
    assert.equal(run.status, 0, `${module}: ${run.stderr}`)
  }
  const dispatch = spawnSync(process.execPath, [path.join(project, 'tools/router/route-dispatch.mjs')], { cwd: project, encoding: 'utf8', env: { ...process.env, IOT_LAB: project } })
  assert.equal(dispatch.status, 2, dispatch.stderr)
  assert.match(dispatch.stderr, /usage: route-dispatch/)
  // Negative control: a missing transitive import must make the check fail.
  fs.unlinkSync(path.join(project, 'tools/lib/daemon-job.ts'))
  const missing = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(project, 'tools/pcbtool.ts')).href)})`], { cwd: project, encoding: 'utf8', env: { ...process.env, IOT_LAB: project } })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/)
})
