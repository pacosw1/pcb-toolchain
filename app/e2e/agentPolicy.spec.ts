// Unit tests (no Electron): the agent tool policy and the run waiter.
import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { checkToolUse } from '../src/main/agentPolicy'
import { waitRunEnd } from '../src/main/agent'
import type { EngineSupervisor } from '../src/main/engine'

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'pcbstudio-policy-'))
  mkdirSync(join(root, 'hardware-design', 'registry'), { recursive: true })
  writeFileSync(join(root, 'hardware-design', 'registry', 'boards.json'), '{}')
  symlinkSync(homedir(), join(root, 'home-link')) // a symlink out of the project
  return root
}

test('agent tools: file reads stay inside the open project', () => {
  const root = project()
  const verdict = (tool: string, input: Record<string, unknown>, r: string | null = root): string =>
    checkToolUse(tool, input, r).behavior
  expect(verdict('Read', { file_path: join(homedir(), '.ssh', 'id_ed25519') })).toBe('deny')
  expect(verdict('Read', { file_path: join(root, 'hardware-design', 'registry', 'boards.json') })).toBe('allow')
  expect(verdict('Read', { file_path: join(root, '..', 'x') })).toBe('deny')
  expect(verdict('Read', { file_path: join(root, 'home-link', '.ssh', 'config') })).toBe('deny') // realpath check
  expect(verdict('Read', { file_path: join(root, 'boards.json') }, null)).toBe('deny') // no project open
  expect(verdict('Grep', { pattern: 'x', path: join(homedir(), '.ssh') })).toBe('deny')
  expect(verdict('Grep', { pattern: 'x' })).toBe('allow') // cwd = project
  expect(verdict('Grep', { pattern: 'x', glob: '../**' })).toBe('deny')
  expect(verdict('Glob', { pattern: '**/*.kicad_pcb', path: root })).toBe('allow')
  expect(verdict('Glob', { pattern: '/Users/*/.ssh/*' })).toBe('deny')
  expect(verdict('Glob', { pattern: '../../**' })).toBe('deny')
  expect(verdict('Glob', { pattern: '~/.ssh/*' })).toBe('deny')
  for (const t of ['WebFetch', 'Bash', 'Write', 'Edit', 'NotebookEdit']) expect(verdict(t, {})).toBe('deny')
  expect(verdict('WebSearch', { query: 'TPS2553 datasheet' })).toBe('allow')
  expect(verdict('mcp__pcb__bom', {})).toBe('allow')
})

class FakeEngine extends EventEmitter {
  generation = 1
  ended: Record<string, unknown> | null = null
  async call(): Promise<unknown> {
    return { summary: this.ended ?? { id: 'r-1', state: 'running' } }
  }
}

test('waitRunEnd: resolves on its run, rejects on timeout and on engine restart, always unsubscribes', async () => {
  const e = new FakeEngine()
  const eng = e as unknown as EngineSupervisor
  const p = waitRunEnd(eng, 'r-1', 5_000)
  e.emit('notify', { method: 'run.state', params: { id: 'r-other', state: 'passed' } })
  e.emit('notify', { method: 'run.state', params: { id: 'r-1', state: 'passed' } })
  await expect(p).resolves.toMatchObject({ id: 'r-1', state: 'passed' })
  expect(e.listenerCount('notify') + e.listenerCount('status')).toBe(0)

  await expect(waitRunEnd(eng, 'r-1', 50)).rejects.toThrow(/did not end/)
  expect(e.listenerCount('notify') + e.listenerCount('status')).toBe(0)

  const q = waitRunEnd(eng, 'r-1', 5_000)
  e.emit('status', { state: 'restarting' })
  await expect(q).rejects.toThrow(/engine restarted/)
  expect(e.listenerCount('notify') + e.listenerCount('status')).toBe(0)

  e.ended = { id: 'r-1', state: 'failed' } // ended before the waiter attached
  await expect(waitRunEnd(eng, 'r-1', 5_000)).resolves.toMatchObject({ state: 'failed' })
})
