import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loopCommand, startRouteLoop } from '../src/main/routeLoops.ts'
import { READ_ONLY } from '../src/main/web.ts'

test('Studio uses the shared CLI protocol, keeps reasons as data and requires explicit opt-in', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'studio-loops-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'tools'))
  assert.deepEqual(await loopCommand(root, 'list'), [])
  await assert.rejects(
    startRouteLoop(root, 'X', { experimental: true }),
    /toolchain without routing loops/
  )
  writeFileSync(join(root, 'tools/pcb-loop.ts'), '// fixture capability marker\n')
  const tool = join(root, 'tools/pcb')
  writeFileSync(
    tool,
    `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync('calls.jsonl',JSON.stringify(a)+'\\n');
if(a[3]==='start'){const p=a[a.indexOf('--policy')+1];fs.writeFileSync('policy-copy.json',fs.readFileSync(p));}
console.log(JSON.stringify({id:'loop-0123456789abcdef',status:'running'}));
`
  )
  chmodSync(tool, 0o755)
  await assert.rejects(startRouteLoop(root, 'X', { experimental: false }), /explicitly/)
  await startRouteLoop(root, 'X', {
    experimental: true,
    max_rounds: 2,
    deadline_s: 60,
    route: { schema: 'test' }
  })
  const reason = 'Keep $(touch NEVER) and `touch NEVER2` as literal text.'
  await loopCommand(root, 'decide', [
    'loop-0123456789abcdef',
    '--revision',
    '3',
    '--decision-json',
    JSON.stringify({ reason, move: { kind: 'stop' } })
  ])
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x) as string[])
  assert.deepEqual(calls[0]!.slice(0, 5), ['--project', root, 'loop', 'start', 'X'])
  assert.ok(calls[0]!.includes('--experimental'))
  assert.equal(JSON.parse(readFileSync(join(root, 'policy-copy.json'), 'utf8')).experimental, true)
  assert.equal(JSON.parse(calls[1]![calls[1]!.indexOf('--decision-json') + 1]!).reason, reason)
  for (const name of ['loop.start', 'loop.decide', 'loop.cancel', 'loop.status', 'loop.wait'])
    assert.equal(READ_ONLY.has(name), false, 'viewer must not mutate/reconcile loop execution')
})
