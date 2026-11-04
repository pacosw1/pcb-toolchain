import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync} from 'node:fs';
import {join, resolve, relative, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {gateInputs} from './gate-inputs.mjs';
import {poolSize, runPool, ProcessGroups} from './gate-pool.mjs';

// A changed path gates a board when it is one of that board's own files (gate.json, board JSONs, project cad/),
// an input of the board's gate in the staged snapshot, or an input recorded in the board's committed gate-metrics.json
// (headInputs: board -> Set of provenance.inputs paths; catches deleted inputs). A board without committed metrics
// falls back to the conservative rule: any tool or shared library asset (D-129).
// The provenance.inputs paths of committed gate metrics, or null when they are
// unreadable, missing, empty or malformed. Null keeps the conservative rule.
export function recordedInputs(text) {
  let inputs;try {inputs=JSON.parse(text)?.provenance?.inputs;} catch {return null;}
  if(!Array.isArray(inputs) || !inputs.length || !inputs.every(i=>typeof i?.path==='string' && i.path)) return null;
  return new Set(inputs.map(i=>i.path));
}
export function stagedGateMap(root, changed, oldConfigs = new Map(), headInputs = new Map()) {
  const dir=join(root,'hardware-design/boards');
  const names=new Set([...oldConfigs.keys(),...readdirSync(dir).filter(b=>existsSync(join(dir,b,'gate.json')))]);
  const reasons=new Map();
  const boards=[...names].filter(board=>{
    const config=join(dir,board,'gate.json');
    const old=oldConfigs.get(board);
    const cfg=existsSync(config)?JSON.parse(readFileSync(config,'utf8')):old;
    const projects=[cfg,old].filter(Boolean).map(c=>relative(root,dirname(resolve(dir,board,c.project)))+'/');
    let deps=[];
    if(existsSync(config)) deps=gateInputs(root,board).files.map(p=>relative(root,p));
    const recorded=headInputs.get(board);
    const conservative=p=>p.startsWith('tools/') || p==='hardware-design/registry/courtyard-bodies.json' ||
      // Deleted/replaced library assets may no longer be discoverable in the new snapshot.
      p.startsWith('hardware-design/blocks/') || p.startsWith('hardware-design/registry/cad-assets/');
    const hits=changed.filter(p=>p===`hardware-design/boards/${board}/gate.json` ||
      (p.startsWith(`hardware-design/boards/${board}/`) && p.endsWith('.json')) ||
      projects.some(prefix=>p.startsWith(prefix)) || deps.includes(p) ||
      (recorded?.size ? recorded.has(p) : conservative(p)));
    for(const p of hits) reasons.set(p,[...(reasons.get(p) ?? []),board]);
    return hits.length>0;
  }).sort();
  return {boards,reasons};
}
export function affectedGates(root, changed, oldConfigs = new Map(), headInputs = new Map()) {
  return stagedGateMap(root,changed,oldConfigs,headInputs).boards;
}

// Boards run in parallel (bounded pool, tools/lib/gate-pool.mjs; IOT_LAB_GATE_JOBS overrides the size).
// Each board writes only its own folder of the snapshot and its own cache folder, so the result is the same as serial.
// Failure policy: after the first failed board no new board starts; boards in progress finish (their logs are
// complete and their passed checks go into the cache for the next try). A signal stops all gate process groups.
export async function checkStaged(root) {
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
    const headInputs=new Map();
    for(const p of git(['ls-tree','-r','--name-only','HEAD','hardware-design/boards']).split('\n').filter(p=>/\/gate-metrics.json$/.test(p))) {
      let text=null;try {text=git(['show',`HEAD:${p}`]);} catch { /* unreadable metrics: conservative rule */ }
      const recorded=recordedInputs(text);if(recorded) headInputs.set(p.split('/')[2],recorded);
    }
    const {boards,reasons}=stagedGateMap(snapshot,changed,oldConfigs,headInputs);
    const because=[...reasons].map(([p,b])=>`${p} -> ${b.length} board${b.length===1?'':'s'}`);
    console.log(`staged gates: ${boards.join(', ') || 'none'}${because.length ? ` (because ${because.slice(0,8).join('; ')}${because.length>8 ? `; +${because.length-8} more` : ''})` : ''}`);
    const cacheRoot=process.env.IOT_LAB_GATE_CACHE ? resolve(process.env.IOT_LAB_GATE_CACHE) :
      resolve(root,git(['rev-parse','--git-common-dir']).trim(),'iot-lab-gate-cache');
    // Git exports repository variables inside hooks. They must not leak into
    // tools checking independent pinned repositories or the staged snapshot.
    const gateEnv={...process.env,IOT_LAB:snapshot};
    for(const name of git(['rev-parse','--local-env-vars']).trim().split('\n')) delete gateEnv[name];
    const {jobs,rule}=poolSize({boards:boards.length,override:process.env.IOT_LAB_GATE_JOBS});
    if(boards.length) console.log(`staged gates: ${boards.length} board${boards.length===1?'':'s'}, ${jobs} at a time (${rule})`);
    const groups=new ProcessGroups();
    let interrupted=null,escalate=null;
    const onSignal=signal=>{
      if(interrupted) {groups.kill('SIGKILL');return;}
      interrupted=signal;console.error(`staged gates: ${signal}: stopping ${groups.running.size} running gate(s)`);
      groups.kill('SIGTERM');escalate=setTimeout(()=>groups.kill('SIGKILL'),5000);
    };
    const onExit=()=>groups.kill('SIGKILL');
    const signals=['SIGINT','SIGTERM','SIGHUP'];
    for(const signal of signals) process.on(signal,onSignal);
    process.on('exit',onExit);
    const started=Date.now();
    let outcomes;
    try {
      outcomes=await runPool(boards,jobs,async board=>{
        const path=`hardware-design/boards/${board}/gate-metrics.json`;
        const baseline=join(snapshot,`.baseline-${board}.json`);
        let before='{"metrics":{}}';
        try {before=git(['show',`HEAD:${path}`]);} catch { /* new gate */ }
        writeFileSync(baseline,before);
        // Checks whose own hashed inputs did not change are reused (content-addressed receipts, verified on restore);
        // only the affected checks run. One cache in the git common dir serves every worktree.
        // A G5 release gate always runs fresh.
        const config=join(snapshot,`hardware-design/boards/${board}/gate.json`);
        const stage=existsSync(config) ? JSON.parse(readFileSync(config,'utf8')).stage : 'G5';
        const cache=stage==='G5' ? [] : ['--cache-dir',join(cacheRoot,board)];
        console.log(`${board}: start`);
        const run=await groups.run(process.execPath,[join(snapshot,'tools/gate.mjs'),board,'--ratchet','--write','--baseline',baseline,...cache],{cwd:snapshot,env:gateEnv});
        // One block per board, so parallel output stays readable.
        const body=run.output.replace(/\n$/,'').split('\n').map(line=>`[${board}] ${line}`).join('\n');
        const ok=run.code===0 && !run.orphans;
        const why=run.code===0 ? (run.orphans ? 'orphan processes killed' : '') : run.signal ? `signal ${run.signal}` : `exit ${run.code}`;
        console.log(`${body}\n${board}: ${ok ? 'PASS' : `FAIL (${why})`} ${run.seconds.toFixed(1)} s`);
        return ok ? {ok,path,text:readFileSync(join(snapshot,path),'utf8')} : {ok,why};
      },{shouldStop:()=>Boolean(interrupted)});
    } finally {
      clearTimeout(escalate);
      for(const signal of signals) process.off(signal,onSignal);
      process.off('exit',onExit);
    }
    const seconds=((Date.now()-started)/1000).toFixed(1);
    const failed=outcomes.filter(o=>o.status==='failed').map(o=>`${o.item} (${o.value?.why ?? o.error?.message})`);
    const skipped=outcomes.filter(o=>o.status==='skipped').map(o=>o.item);
    if(interrupted || failed.length) {
      const message=`${interrupted ? `interrupted by ${interrupted}` : `gate failed: ${failed.join(', ')}`}${skipped.length ? `; not run: ${skipped.join(', ')}` : ''}`;
      console.error(`staged gates: FAIL ${message} (${seconds} s)`);
      throw new Error(message);
    }
    if(boards.length) console.log(`staged gates: PASS ${boards.length} board${boards.length===1?'':'s'} in ${seconds} s`);
    const results=outcomes.map(o=>o.value);
    // Stage only metrics derived from the index. Do not git-add working files.
    // Keep any unstaged user edits to metrics intact.
    if(git(['write-tree']).trim()!==indexTree) throw new Error('index changed during gate checks; no generated metrics were staged');
    const updates=[];
    for(const {path,text} of results) {
      let staged=null;try{staged=git(['show',`:${path}`]);}catch{}
      const file=join(root,path);
      const work=existsSync(file)?readFileSync(file,'utf8'):null;
      const oid=git(['hash-object','-w','--stdin'],{input:text}).trim();
      updates.push({path,text,file,updateWork:work===staged,oid});
    }
    if(git(['write-tree']).trim()!==indexTree) throw new Error('index changed before metric staging');
    // One index transaction prevents a lock conflict from leaving a partially
    // updated set of board metrics. Git owns the lock; never remove it here.
    git(['update-index','-z','--index-info'],{input:updates.map(u=>`100644 ${u.oid}\t${u.path}\0`).join('')});
    for(const u of updates) if(u.updateWork) writeFileSync(u.file,u.text);
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
