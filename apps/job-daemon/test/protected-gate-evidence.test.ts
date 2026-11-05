import assert from 'node:assert/strict'; import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { validateFreshGateEvidence } from '../src/protected-gate-evidence.ts';
const b=(v:unknown):Buffer=>Buffer.from(JSON.stringify(v)); const inputs=[{path:'cad/X.kicad_pcb',sha256:'a'.repeat(64)}], tools={kicad:'10'};
const inputHash=createHash('sha256').update(JSON.stringify({inputs,tools})).digest('hex');
const expected={board:'X',project:'cad/X',inputSha256:inputHash,requiredInputs:inputs,toolVersions:tools,sourceBoardSha256:'b'.repeat(64),candidateBoardSha256:'a'.repeat(64),candidateBoardInputPath:'cad/X.kicad_pcb',requiredChecks:['erc','drc'],processExit:0,terminalEvent:true,warningsAsErrors:false};
const fixture=()=>({result:{exit:0,changedDuringRun:false,provenance:{input_sha256:inputHash,inputs:inputs.map(x=>({...x})),tools:{...tools}},preflightErrors:[],checks:{erc:{status:'passed',cached:false,metrics:{erc_errors:0}},drc:{status:'passed',cached:false,metrics:{drc_errors:0,drc_parity:0}}}},
  findings:{schema_version:1,board:'X',project:'cad/X',input_sha256:inputHash,inputs_valid:true,complete:true,completed_checks:['erc','drc'],findings:[] as unknown[]},
  identity:{schema:'pcb.board-identity.v1',sourceSha256:expected.sourceBoardSha256,candidateSha256:expected.candidateBoardSha256,identityPreserved:true},
  erc:{sheets:[{violations:[] as unknown[]}]},drc:{violations:[] as unknown[],schematic_parity:[] as unknown[],unconnected_items:[] as unknown[]}});
const run=(f:ReturnType<typeof fixture>, e=expected)=>validateFreshGateEvidence({result:b(f.result),findings:b(f.findings),identity:b(f.identity),erc:b(f.erc),drc:b(f.drc)},e);
test('requires complete fresh gate results and clean native parity',()=>{
  const good=fixture();assert.match(run(good).resultSha256,/^[0-9a-f]{64}$/);
  const cached=fixture();cached.result.checks.drc.cached=true;assert.throws(()=>run(cached),/cached/);
  const stale=fixture();stale.result.provenance.input_sha256='b'.repeat(64);assert.throws(()=>run(stale),/inputs/);
  const altered=fixture();altered.result.provenance.inputs[0].sha256='c'.repeat(64);assert.throws(()=>run(altered),/dependency changed/);
  const toolChange=fixture();toolChange.result.provenance.tools.kicad='11';assert.throws(()=>run(toolChange),/tool versions/);
  const missing=fixture();missing.findings.completed_checks=['erc'];assert.throws(()=>run(missing),/findings/);
  const parity=fixture();parity.drc.schematic_parity=[{}];assert.throws(()=>run(parity),/DRC/);
  const violation=fixture();violation.erc.sheets[0].violations=[{severity:'error'}];assert.throws(()=>run(violation),/ERC/);
  const duplicate=fixture(); const raw=b(duplicate.result).toString().replace('"exit":0','"exit":0,"exit":0');
  assert.throws(()=>validateFreshGateEvidence({result:Buffer.from(raw),findings:b(duplicate.findings),identity:b(duplicate.identity),erc:b(duplicate.erc),drc:b(duplicate.drc)},expected),/JSON/);
  const changedIdentity=fixture(); changedIdentity.identity.identityPreserved=false; assert.throws(()=>run(changedIdentity),/identity/);
  assert.throws(()=>run(good,{...expected,candidateBoardSha256:'f'.repeat(64)}),/board is absent/);
  const coordinates=fixture(); coordinates.findings.findings=[{stage:'drc',severity:'warning',location:{x:-0.25,y:1e-3}}];
  assert.doesNotThrow(()=>run(coordinates));
  assert.throws(()=>run(coordinates,{...expected,warningsAsErrors:true}),/findings/);
  assert.throws(()=>run(good,{...expected,terminalEvent:false}),/invocation/);
});
