// Agent host: one answer at a time, and every failure reaches the renderer as an event. The SDK is a fake whose
// query ends when the test says so, or throws when it is aborted.
// Run: node --no-warnings --experimental-strip-types --test test/agent.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentContext, AgentEvent } from '../src/preload/types.ts'
import { AgentHost } from '../src/main/agent.ts'

const CTX: AgentContext = { pcb: null, gate: null, selection: null, projectRoot: null } as unknown as AgentContext
/** One turn of the event loop: every promise that can settle has settled. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type Query = { signal: AbortSignal; finish: () => void }

function fixture(): { host: AgentHost; events: AgentEvent[]; queries: Query[] } {
  const events: AgentEvent[] = []
  const queries: Query[] = []
  const sdk = {
    tool: (name: string) => ({ name }),
    createSdkMcpServer: (options: unknown) => options,
    query: ({ options }: { options: { abortController: AbortController } }) => {
      const signal = options.abortController.signal
      let finish!: () => void
      const finished = new Promise<void>((resolve) => (finish = resolve))
      queries.push({ signal, finish })
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve, reject) => {
            void finished.then(resolve)
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
          yield { type: 'result', subtype: 'success', total_cost_usd: 0, duration_ms: 1, num_turns: 1 }
        }
      }
    }
  }
  const host = new AgentHost({} as never, (e) => events.push(e), () => null)
  ;(host as unknown as { sdk: unknown }).sdk = sdk
  return { host, events, queries }
}

test('two sends in one turn start one query, and the second says the agent is busy', async () => {
  const { host, events, queries } = fixture()
  const first = host.send('one', CTX)
  const second = host.send('two', CTX)
  await settle()
  assert.equal(queries.length, 1)
  assert.deepEqual(events.filter((e) => e.kind === 'error'), [{ kind: 'error', message: 'the agent is still answering' }])
  assert.equal(host.busy, true)
  queries[0].finish()
  await Promise.all([first, second])
  assert.equal(host.busy, false)
})

test('a failed SDK load is an error event, not a rejection, and the host stays idle', async () => {
  const { host, events } = fixture()
  ;(host as unknown as { load: () => Promise<never> }).load = async () => {
    throw new Error('sdk missing')
  }
  await host.send('one', CTX)
  assert.deepEqual(events, [{ kind: 'error', message: 'sdk missing' }])
  assert.equal(host.busy, false)
})

test('a cancelled answer ends quietly and does not clear the next answer', async () => {
  const { host, events, queries } = fixture()
  const old = host.send('one', CTX)
  await settle()
  host.cancel()
  const next = host.send('two', CTX)
  await settle()
  assert.equal(queries.length, 2)
  await old // the first query throws "aborted" now
  assert.equal(host.busy, true, 'the second answer is still running')
  assert.deepEqual(events, [], 'the cancelled answer says nothing')
  queries[1].finish()
  await next
  assert.equal(host.busy, false)
  assert.deepEqual(events.map((e) => e.kind), ['done'])
})
