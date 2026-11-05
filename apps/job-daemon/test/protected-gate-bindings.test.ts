import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {test} from 'node:test';
import {parseCanonicalJson} from '../src/canonical-json.ts';import {resolveManifestClosure} from '../src/protected-closure.ts';import {bindGateInputsToManifest} from '../src/protected-gate-bindings.ts';
import {validateManifestBoundGateEvidence} from '../src/protected-gate-evidence.ts';
const encode=(v:unknown):Buffer=>parseCanonicalJson(Buffer.from(JSON.stringify(v)),{maxBytes:10000,maxNodes:1000,maxDepth:12}).canonical;
const sha=(v:Buffer):string=>createHash('sha256').update(v).digest('hex');
test('binds independently scanned files, in-root links, absent optionals and approved external tools',()=>{
 const content=Buffer.from('board'),hash=sha(content);
 const manifest=encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:hash,size:content.length,executable:false},{kind:'link',path:'ref',target:'board'}],required_paths:['board'],optional_absent_paths:['optional'],external_mounts:[]});
 const closure=resolveManifestClosure(sha(manifest),()=>manifest,h=>h===hash?content.length:null,{maxDepth:4,maxManifests:4,maxNodes:10,maxBytes:100,maxManifestBytes:10000});
 const external=[{path:'external/kicad/tool',sha256:'a'.repeat(64)}], scanned=[{path:'board',sha256:hash},{path:'ref',sha256:hash,link:'board'},{path:'optional',sha256:null},...external];
 assert.deepEqual(bindGateInputsToManifest(closure,scanned,external),scanned);
 assert.throws(()=>bindGateInputsToManifest(closure,[...scanned,{path:'unknown',sha256:hash}],external),/not bound/);
 assert.throws(()=>bindGateInputsToManifest(closure,[{path:'ref',sha256:hash,link:'other'}],external),/not bound/);
 assert.throws(()=>bindGateInputsToManifest(closure,[{path:'optional',sha256:hash}],external),/not bound/);
 assert.throws(()=>bindGateInputsToManifest(closure,scanned,[{path:'board',sha256:hash}]),/ambiguous/);
});
test('gate acceptance is bound to a manifest rather than a caller-provided fingerprint alone',()=>{
 const content=Buffer.from('board'),hash=sha(content),manifest=encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:hash,size:content.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]});
 const closure=resolveManifestClosure(sha(manifest),()=>manifest,h=>h===hash?content.length:null,{maxDepth:4,maxManifests:4,maxNodes:10,maxBytes:100,maxManifestBytes:10000});
 const inputs=[{path:'board',sha256:hash}],tools={kicad:'10'},fingerprint=sha(Buffer.from(JSON.stringify({inputs,tools}))),toBuffer=(v:unknown)=>Buffer.from(JSON.stringify(v));
 const evidence={result:toBuffer({exit:0,changedDuringRun:false,provenance:{input_sha256:fingerprint,inputs,tools},preflightErrors:[],checks:{erc:{status:'passed',cached:false,metrics:{erc_errors:0}}}}),
  findings:toBuffer({schema_version:1,board:'X',project:'cad/X',input_sha256:fingerprint,inputs_valid:true,complete:true,completed_checks:['erc'],findings:[]}),
  identity:toBuffer({schema:'pcb.board-identity.v1',sourceSha256:hash,candidateSha256:hash,identityPreserved:true}),erc:toBuffer({sheets:[{violations:[]}]})};
 const expected={board:'X',project:'cad/X',inputSha256:fingerprint,closure,scannedInputs:inputs,approvedExternal:[],toolVersions:tools,sourceBoardSha256:hash,candidateBoardSha256:hash,candidateBoardInputPath:'board',requiredChecks:['erc'],processExit:0,terminalEvent:true,warningsAsErrors:false};
 assert.doesNotThrow(()=>validateManifestBoundGateEvidence(evidence,expected));
 assert.throws(()=>validateManifestBoundGateEvidence(evidence,{...expected,scannedInputs:[{path:'board',sha256:'f'.repeat(64)}]}),/not bound/);
});
