import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,existsSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const boards={CELLULAR:'cell','AC-24V':'ac24','ENV-SENSE':'env','FIELD-24V-BUS':'field-24v-bus','BASE-PWR-B':'base-pwr-b'};
function fixture(board,variables={}) {
 const root=mkdtempSync(join(tmpdir(),'fab-workflow-'));mkdirSync(join(root,'tools'));mkdirSync(join(root,'bin'));
 const parent=board==='BASE-PWR-B'?'hardware-design/boards/BASE-PWR/cad/BASE-PWR-B':'hardware-design/boards/'+board+'/cad';
 mkdirSync(join(root,parent),{recursive:true});
 copyFileSync(new URL('../fab-workflow.sh',import.meta.url),join(root,'tools/fab-workflow.sh'));
 writeFileSync(join(root,'bin/node'),`#!/bin/sh
case "$1" in
 -e) echo fixture.kicad_pcb;;
 tools/gate.mjs) exit "\${GATE_STATUS:-0}";;
 tools/check-release-gate.mjs)
  [ -z "$3" ] || exit "\${LATE_EVIDENCE_STATUS:-0}"
  echo fixture-token; exit "\${EVIDENCE_STATUS:-0}";;
 *) exit 99;;
esac
`,{mode:0o755});
 writeFileSync(join(root,'bin/python'),`#!/bin/sh
case "$1" in *gerber_netcheck.py) exit "\${NET_STATUS:-0}";; *) exit "\${CHECK_STATUS:-0}";; esac
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
 for(const [name,variables] of [['export',{EXPORT_STATUS:'19'}],['netcheck',{NET_STATUS:'23'}],['evidence',{EVIDENCE_STATUS:'31'}],['changed inputs after export',{LATE_EVIDENCE_STATUS:'37'}]]) test(board+': '+name+' failure cannot publish',()=>{
  const f=fixture(board,variables);try{const r=f.run();assert.notEqual(r.status,0);assert.equal(existsSync(f.destination),false);assert.equal(readdirSync(f.parent).some(n=>n.startsWith('.release-')),false);}finally{rmSync(f.root,{recursive:true,force:true});}
 });
 test(board+': verified staging publishes without overwriting an existing candidate',()=>{
  const f=fixture(board);try{assert.equal(f.run().status,0);assert.equal(existsSync(join(f.destination,'fab/EXPLORATORY')),false);assert.match(readFileSync(join(f.destination,'fab/VERIFIED'),'utf8'),/no ordering authorization/);const before=readFileSync(join(f.destination,'fab/VERIFIED'),'utf8');assert.notEqual(f.run().status,0);assert.equal(readFileSync(join(f.destination,'fab/VERIFIED'),'utf8'),before);}finally{rmSync(f.root,{recursive:true,force:true});}
 });
}
test('board-specific check failure prevents release export',()=>{
 const f=fixture('AC-24V',{CHECK_STATUS:'13'});try{assert.equal(f.run().status,13);assert.equal(existsSync(join(f.root,'trace')),false);}finally{rmSync(f.root,{recursive:true,force:true});}
});
