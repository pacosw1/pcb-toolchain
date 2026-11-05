import assert from 'node:assert/strict';import {createHash,generateKeyPairSync,sign} from 'node:crypto';import {test} from 'node:test';
import {parseCanonicalJson} from '../src/canonical-json.ts';import {verifySignedPolicy} from '../src/protected-policy.ts';
import {resolveManifestClosure} from '../src/protected-closure.ts';import {validatePolicyBoundGateEvidence} from '../src/protected-policy-gate.ts';
import {allowedPoursDigest} from '../../../tools/lib/protected-board-identity.ts';
const encode=(v:unknown)=>parseCanonicalJson(Buffer.from(JSON.stringify(v)),{maxBytes:100000,maxNodes:10000,maxDepth:16}).canonical;
test('authenticates exact policy bytes, signer, revocation and allowed scope',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'), keyId=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
 const doc={schema:'pcb.verification-policy.v1',policy_id:'policy',project_id:'p',board_id:'b',operation:'route',board_path:'board',gate_board:'X',gate_project:'cad/X',required_checks:['erc','drc'],warnings_as_errors:false,parity_not_applicable_allowed:false,
  worker_image_sha256:'e'.repeat(64),verifier_image_sha256:'a'.repeat(64),toolchain_sha256:'b'.repeat(64),archive_tool_sha256:'c'.repeat(64),tool_versions:{kicad:'10'},external_inputs:[{path:'external/kicad/a',sha256:'d'.repeat(64)}],allowed_pours:[{name:'GND',net:'GND',layer:'B.Cu'}],issued_at_ms:100,expires_at_ms:1000};
 const policy=encode(doc), signature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),policy]),privateKey).toString('base64');
 const result=verifySignedPolicy(policy,signature,publicKey,keyId,false,200);assert.equal(result.policy.project_id,'p');assert.equal(result.policySha256,createHash('sha256').update(policy).digest('hex'));
 assert.throws(()=>verifySignedPolicy(policy,signature,publicKey,keyId,true,200),/authorized/);
 assert.throws(()=>verifySignedPolicy(policy,signature,publicKey,'0'.repeat(64),false,200),/identity/);
 assert.throws(()=>verifySignedPolicy(policy,signature,publicKey,keyId,false,1000),/policy/);
 assert.throws(()=>verifySignedPolicy(encode({...doc,board_id:'other'}),signature,publicKey,keyId,false,200),/signature/);
 const wrongDomain=sign(null,policy,privateKey).toString('base64');assert.throws(()=>verifySignedPolicy(policy,wrongDomain,publicKey,keyId,false,200),/signature/);
 const badDoc={...doc,required_checks:['erc','erc']}, badPolicy=encode(badDoc),badSignature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),badPolicy]),privateKey).toString('base64');
 assert.throws(()=>verifySignedPolicy(badPolicy,badSignature,publicKey,keyId,false,200),/invalid signed/);
});
test('signed policy binds the exact board, gate configuration, dependencies and verifier identities',()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),keyId=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
 const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),board=Buffer.from('board'),boardHash=sha(board);
 const manifest=encode({schema:'pcb.project-manifest.v1',project_id:'p',entries:[{kind:'file',path:'board',sha256:boardHash,size:board.length,executable:false}],required_paths:['board'],optional_absent_paths:[],external_mounts:[]});
 const closure=resolveManifestClosure(sha(manifest),()=>manifest,h=>h===boardHash?board.length:null,{maxDepth:4,maxManifests:4,maxNodes:10,maxBytes:100,maxManifestBytes:10000});
 const doc={schema:'pcb.verification-policy.v1',policy_id:'policy',project_id:'p',board_id:'b',operation:'route',board_path:'board',gate_board:'X',gate_project:'cad/X',required_checks:['erc'],warnings_as_errors:false,parity_not_applicable_allowed:false,
  worker_image_sha256:'e'.repeat(64),verifier_image_sha256:'a'.repeat(64),toolchain_sha256:'b'.repeat(64),archive_tool_sha256:'c'.repeat(64),tool_versions:{kicad:'10'},external_inputs:[],allowed_pours:[],issued_at_ms:100,expires_at_ms:1000};
 const policy=encode(doc),signature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),policy]),privateKey).toString('base64');
 const inputs=[{path:'board',sha256:boardHash}],tools={kicad:'10'},fingerprint=sha(Buffer.from(JSON.stringify({inputs,tools}))),b=(v:unknown)=>Buffer.from(JSON.stringify(v));
 const pourHash=createHash('sha256').update('pcb.allowed-pours.v1\0').update('[]').digest('hex');
 const evidence={result:b({exit:0,changedDuringRun:false,provenance:{input_sha256:fingerprint,inputs,tools},preflightErrors:[],checks:{erc:{status:'passed',cached:false,metrics:{erc_errors:0}}}}),findings:b({schema_version:1,board:'X',project:'cad/X',input_sha256:fingerprint,inputs_valid:true,complete:true,completed_checks:['erc'],findings:[]}),identity:b({schema:'pcb.board-identity.v1',sourceSha256:boardHash,candidateSha256:boardHash,allowedPoursSha256:pourHash,identityPreserved:true}),erc:b({sheets:[{violations:[]}]})};
 const expected={nowMs:200,projectId:'p',boardId:'b',operation:'route',policySha256:sha(policy),workerImageSha256:'e'.repeat(64),verifierImageSha256:'a'.repeat(64),toolchainSha256:'b'.repeat(64),archiveToolSha256:'c'.repeat(64),source:closure,candidate:closure,scannedInputs:inputs,inputSha256:fingerprint,configuredChecks:['erc'],processExit:0,terminalEvent:true};
 assert.equal(validatePolicyBoundGateEvidence(evidence,policy,signature,publicKey,keyId,false,expected).policySha256,sha(policy));
 assert.throws(()=>validatePolicyBoundGateEvidence(evidence,policy,signature,publicKey,keyId,false,{...expected,configuredChecks:['erc','drc']}),/configured gate/);
 assert.throws(()=>validatePolicyBoundGateEvidence(evidence,policy,signature,publicKey,keyId,false,{...expected,verifierImageSha256:'f'.repeat(64)}),/attempt/);
 assert.throws(()=>validatePolicyBoundGateEvidence(evidence,policy,signature,publicKey,keyId,true,expected),/authorized/);
 const withPour=encode({...doc,allowed_pours:[{name:'GND',net:'1',layer:'B.Cu'}]}),pourSignature=sign(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),withPour]),privateKey).toString('base64');
 const pourDigest=allowedPoursDigest(new Set([JSON.stringify(['GND','1','B.Cu'])]));
 const poured={...evidence,identity:b({schema:'pcb.board-identity.v1',sourceSha256:boardHash,candidateSha256:boardHash,allowedPoursSha256:pourDigest,identityPreserved:true})};
 assert.doesNotThrow(()=>validatePolicyBoundGateEvidence(poured,withPour,pourSignature,publicKey,keyId,false,{...expected,policySha256:sha(withPour)}));
 assert.throws(()=>validatePolicyBoundGateEvidence(evidence,withPour,pourSignature,publicKey,keyId,false,{...expected,policySha256:sha(withPour)}),/identity/);
});
