// Engine supervisor lifecycle, with fake engine scripts (no real engine). Timers that wait for a restart are mocked;
// every wait for a process is a wait for a status event.
// Run: node --no-warnings --experimental-strip-types --test test/engine.test.ts
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, type TestContext } from 'node:test'
import type { EngineStatus } from '../src/preload/types.ts'
import { EngineSupervisor } from '../src/main/engine.ts'

const wsPath = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve('ws')), 'wrapper.mjs')).href
const HOLD = `process.stdin.on('end', () => process.exit(0)); process.stdin.resume()\n`
const SCRIPTS = {
  /** Ends at once, like a crashing engine. */
  exits: `process.exit(1)\n`,
  /** Runs until stdin ends, never says READY. */
  holds: HOLD,
  /** Says READY, and closes the socket at the first message without a reply. */
  hangsUp: `import { WebSocketServer } from ${JSON.stringify(wsPath)}
const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
wss.on('listening', () => console.log('READY ' + JSON.stringify({ port: wss.address().port })))
wss.on('connection', (socket) => socket.on('message', () => socket.close()))
${HOLD}`
}

function supervisor(t: TestContext, script: keyof typeof SCRIPTS): EngineSupervisor {
  const dir = mkdtempSync(join(tmpdir(), 'engine-test-'))
  const entry = join(dir, 'engine.mjs')
  writeFileSync(entry, SCRIPTS[script])
  const sup = new EngineSupervisor(entry)
  t.after(async () => {
    sup.stop()
    sup.kill()
    await status(sup, (s) => s.state === 'stopped')
    rmSync(dir, { recursive: true, force: true })
  })
  return sup
}

/** Resolves when the status satisfies the test: now, or at a later status event. */
function status(sup: EngineSupervisor, test: (s: EngineStatus) => boolean): Promise<EngineStatus> {
  if (test(sup.status)) return Promise.resolve(sup.status)
  return new Promise((resolve) => {
    const on = (s: EngineStatus): void => {
      if (!test(s)) return
      sup.off('status', on)
      resolve(s)
    }
    sup.on('status', on)
  })
}

test('stop during the restart wait cancels the restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const sup = supervisor(t, 'exits')
  const crashed = status(sup, (s) => s.state === 'restarting' && s.restarts === 1)
  sup.start()
  await crashed
  sup.stop()
  t.mock.timers.tick(60_000) // the backoff and the kill delay both pass
  assert.equal(sup.status.state, 'stopped')
  assert.equal(sup.status.pid, null)
})

test('a start while the engine process lives starts no second process', async (t) => {
  const sup = supervisor(t, 'holds')
  sup.start()
  const pid = sup.status.pid
  assert.ok(pid)
  sup.start()
  assert.equal(sup.status.pid, pid)
})

test('a start after a stop is a new start', async (t) => {
  const sup = supervisor(t, 'holds')
  sup.start()
  const first = sup.status.pid
  sup.stop()
  await status(sup, (s) => s.state === 'stopped')
  sup.start()
  assert.ok(sup.status.pid && sup.status.pid !== first)
})

test('a socket the engine closed fails the waiting call and restarts the engine', { timeout: 15_000 }, async (t) => {
  const sup = supervisor(t, 'hangsUp')
  sup.start()
  await status(sup, (s) => s.state === 'ready')
  const first = sup.status.pid
  await assert.rejects(sup.call('anything'), /engine connection closed/)
  assert.notEqual(sup.status.state, 'ready')
  const again = await status(sup, (s) => s.state === 'ready' && s.pid !== first)
  assert.equal(again.restarts, 1)
})
