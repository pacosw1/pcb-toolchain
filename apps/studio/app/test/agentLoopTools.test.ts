import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { AgentHost } from '../src/main/agent.ts'

test('agent exposes bounded opt-in decision tools through the same engine API and no adoption tool', async () => {
  const calls: { method: string; params: unknown }[] = [],
    tools = new Map<
      string,
      {
        schema: Record<string, z.ZodType>
        run: (args: Record<string, unknown>) => Promise<unknown>
      }
    >()
  const engine = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params })
      return { id: 'loop-0123456789abcdef', status: 'running' }
    }
  }
  const sdk = {
    tool: (
      name: string,
      _description: string,
      schema: Record<string, z.ZodType>,
      run: (args: Record<string, unknown>) => Promise<unknown>
    ) => {
      tools.set(name, { schema, run })
      return { name }
    },
    createSdkMcpServer: (value: unknown) => value
  }
  const host = new AgentHost(
    engine as never,
    () => undefined,
    () => '/fixture'
  )
  ;(host as unknown as { tools: (s: unknown, c: unknown) => unknown }).tools(sdk, {
    projectRoot: '/fixture',
    pcb: 'X.kicad_pcb',
    gate: 'X'
  })
  const start = tools.get('start_loop')!
  assert.equal(z.object(start.schema).safeParse({ experimental: false }).success, false)
  const args = z
    .object(start.schema)
    .parse({ experimental: true, max_rounds: 2, deadline_s: 90 }) as Record<string, unknown>
  await start.run(args)
  const p = calls[0]!.params as {
    board: string
    policy: {
      experimental: boolean
      max_rounds: number
      deadline_s: number
      route: { keep: string }
    }
  }
  assert.equal(calls[0]!.method, 'loop.start')
  assert.equal(p.board, 'X')
  assert.equal(p.policy.experimental, true)
  assert.equal(p.policy.max_rounds, 2)
  assert.equal(p.policy.route.keep, 'all')
  const reason = 'The report reached its work cap; preserve $(not-a-command) as literal evidence.'
  await tools
    .get('decide_loop')!
    .run({ id: 'loop-0123456789abcdef', revision: 4, reason, move: { kind: 'stop' } })
  assert.deepEqual(calls[1], {
    method: 'loop.decide',
    params: {
      id: 'loop-0123456789abcdef',
      revision: 4,
      decision: { reason, move: { kind: 'stop' } }
    }
  })
  await tools.get('wait_loop')!.run({ id: 'loop-0123456789abcdef', wait_s: 20 })
  assert.equal(calls[2]!.method, 'loop.wait')
  assert.equal(
    [...tools.keys()].some((name) => name.includes('adopt')),
    false
  )
})
