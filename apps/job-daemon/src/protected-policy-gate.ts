// Internal verifier composition. Authentication of keys and independent execution/scanning remain caller responsibilities.
import type { KeyObject } from 'node:crypto';
import { createHash } from 'node:crypto';
import { verifySignedPolicy } from './protected-policy.ts';
import { validateManifestBoundGateEvidence } from './protected-gate-evidence.ts';
import { assertBoardOnlyChange } from './protected-manifest.ts';
import type { ManifestClosure } from './protected-closure.ts';
import type { GateInputBinding } from './protected-gate-bindings.ts';

type Evidence=Parameters<typeof validateManifestBoundGateEvidence>[0];
/** Verify an enrolled signer's exact policy before applying its gate and dependency requirements. */
export function validatePolicyBoundGateEvidence(evidence:Evidence, policyBytes:Uint8Array, signature:string, key:KeyObject, keyId:string, revoked:boolean,
  expected:{nowMs:number;projectId:string;boardId:string;operation:string;policySha256:string;verifierImageSha256:string;toolchainSha256:string;archiveToolSha256:string;
    source:ManifestClosure;candidate:ManifestClosure;scannedInputs:GateInputBinding[];inputSha256:string;configuredChecks:string[];processExit:number;terminalEvent:boolean}):
    {policySha256:string;signerKeyId:string;evidence:ReturnType<typeof validateManifestBoundGateEvidence>} {
  const signed=verifySignedPolicy(policyBytes,signature,key,keyId,revoked,expected.nowMs),p=signed.policy;
  const checks=new Set(expected.configuredChecks);
  if(signed.policySha256!==expected.policySha256||p.project_id!==expected.projectId||p.board_id!==expected.boardId||p.operation!==expected.operation||
     p.verifier_image_sha256!==expected.verifierImageSha256||p.toolchain_sha256!==expected.toolchainSha256||p.archive_tool_sha256!==expected.archiveToolSha256||
     expected.source.rootProject!==p.project_id||expected.candidate.rootProject!==p.project_id||checks.size!==expected.configuredChecks.length||checks.size!==p.required_checks.length||
     p.required_checks.some(check=>!checks.has(check)))throw new Error('signed policy does not match verifier attempt or configured gate');
  const source=expected.source.rootManifest.entries.find(entry=>entry.path===p.board_path),candidate=expected.candidate.rootManifest.entries.find(entry=>entry.path===p.board_path);
  if(!source||source.kind!=='file'||!candidate||candidate.kind!=='file'||!expected.source.rootManifest.required_paths.includes(p.board_path)||!expected.candidate.rootManifest.required_paths.includes(p.board_path))
    throw new Error('signed policy board is absent from snapshot');
  assertBoardOnlyChange(expected.source.rootManifest,expected.candidate.rootManifest,p.board_path);
  const pourKeys=p.allowed_pours.map(pour=>JSON.stringify([pour.name,pour.net,pour.layer])).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const allowedPoursSha256=createHash('sha256').update('pcb.allowed-pours.v1\0').update(JSON.stringify(pourKeys)).digest('hex');
  const result=validateManifestBoundGateEvidence(evidence,{board:p.gate_board,project:p.gate_project,inputSha256:expected.inputSha256,
    closure:expected.candidate,scannedInputs:expected.scannedInputs,approvedExternal:p.external_inputs,toolVersions:p.tool_versions,
    sourceBoardSha256:source.sha256,candidateBoardSha256:candidate.sha256,candidateBoardInputPath:p.board_path,allowedPoursSha256,requiredChecks:p.required_checks,
    processExit:expected.processExit,terminalEvent:expected.terminalEvent,warningsAsErrors:p.warnings_as_errors});
  return {policySha256:signed.policySha256,signerKeyId:signed.keyId,evidence:result};
}
