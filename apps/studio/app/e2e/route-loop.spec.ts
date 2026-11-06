// Actual Electron UI with deterministic controller/candidate/live data. No canonical CAD or model-quality claim.
import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const APP = join(__dirname, '..'),
  REL = 'hardware-design/boards/DEMO/cad/DEMO/DEMO.kicad_pcb',
  ID = 'loop-0123456789abcdef'
const board = `(kicad_pcb (version 20260206) (generator "test") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 0 "") (net 1 "/A")
${[
  [0, 0, 40, 0],
  [40, 0, 40, 30],
  [40, 30, 0, 30],
  [0, 30, 0, 0]
]
  .map(
    ([a, b, c, d]) =>
      `(gr_line (start ${a} ${b}) (end ${c} ${d}) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)))`
  )
  .join('\n')}
(footprint "Test:Pad" (layer "F.Cu") (at 20 15) (property "Reference" "U1") (pad "1" smd rect (at 0 0) (size 3 3) (layers "F.Cu") (net 1 "/A"))))`
const sha = createHash('sha256').update(board).digest('hex')
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'studio-loop-ui-'))
  mkdirSync(join(root, 'hardware-design/boards/DEMO/cad/DEMO'), { recursive: true })
  mkdirSync(join(root, 'hardware-design/registry'), { recursive: true })
  mkdirSync(join(root, 'tools'))
  writeFileSync(join(root, REL), board)
  writeFileSync(
    join(root, 'hardware-design/boards/DEMO/gate.json'),
    JSON.stringify({ project: 'cad/DEMO/DEMO' })
  )
  writeFileSync(
    join(root, 'hardware-design/registry/boards.json'),
    JSON.stringify({
      boards: [
        {
          id: 'DEMO',
          directory: 'DEMO',
          lifecycle: 'test',
          revisions: [{ revision: 'A', state: 'test', project: 'cad/DEMO/DEMO', gate: 'DEMO' }]
        }
      ]
    })
  )
  const cli = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');const a=process.argv.slice(2);if(a[0]==='--project')a.splice(0,2);const op=a.shift(),action=a.shift();
const root=process.cwd(),file=path.join(root,'loop.json'),id='${ID}',rel='${REL}';const load=()=>JSON.parse(fs.readFileSync(file));const save=s=>fs.writeFileSync(file,JSON.stringify(s));
if(op!=='loop'){console.log('[]');process.exit(0);}
if(action==='list'){console.log(JSON.stringify(fs.existsSync(file)?[load()]:[]));process.exit(0);}
if(action==='start'){if(!a.includes('--experimental'))process.exit(2);const policy=JSON.parse(fs.readFileSync(a[a.indexOf('--policy')+1]));fs.writeFileSync('admitted-policy.json',JSON.stringify(policy));const s={id,root,board:'DEMO',revision:4,status:'decision_required',cause:'A search limit left one named connection open.',deadline_ms:Date.now()+900000,policy,rounds:[{round:1,child:{id:'run-first',folder:root+'/.gate/cli/run-first'},evidence:{state:'failed',verified:false,cause:'search limit'}}],best_search:1,best_verified:null};save(s);}
if(action==='decide'){const s=load(),decision=JSON.parse(a[a.indexOf('--decision-json')+1]);if(!decision.reason.trim())process.exit(2);const candidate=path.join(root,'.gate/cli/run-second/workspace',rel);fs.mkdirSync(path.dirname(candidate),{recursive:true});const copper='(segment (start 5 5) (end 35 6) (width 0.25) (layer "F.Cu") (net 1)) (segment (start 5 10) (end 17.5 10) (width 0.25) (layer "F.Cu") (net 1)) (via (at 35 6) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1)) (via (at 17.5 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))';fs.writeFileSync(candidate,fs.readFileSync(path.join(root,rel),'utf8').replace(/\\)\\s*$/,copper+')'));s.rounds.push({round:2,child:{id:'run-second',folder:root+'/.gate/cli/run-second'},decision,evidence:{state:'passed',verified:true,candidate,wire_mm:42.51666203960727,vias:2}});s.best_verified=2;s.status='passed';s.cause='A candidate passed the complete fresh gate. Review it before adoption.';s.revision=8;save(s);}
if(action==='cancel'){const s=load();s.status='cancelled';save(s);}
console.log(JSON.stringify(load()));
`
  writeFileSync(join(root, 'tools/pcb-loop.ts'), '// deterministic fixture capability marker\n')
  writeFileSync(join(root, 'tools/pcb'), cli)
  chmodSync(join(root, 'tools/pcb'), 0o755)
  return root
}
test('experimental loop controls, decision history, per-round live board and retained candidate render', async () => {
  const root = fixture(),
    token = join(root, 'live-token')
  writeFileSync(token, 'fixture-only')
  const before = readFileSync(join(root, REL), 'utf8')
  const events = (round: number) =>
    [
      {
        kind: 'run.started',
        data: {
          project: root,
          board: REL,
          host: 'fixture',
          operation: 'routing',
          label: `route-DEMO-${ID}-r${round}`
        }
      },
      {
        kind: 'board.snapshot',
        data: { blobSha256: sha, path: REL, phase: 'routing', includesBaseCopper: false }
      },
      {
        kind: 'route.delta',
        data: {
          addTracks: [
            {
              id: 'trace',
              net: '/A',
              layer: 'F.Cu',
              a: [5, 5],
              b: [35, 5 + round],
              width: 0.25,
              locked: false
            }
          ],
          removeTracks: [],
          addVias: [],
          removeVias: []
        }
      },
      {
        kind: 'progress',
        data: {
          stage: 'routing',
          elapsedMs: 100,
          message: `Round ${round} checkpoint`,
          metrics: { pass: round }
        }
      }
    ].map((e, i) => ({
      schema: 'pcb-live.v1',
      runId: `live-${round}`,
      attemptId: `round-${round}-attempt`,
      seq: i + 1,
      timeMs: 1000 + i,
      baseSha256: sha,
      ...e
    }))
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture')
    const round = Number(url.pathname.match(/live-([12])/)?.[1] ?? 1),
      rows = events(round),
      after = Number(url.searchParams.get('after') ?? 0)
    if (url.pathname.startsWith('/live/assets/')) {
      res.end(board)
      return
    }
    if (url.pathname === '/live/runs') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          runs: [2, 1].map((r) => ({
            runId: `live-${r}`,
            seq: 4,
            summary: { run: { label: `route-DEMO-${ID}-r${r}` }, finished: null }
          }))
        })
      )
      return
    }
    if (url.pathname.endsWith('/stream')) {
      res.setHeader('content-type', 'text/event-stream')
      res.write(
        rows
          .filter((e) => e.seq > after)
          .map((e) => 'data: ' + JSON.stringify(e) + '\n\n')
          .join('')
      )
      return
    }
    if (url.pathname.endsWith('/events')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ events: rows.filter((e) => e.seq > after), headSeq: 4 }))
      return
    }
    res.statusCode = 404
    res.end('fixture endpoint')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const app = await electron.launch({
    args: [APP, '--user-data-dir=' + join(root, 'profile')],
    env: {
      ...process.env,
      PCBSTUDIO_PROJECT: root,
      JOBD_URL: `http://127.0.0.1:${port}`,
      JOBD_TOKEN_FILE: token
    }
  })
  app.process().stderr?.on('data', (d) => process.stderr.write('[loop-app] ' + String(d)))
  app.process().stdout?.on('data', (d) => process.stdout.write('[loop-app] ' + String(d)))
  try {
    const win = await app.firstWindow()
    win.on('pageerror', (e) => console.error('[loop-renderer]', e))
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      w.setSize(1500, 1100)
      w.webContents.setBackgroundThrottling(false)
      w.hide()
    })
    await expect(win.getByRole('status', { name: 'Engine status' })).toContainText('engine ready', {
      timeout: 30000
    })
    await win.getByRole('button', { name: 'Choose board' }).click()
    await win.getByRole('option', { name: /DEMO/ }).click()
    await win
      .getByRole('navigation', { name: 'Board' })
      .getByRole('button', { name: /^Runs/ })
      .click()
    const panel = win.getByRole('region', { name: 'Experimental routing loop' })
    await expect(panel.getByRole('button', { name: 'Start loop' })).toBeDisabled()
    await panel.getByLabel('Enable experimental loop').check()
    await panel.getByRole('button', { name: 'Start loop' }).click()
    await expect(panel.getByRole('status', { name: 'Routing loop state' })).toContainText(
      'Decision needed'
    )
    await expect(
      panel
        .getByRole('region', { name: 'Live loop round 1' })
        .getByRole('img', { name: /Live solver board/ })
    ).toBeVisible({ timeout: 15000 })
    await panel
      .getByLabel('Loop decision reason')
      .fill(
        'The work limit was reached. Retain the first candidate and try one bounded continuation.'
      )
    await panel.getByRole('button', { name: 'Record decision' }).click()
    await expect(panel.getByRole('status', { name: 'Routing loop state' })).toContainText(
      'Verified candidate retained'
    )
    await expect(panel.getByRole('table', { name: 'Loop round history' })).toContainText(
      'Retain the first candidate'
    )
    await panel.getByRole('button', { name: 'Watch round 2' }).click()
    const live = panel.getByRole('region', { name: 'Live loop round 2' })
    await expect(live.locator('.live-metrics')).toContainText('round-2-', { timeout: 15000 })
    await expect(live.getByRole('img', { name: /Live solver board/ })).toBeVisible({
      timeout: 15000
    })
    await expect(panel).toContainText('Verified candidate: round 2')
    await win.screenshot({ path: join(APP, 'test-results', 'experimental-loop-live.png') })
    await panel.getByRole('button', { name: 'View candidate 2' }).click()
    await expect(
      panel.getByRole('region', { name: 'Loop candidate preview' }).locator('canvas')
    ).toBeVisible()
    await win.screenshot({ path: join(APP, 'test-results', 'experimental-loop-candidate.png') })
    expect(readFileSync(join(root, REL), 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(join(root, 'admitted-policy.json'), 'utf8')).experimental).toBe(
      true
    )
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    rmSync(root, { recursive: true, force: true })
  }
})
