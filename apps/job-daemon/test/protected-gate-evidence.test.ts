import assert from 'node:assert/strict'; import { test } from 'node:test';
import { validateFreshGateEvidence } from '../src/protected-gate-evidence.ts';
const b=(v:unknown):Buffer=>Buffer.from(JSON.stringify(v)); const inputHash='a'.repeat(64);
const expected={board:'X',project:'cad/X',inputSha256:inputHash,requiredChecks:['erc','drc'],processExit:0,terminalEvent:true,warningsAsErrors:false};
const fixture=()=>({result:{exit:0,changedDuringRun:false,provenance:{input_sha256:inputHash,tools:{kicad:'10'}},preflightErrors:[],checks:{erc:{status:'passed',cached:false,metrics:{erc_errors:0}},drc:{status:'passed',cached:false,metrics:{drc_errors:0,drc_parity:0}}}},
  findings:{schema_version:1,board:'X',project:'cad/X',input_sha256:inputHash,inputs_valid:true,complete:true,completed_checks:['erc','drc'],findings:[] as unknown[]},
  erc:{sheets:[{violations:[] as unknown[]}]},drc:{violations:[] as unknown[],schematic_parity:[] as unknown[],unconnected_items:[] as unknown[]}});
const run=(f:ReturnType<typeof fixture>, e=expected)=>validateFreshGateEvidence({result:b(f.result),findings:b(f.findings),erc:b(f.erc),drc:b(f.drc)},e);
test('requires complete fresh gate results and clean native parity',()=>{
  const good=fixture();assert.match(run(good).resultSha256,/^[0-9a-f]{64}$/);
  const cached=fixture();cached.result.checks.drc.cached=true;assert.throws(()=>run(cached),/cached/);
  const stale=fixture();stale.result.provenance.input_sha256='b'.repeat(64);assert.throws(()=>run(stale),/inputs/);
  const missing=fixture();missing.findings.completed_checks=['erc'];assert.throws(()=>run(missing),/findings/);
  const parity=fixture();parity.drc.schematic_parity=[{}];assert.throws(()=>run(parity),/DRC/);
  const violation=fixture();violation.erc.sheets[0].violations=[{severity:'error'}];assert.throws(()=>run(violation),/ERC/);
  assert.throws(()=>run(good,{...expected,terminalEvent:false}),/invocation/);
});
