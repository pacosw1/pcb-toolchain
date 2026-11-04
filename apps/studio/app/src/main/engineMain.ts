// The engine process and its commands. The app starts `engineMain serve` and owns it through its stdin.
//   engineMain serve [--port N] [--no-stdin-watch]
//   engineMain web --project DIR [--static DIR] [--glb-dir DIR] [--host H] [--port N] [--token-file F]
//   engineMain migrate --project DIR --out DIR
import path from 'node:path'
import { parseArgs } from 'node:util'
import { migrate } from './migrate.ts'
import { serve } from './server.ts'
import { DEFAULT_TOKEN_FILE, serveWeb } from './web.ts'

const [command, ...rest] = process.argv.slice(2)
const appDir = path.resolve(path.dirname(process.argv[1]), '../..')
const text = { type: 'string' } as const

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

if (command === 'serve') {
  const { values } = parseArgs({ args: rest, options: { port: text, 'no-stdin-watch': { type: 'boolean' } } })
  serve(Number(values.port ?? 0), !values['no-stdin-watch']).then(() => process.exit(0), (e: unknown) => {
    console.error(e)
    process.exit(1)
  })
} else if (command === 'web') {
  const { values: v } = parseArgs({ args: rest, options: { project: text, static: text, 'glb-dir': text, host: text, port: text, 'token-file': text } })
  if (!v.project) fail('web needs --project DIR')
  serveWeb({ project: v.project, staticDir: v.static ?? path.join(appDir, 'out-web'), glbDir: v['glb-dir'] ?? '~/Library/Caches/pcbstudio/glb',
             host: v.host ?? '127.0.0.1', port: Number(v.port ?? 8787), tokenFile: v['token-file'] ?? DEFAULT_TOKEN_FILE })
} else if (command === 'migrate') {
  const { values: v } = parseArgs({ args: rest, options: { project: text, out: text } })
  if (!v.project || !v.out) fail('migrate needs --project DIR --out DIR')
  const r = migrate(v.project, v.out)
  console.log(`migrate ${r.round_trip ? 'PASS' : 'FAIL'}: ${r.boards} boards, ${r.revisions} revisions, ${r.gates} gates, ` +
              `${r.conflicts.length} conflicts, round trip ${r.round_trip ? 'same' : 'DIFFERS'} (report ${r.out}/migrate-report.json)`)
  process.exit(r.round_trip ? 0 : 1)
} else {
  fail('usage: engineMain serve|web|migrate ...')
}
