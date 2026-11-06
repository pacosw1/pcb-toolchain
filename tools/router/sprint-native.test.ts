import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';
import {copyVerificationWorkspace,semanticChecks} from './sprint-native.ts';

test('a candidate under .gate is copied, while nested evidence and build artifacts are excluded',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sprint-copy-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const root=join(dir,'.gate','run','workspace'),out=join(dir,'verify');mkdirSync(out,{recursive:true});
  const put=(p:string,text:string)=>{const file=join(root,p);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
  put('tools/gate.mjs','gate');put('tools/router/core/target/binary','omit');
  put('hardware-design/boards/ENV/cad/ENV.kicad_pcb','board');put('hardware-design/boards/ENV/.gate/old','omit');
  copyVerificationWorkspace(root,out);
  assert.equal(readFileSync(join(out,'tools/gate.mjs'),'utf8'),'gate');
  assert.equal(readFileSync(join(out,'hardware-design/boards/ENV/cad/ENV.kicad_pcb'),'utf8'),'board');
  assert.ok(!existsSync(join(out,'hardware-design/boards/ENV/.gate')));assert.ok(!existsSync(join(out,'tools/router/core/target')));
});

test('semantic hooks receive the normal operation evidence directory',t=>{
  const dir=mkdtempSync(join(tmpdir(),'sprint-hooks-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const hooks=semanticChecks([{stage:'layout',run:['node','check','--json','{operation}/board-check.json']}],dir,'candidate.pcb',process.execPath,process.env);
  const out=hooks[0]!.command.at(-1)!;
  assert.equal(out,join(dir,'operation/board-check.json'));assert.ok(existsSync(dirname(out)));
  assert.throws(()=>semanticChecks([{stage:'../escape',run:['true']}],dir,'candidate.pcb',process.execPath,process.env),/stage name/);
});

test('verification forwards the variant and real slice/finalize log, and still requires the fresh gate',async t=>{
  const {NativeBackend,digest}=await import('./sprint-native.ts');
  const {sprintPolicy}=await import('./sprint-policy.mjs');
  const {createHash}=await import('node:crypto');
  const dir=mkdtempSync(join(tmpdir(),'sprint-feedback-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const resume of [false,true]){
    const root=join(dir,String(resume));mkdirSync(join(root,'tools'),{recursive:true});
    const folder=join(root,'hardware-design/boards/B');mkdirSync(folder,{recursive:true});
    const src=join(folder,'B.kicad_pcb');writeFileSync(src,'source');writeFileSync(join(folder,'gate.json'),'{}');
    const backend=new NativeBackend({root,board:'B',out:join(root,'out.kicad_pcb'),bin:'fake-core',args:[],policy:sprintPolicy({}),maxPasses:80,emit:()=>{}});
    backend.prepared={model:join(root,'model.json'),src,folder,args:{}};
    const variantDir=join(backend.work,'portfolio/v00');mkdirSync(variantDir,{recursive:true});
    const route=join(variantDir,'slice-1.json'), originalLog=join(variantDir,resume?'finalize.log':'slice-1.log');
    const result=JSON.stringify({schema:'iot-lab.route-result.v0',tracks:[],vias:[],failed:[]});
    if(resume){
      const payload=JSON.stringify({schema:'iot-lab.route-resume.v1',pass:5});
      writeFileSync(join(variantDir,'state.json'),`{"payload":${payload},"sha256":"${createHash('sha256').update(payload).digest('hex')}"}`);
    }else{writeFileSync(route,result);writeFileSync(originalLog,'actual slice log');}
    const commands:string[][]=[];
    Object.defineProperty(backend,'owned',{value:async(command:string[],log:string)=>{
      commands.push(command);
      if(command[1]==='sprint-finish'){
        assert.deepEqual(command.slice(5),['23','7.5',originalLog]);
        assert.ok(existsSync(originalLog));
        const board=command[4]!;writeFileSync(board,'selected feedback board');mkdirSync(`${board}.iotroute`);
        writeFileSync(`${board}.iotroute/result.json`,JSON.stringify({status:'PASS',drc_errors:0,unconnected:0,parity:0,board_sha256:digest(board)}));
        return {returncode:0};
      }
      if(command[1]===backend.prepared!.model){writeFileSync(command[2]!,result);writeFileSync(log,'actual finalize log');return {returncode:0};}
      assert.ok(command.includes('--fresh'));
      // Even native-clean feedback cannot bypass a rejected configured gate.
      return {returncode:1};
    }});
    const candidate=await backend.verify({id:'v00',seed:23,via_cost:7.5,state:resume?'yielded':'complete',pass:5,cpu_s:0,...(resume?{}:{route})},new AbortController().signal);
    assert.equal(candidate,null);assert.equal(commands.length,resume?3:2);
    assert.ok(!existsSync(join(variantDir,'verified.json')));
    assert.ok(!existsSync(join(variantDir,'workspace')));
  }
});
