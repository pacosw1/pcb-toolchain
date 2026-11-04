#!/usr/bin/env node
// The release recipe of a board for tools/fab-workflow.sh. The recipe is the "release" key of the board gate.json.
//
//   node tools/release-recipe.mjs BOARD shell              print maker/fab/check/config/check_json as shell assignments
//   node tools/release-recipe.mjs BOARD run pre|post STAGE run the pre_checks (before the layout check) or the
//                                                          post_export hooks (after the Gerber netcheck) of a release
// Hook: {"name": TEXT, "run": [argv...], "log": FILE}. "{stage}" in argv is the release work directory; the
// command runs in the project root (the current directory) and its stdout goes to STAGE/FILE. Exit 2: no release entry for the board.
import {spawnSync} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {requireRelease} from './lib/board-release.mjs';

const [board,mode,phase,stage]=process.argv.slice(2);
const root=process.cwd(); // fab-workflow.sh runs in the project root
let recipe;
try {recipe=requireRelease(root,board);}
catch(error) {console.error('FAIL: '+error.message);process.exit(2);}
const SAFE=/^[A-Za-z0-9_./-]*$/;
if(mode==='shell') {
  for(const key of ['maker','fab','check','config','check_json']) {
    const value=recipe[key]??'';
    if(typeof value!=='string' || !SAFE.test(value)) {console.error(`FAIL: release.${key} of ${board} must be a plain path`);process.exit(2);}
    console.log(`${key}='${value}'`);
  }
} else if(mode==='run' && ['pre','post'].includes(phase) && stage) {
  for(const hook of recipe[phase==='pre'?'pre_checks':'post_export']??[]) {
    console.log(`START: ${hook.name}`);
    const out=openSync(join(stage,hook.log),'w');
    const [cmd,...args]=hook.run.map(a=>a.replaceAll('{stage}',stage));
    const r=spawnSync(cmd,args,{cwd:root,stdio:['ignore',out,'inherit']});
    closeSync(out);
    if(r.status!==0) {console.error(`FAIL: ${hook.name} (exit ${r.status ?? r.signal ?? r.error?.message}); log=${join(stage,hook.log)}`);process.exit(r.status||1);}
    console.log(`PASS: ${hook.name}`);
  }
} else {
  console.error('usage: release-recipe.mjs BOARD shell | BOARD run pre|post STAGE');process.exit(2);
}
