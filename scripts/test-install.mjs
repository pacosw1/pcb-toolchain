import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'install.sh')
test('a pinned local bundle must match the project lock', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-local-install-')))
  t.after(() => {
    const writable = dir => { fs.chmodSync(dir, 0o700); for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) writable(path.join(dir, entry.name)) }
    writable(root); fs.rmSync(root, { recursive: true, force: true })
  })
  const bundle = path.join(root, 'pcb-toolchain-1.0.0'), home = path.join(root, 'home'), archive = path.join(root, 'bundle.tar.gz')
  fs.mkdirSync(path.join(bundle, 'bin'), { recursive: true }); fs.mkdirSync(home)
  fs.writeFileSync(path.join(bundle, 'bin/pcb'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  execFileSync('tar', ['-czf', archive, '-C', root, 'pcb-toolchain-1.0.0'])
  const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), lock = path.join(root, 'lock.json')
  fs.writeFileSync(lock, JSON.stringify({ version: '1.0.0', sha256: '0'.repeat(64) }))
  let result = spawnSync('sh', [script, '--lock', lock, archive], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.notEqual(result.status, 0); assert.match(result.stderr + result.stdout, /sha256/)
  assert.equal(fs.existsSync(path.join(home, '.local/bin/pcb')), false)
  fs.writeFileSync(lock, JSON.stringify({ version: '1.0.0', sha256: digest }))
  result = spawnSync('sh', [script, '--lock', lock, archive], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.equal(fs.readFileSync(path.join(home, '.local/share/pcb-toolchain/1.0.0.sha256'), 'utf8').trim(), digest)
  assert.equal(fs.realpathSync(path.join(home, '.local/bin/pcb')), path.join(home, '.local/share/pcb-toolchain/1.0.0/bin/pcb'))
})
