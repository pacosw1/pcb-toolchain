// Real supervisor/admission/receipt/move integration. Router and gate are deterministic fixture tools, not native DRC proof.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { exemptBoard } from './design-exempt-fixture.ts';
import { sealFixtureBoard } from './cad-seal-fixture.ts';
import { iotrouteMissing } from './iotroute-bin.ts';
import { defaultLoopBackend } from './route-loop-backend.ts';
import { startLoop, statusLoop, decideLoop } from './route-loop.ts';
import type { LoopState } from './route-loop.ts';
import { requestCancel, status } from './pcb-runs.ts';
import { verify, verifySettled } from './pcb-evidence.ts';
const BOARD =
  '(kicad_pcb (version 20260101) (generator test) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 0 "") (gr_line (start 0 0) (end 40 0) (layer "Edge.Cuts")) (gr_line (start 40 0) (end 40 30) (layer "Edge.Cuts")) (gr_line (start 40 30) (end 0 30) (layer "Edge.Cuts")) (gr_line (start 0 30) (end 0 0) (layer "Edge.Cuts")))';
const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

test(
  'production controller runs a failed candidate, validates a reasoned move, then retains a sealed passing candidate',
  { skip: iotrouteMissing() },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'loop-backend-'))),
      native = join(root, 'hardware-design/boards/X/cad/X.kicad_pcb');
    t.after(async () => {
      const base = join(root, '.gate/cli');
      if (existsSync(base)) {
        for (const id of readdirSync(base)) {
          const folder = join(base, id);
          if (existsSync(join(folder, 'run.json'))) {
            requestCancel(folder);
            for (let n = 0; n < 100 && status(folder).get('controller_alive') === true; n++) await delay(50);
            assert.notEqual(
              status(folder).get('controller_alive'),
              true,
              'owned fixture child must settle before cleanup'
            );
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    });
    put(native, BOARD);
    for (const ext of ['kicad_sch', 'kicad_pro', 'kicad_dru'])
      put(native.replace(/kicad_pcb$/, ext), ext === 'kicad_pro' ? '{}' : '(version 1)');
    put(
      join(root, 'hardware-design/boards/X/gate.json'),
      JSON.stringify({ project: 'cad/X', stage: 'G3', checks: { erc: true, drc: true } })
    );
    exemptBoard(root, 'X');
    sealFixtureBoard(root, 'X');
    const tools = fileURLToPath(new URL('..', import.meta.url));
    mkdirSync(join(root, 'tools/lib'), { recursive: true });
    copyFileSync(join(tools, 'lib/gate-core.mjs'), join(root, 'tools/lib/gate-core.mjs'));
    put(join(root, 'tools/pcb_snapshot_inputs.mjs'), 'console.log("[]");');
    put(
      join(root, 'tools/router/route-dispatch.mjs'),
      `
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';const a=process.argv.slice(2),k=n=>a[a.indexOf(n)+1],p=a.slice(a.indexOf('--')+1),out=p[3],input=k('--pcb'),n=Number(k('--iters'));
const text=fs.readFileSync(input,'utf8').replace(/\\)\\s*$/, '(segment (start '+n+' '+n+') (end '+(n+1)+' '+(n+1)+') (width 0.2) (layer "F.Cu") (net 0)))');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,text);const work=out+'.iotroute';fs.mkdirSync(work,{recursive:true});
const sha=s=>createHash('sha256').update(s).digest('hex');fs.writeFileSync(work+'/result.json',JSON.stringify({schema:'iot-lab.iotroute-run.v1',status:n<2?'FAIL':'PASS',input,input_sha256:sha(fs.readFileSync(input)),board_file:out,board_sha256:sha(text),drc_errors:0,unconnected:n<2?2:0,parity:0,stages:{binary:{path:process.env.IOTROUTE_BIN,how:'explicit'},lock:{source:input}}}));
fs.writeFileSync(work+'/route.json',JSON.stringify({schema:'iot-lab.route-result.v0',tracks:[],vias:[],failed:n<2?[{net:'A'}]:[],passes:n}));
fs.writeFileSync(work+'/stuck.json',JSON.stringify({schema:'iot-lab.stuck-report.v1',board:'X',work:'/nonexistent-fixture-work',drc_errors:0,unconnected:n<2?2:0,parity:0,enclosed:0,router_miss:2,unknown:0,search:{stop:'iters',pass:n,max_passes:n,passes_since_best:0},route_layers:['F.Cu','B.Cu'],reused:false,changed:null,open_nets:n<2?['A']:[],region:[1,1,3,3],rows:[{net:'A',class:'ROUTER_MISS',connections:2,why:'search limit'}],blockers:{parts:[],nets:[],keepouts:[],layers:[],boxed_in:[]},summary:['fixture search limit']}));process.exitCode=n<2?1:0;
`
    );
    put(
      join(root, 'tools/gate.mjs'),
      `
import fs from 'node:fs';const a=process.argv.slice(2),out=a[a.indexOf('--evidence-dir')+1];if(!a.includes('--fresh'))process.exit(9);fs.mkdirSync(out,{recursive:true});const pass=fs.readFileSync('hardware-design/boards/X/cad/X.kicad_pcb','utf8').includes('(start 2 2)'),exit=pass?0:1;
fs.writeFileSync(out+'/findings.json',JSON.stringify({complete:true,inputs_valid:true,findings:[]}));fs.writeFileSync(out+'/result.json',JSON.stringify({exit,changedDuringRun:false,metrics:{drc_errors:0,unconnected:pass?0:2},provenance:{input_sha256:'a'.repeat(64),inputs:[],tools:{kicad:'fixture'}},checks:{}}));process.exitCode=exit;
`
    );
    const backend = defaultLoopBackend();
    let s = await startLoop(
      root,
      'X',
      {
        experimental: true,
        max_rounds: 2,
        deadline_s: 90,
        done_when: 'verified',
        route: { schema: 'iot-lab.iotroute-policy.v1', iters: 1, max_time_s: 10, keep: 'all', layers: [], nets: [] }
      },
      backend
    );
    const boundary = async (state: LoopState) => {
      for (let n = 0; n < 300; n++) {
        state = await statusLoop(root, state.id, backend);
        if (state.status !== 'running' && state.status !== 'launching') return state;
        await delay(50);
      }
      throw Error('fixture round did not settle');
    };
    s = await boundary(s);
    assert.equal(s.status, 'decision_required', s.cause);
    const cli = spawnSync(join(tools, 'pcb'), ['--project', root, 'loop', 'status', s.id, '--json'], {
      encoding: 'utf8'
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(JSON.parse(cli.stdout).status, 'decision_required');
    assert.equal(s.rounds[0]!.evidence!.verified, false);
    assert.equal(verify(s.rounds[0]!.child!.folder).get('candidate_verified'), false);
    assert.equal(verify(s.rounds[0]!.child!.folder).get('identity_preserved'), true);
    assert.ok(s.rounds[0]!.evidence!.report_sha256);
    assert.notEqual(
      s.rounds[0]!.evidence!.search_candidate,
      s.rounds[0]!.evidence!.candidate,
      'failed partial output remains separate from the ordinary candidate'
    );
    s = await decideLoop(
      root,
      s.id,
      s.revision,
      {
        reason:
          'The source-bound report identifies a work limit. Preserve the candidate and increase the pass limit once.',
        move: { kind: 'change_setting', setting: 'passes', value: 2 }
      },
      backend
    );
    s = await boundary(s);
    assert.equal(s.status, 'passed', s.cause);
    assert.equal(s.best_verified, 2);
    assert.equal(s.rounds.length, 2);
    assert.equal(readFileSync(native, 'utf8'), BOARD);
    assert.equal(verify(s.rounds[1]!.child!.folder).get('candidate_verified'), true);
    assert.equal(verifySettled(s.rounds[0]!.child!.folder).get('cleanup') instanceof Map, true);
  }
);
