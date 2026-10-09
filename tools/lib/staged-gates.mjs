import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync} from 'node:fs';
import {join, resolve, relative, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {gateInputs} from './gate-inputs.mjs';

export function affectedGates(root, changed, oldConfigs = new Map()) {
  const dir=join(root,'hardware-design/boards');
  const names=new Set([...oldConfigs.keys(),...readdirSync(dir).filter(b=>existsSync(join(dir,b,'gate.json')))]);
  return [...names].filter(board=>{
    const config=join(dir,board,'gate.json');
    const old=oldConfigs.get(board);
    const cfg=existsSync(config)?JSON.parse(readFileSync(config,'utf8')):old;
    const projects=[cfg,old].filter(Boolean).map(c=>relative(root,dirname(resolve(dir,board,c.project)))+'/');
    let deps=[];
    if(existsSync(config)) deps=gateInputs(root,board).files.map(p=>relative(root,p));
    return changed.some(p=>p.startsWith('tools/') || p==='hardware-design/registry/courtyard-bodies.json' ||
      p===`hardware-design/boards/${board}/gate.json` ||
      (p.startsWith(`hardware-design/boards/${board}/`) && p.endsWith('.json')) ||
      projects.some(prefix=>p.startsWith(prefix)) || deps.includes(p) ||
      // Deleted/replaced library assets may no longer be discoverable in the new snapshot.
      p.startsWith('hardware-design/blocks/') || p.startsWith('hardware-design/registry/cad-assets/'));
  }).sort();
}

export function checkStaged(root) {
  const git=(args,opts={})=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:256*1024*1024,...opts});
  const changed=git(['diff','--cached','--name-only','-z','--diff-filter=ACDMRT']).split('\0').filter(Boolean);
  if(!changed.length) return;
  const indexTree=git(['write-tree']).trim();
  const snapshot=mkdtempSync(join(tmpdir(),'iot-lab-index-'));
  try {
    git(['checkout-index','--all',`--prefix=${snapshot}/`]);
    if(git(['write-tree']).trim()!==indexTree) throw new Error('index changed while taking gate snapshot; retry the commit');
    const oldConfigs=new Map();
    const paths=git(['ls-tree','-r','--name-only','HEAD','hardware-design/boards']).split('\n').filter(p=>/\/gate.json$/.test(p));
    for(const p of paths) oldConfigs.set(p.split('/')[2],JSON.parse(git(['show',`HEAD:${p}`])));
    const boards=affectedGates(snapshot,changed,oldConfigs);
    console.log(`staged gates: ${boards.join(', ') || 'none'}`);
    const results=[];
    // Git exports repository variables inside hooks. They must not leak into
    // tools checking independent pinned repositories or the staged snapshot.
    const gateEnv={...process.env,IOT_LAB:snapshot};
    for(const name of git(['rev-parse','--local-env-vars']).trim().split('\n')) delete gateEnv[name];
    for(const board of boards) {
      const path=`hardware-design/boards/${board}/gate-metrics.json`;
      const baseline=join(snapshot,`.baseline-${board}.json`);
      let before='{"metrics":{}}';
      try {before=git(['show',`HEAD:${path}`]);} catch { /* new gate */ }
      writeFileSync(baseline,before);
      execFileSync(process.execPath,[join(snapshot,'tools/gate.mjs'),board,'--ratchet','--write','--baseline',baseline],{cwd:snapshot,stdio:'inherit',env:gateEnv});
      results.push({path,text:readFileSync(join(snapshot,path),'utf8')});
    }
    // Stage only metrics derived from the index. Do not git-add working files.
    // Keep any unstaged user edits to metrics intact.
    if(git(['write-tree']).trim()!==indexTree) throw new Error('index changed during gate checks; no generated metrics were staged');
    for(const {path,text} of results) {
      let staged=null;try{staged=git(['show',`:${path}`]);}catch{}
      const file=join(root,path);
      const work=existsSync(file)?readFileSync(file,'utf8'):null;
      const oid=git(['hash-object','-w','--stdin'],{input:text}).trim();
      git(['update-index','--add','--cacheinfo',`100644,${oid},${path}`]);
      if(work===staged) writeFileSync(file,text);
    }
  } catch (error) {
    // Keep failure logs after deleting the large temporary CAD checkout.
    const parent=join(root,'.gate');mkdirSync(parent,{recursive:true});
    const evidence=mkdtempSync(join(parent,'staged-failure-'));
    const boardsDir=join(snapshot,'hardware-design/boards');
    for(const board of existsSync(boardsDir)?readdirSync(boardsDir):[]) {
      const logs=join(boardsDir,board,'.gate');
      if(existsSync(logs)) cpSync(logs,join(evidence,board),{recursive:true});
    }
    writeFileSync(join(evidence,'snapshot.json'),JSON.stringify({indexTree,changed,error:error.message},null,2)+'\n');
    console.error(`staged failure evidence: ${evidence}`);
    throw error;
  } finally {rmSync(snapshot,{recursive:true,force:true});}
}
