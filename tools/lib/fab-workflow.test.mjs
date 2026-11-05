import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,existsSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const boards={'BASE-PWR':'base-pwr',CELLULAR:'cell','AC-24V':'ac24','ENV-SENSE':'env','FIELD-24V-BUS':'field-24v-bus','BASE-PWR-B':'base-pwr-b','BASE-PWR-C':'base-pwr-c','AC-24V-C':'ac24-c','H7-CORE':'h7-core'};
function fixture(board,variables={}) {
 const root=mkdtempSync(join(tmpdir(),'fab-workflow-'));mkdirSync(join(root,'tools'));mkdirSync(join(root,'bin'));
 const parent=board.startsWith('BASE-PWR-')?'hardware-design/boards/BASE-PWR/cad/'+board:board==='AC-24V-C'?'hardware-design/boards/AC-24V/cad/AC-24V-C':'hardware-design/boards/'+board+'/cad';
 mkdirSync(join(root,parent),{recursive:true});
 copyFileSync(new URL('../fab-workflow.sh',import.meta.url),join(root,'tools/fab-workflow.sh'));
 // The board recipe comes from the board gate config (the real one of the repository).
 copyFileSync(new URL('../release-recipe.mjs',import.meta.url),join(root,'tools/release-recipe.mjs'));
 mkdirSync(join(root,'tools/lib'));copyFileSync(new URL('./board-release.mjs',import.meta.url),join(root,'tools/lib/board-release.mjs'));
 const config=['gate.json','gate.pending.json'].map(n=>`hardware-design/boards/${board}/${n}`).find(n=>existsSync(new URL('../../'+n,import.meta.url)));
 mkdirSync(join(root,'hardware-design/boards',board),{recursive:true});copyFileSync(new URL('../../'+config,import.meta.url),join(root,config));
 copyFileSync(new URL('../publish-release.mjs',import.meta.url),join(root,'tools/publish-release.mjs'));copyFileSync(new URL('./py-compat.mjs',import.meta.url),join(root,'tools/lib/py-compat.mjs'));
 mkdirSync(join(root,'tools/lib'),{recursive:true});
 for(const file of ['pcb_timing.ts','lib/cli.ts','lib/timing.ts','lib/py-numbers.ts','lib/py-compat.mjs']) copyFileSync(new URL('../'+file,import.meta.url),join(root,'tools',file));
 writeFileSync(join(root,'tools/check-env-schematic.py'),'import os,sys; sys.exit(int(os.environ.get("SCHEMATIC_STATUS", "0")))\n');
 writeFileSync(join(root,'bin/node'),`#!/bin/sh
case "$1" in
 --input-type=module) echo '{}';;
 --experimental-strip-types) exec ${JSON.stringify(process.execPath)} "$@";;
 -e) echo fixture.kicad_pcb;;
 tools/gate.mjs) [ "$3" != --evidence-dir ] || mkdir "$4"; exit "\${GATE_STATUS:-0}";;
 tools/check-fab-zip.mjs) echo '{"status":"passed"}';;
 tools/check-release-gate.mjs)
  if [ "$3" != --gate-dir ]; then echo '{}' > "$4"; exit "\${LATE_EVIDENCE_STATUS:-0}"; fi
  echo fixture-token; exit "\${EVIDENCE_STATUS:-0}";;
 tools/check-base-pwr-pcb.mjs) exit "\${CHECK_STATUS:-0}";;
 tools/release-recipe.mjs|tools/publish-release.mjs) exec ${JSON.stringify(process.execPath)} "$@";;
 tools/check-release-fab.mjs) echo '{}' > "$3/release-manifest.json"; exit "\${FAB_STATUS:-0}";;
 *) exit 99;;
esac
`,{mode:0o755});
 writeFileSync(join(root,'bin/python'),`#!/bin/sh
case "$1" in -c) echo '{"python":"fixture","packages":{"gerbonara":"fixture","shapely":"fixture","numpy":"fixture","click":"fixture"}}'; exit "\${RUNTIME_STATUS:-0}";; *gerber_netcheck.py) exit "\${NET_STATUS:-0}";; *) exit "\${CHECK_STATUS:-0}";; esac
`,{mode:0o755});
 writeFileSync(join(root,'tools/make-'+boards[board]+'-fab.sh'),`#!/bin/sh
echo export >> "$TEST_TRACE"
mkdir -p "$FAB_OUT"
echo exploratory > "$FAB_OUT/EXPLORATORY"
touch "$FAB_OUT/$1"
exit "\${EXPORT_STATUS:-0}"
`);
 const destination=join(root,parent,'candidate');
 const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,KICAD_PY:join(root,'bin/python'),GERBERCHECK_PY:join(root,'bin/python'),TEST_TRACE:join(root,'trace'),FAB_OUT:join(root,parent,'fab'),FAB_RELEASE_OUT:destination,...variables};
 return {root,destination,parent:join(root,parent),run:(mode='release')=>spawnSync('sh',[join(root,'tools/fab-workflow.sh'),board,mode],{env,encoding:'utf8'})};
}
for(const board of Object.keys(boards)) {
 test(board+': gate failure prevents export',()=>{
  const f=fixture(board,{GATE_STATUS:'17'});try{assert.equal(f.run().status,17);assert.equal(existsSync(join(f.root,'trace')),false);assert.equal(existsSync(f.destination),false);}finally{rmSync(f.root,{recursive:true,force:true});}
 });
 test(board+': exploratory failures retain stamped output and return failure',()=>{
  const f=fixture(board,{GATE_STATUS:'17',NET_STATUS:'23'});try{assert.equal(f.run('explore').status,23);assert.equal(existsSync(join(f.parent,'fab/EXPLORATORY')),true);assert.equal(existsSync(f.destination),false);}finally{rmSync(f.root,{recursive:true,force:true});}
 });
 for(const [name,variables] of [['Gerber runtime',{RUNTIME_STATUS:'9'}],['export',{EXPORT_STATUS:'19'}],['netcheck',{NET_STATUS:'23'}],['evidence',{EVIDENCE_STATUS:'31'}],['changed inputs after export',{LATE_EVIDENCE_STATUS:'37'}],['native BOM/CPL',{FAB_STATUS:'41'}]]) test(board+': '+name+' failure cannot publish',()=>{
  const f=fixture(board,variables);try{const r=f.run();assert.notEqual(r.status,0);assert.equal(existsSync(f.destination),false);assert.match(r.stderr,/FAIL: release stopped; evidence=/);assert.equal(readdirSync(f.parent).some(n=>n.startsWith('.release-')),true);}finally{rmSync(f.root,{recursive:true,force:true});}
 });
 test(board+': verified staging publishes without overwriting an existing candidate',()=>{
  const f=fixture(board);try{assert.equal(f.run().status,0);assert.equal(existsSync(join(f.destination,'fab/EXPLORATORY')),false);assert.match(readFileSync(join(f.destination,'fab/VERIFIED'),'utf8'),/no ordering authorization/);const before=readFileSync(join(f.destination,'fab/VERIFIED'),'utf8');assert.notEqual(f.run().status,0);assert.equal(readFileSync(join(f.destination,'fab/VERIFIED'),'utf8'),before);}finally{rmSync(f.root,{recursive:true,force:true});}
 });
}
test('board-specific check failure prevents release export',()=>{
 const f=fixture('AC-24V',{CHECK_STATUS:'13'});try{assert.equal(f.run().status,13);assert.equal(existsSync(join(f.root,'trace')),false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('ENV schematic semantic failure blocks the shared gate and export',()=>{
 const f=fixture('ENV-SENSE',{SCHEMATIC_STATUS:'11'});try{assert.equal(f.run().status,11);assert.equal(existsSync(join(f.root,'trace')),false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('BASE staged audit failure blocks publication',()=>{
 const f=fixture('BASE-PWR',{CHECK_STATUS:'13'});try{assert.equal(f.run().status,13);assert.equal(existsSync(f.destination),false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('export spans retain exact failure code and never record downstream stages',()=>{
 const f=fixture('BASE-PWR',{EXPORT_STATUS:'19'});try{
  assert.equal(f.run().status,19);
  const stage=readdirSync(f.parent).find(n=>n.startsWith('.release-'));
  const rows=readFileSync(join(f.parent,stage,'stages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r=>r.type),['stage.start','stage.end']);assert.equal(rows[1].code,19);
  assert.equal(rows[1].status,'failed');assert.equal(rows[1].span_id,rows[0].span_id);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('published release carries actual export and reconstruction timing journal',()=>{
 const f=fixture('BASE-PWR');try{
  assert.equal(f.run().status,0);
  const rows=readFileSync(join(f.destination,'stages.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(r=>r.type==='stage.end').map(r=>r.stage),['export','fab-zip','gerber-netcheck']);
  assert.ok(rows.filter(r=>r.type==='stage.end').every(r=>r.duration_s>=0 && r.code===0));
  assert.equal(readdirSync(f.parent).filter(n=>n.startsWith('.release-')).length,0);
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
