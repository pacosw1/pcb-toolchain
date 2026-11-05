// Verification-policy signature primitives. Trust-root provisioning and policy activation are not wired.
import { createHash, verify, type KeyObject } from 'node:crypto';
import { parseCanonicalJson } from './canonical-json.ts';
import { validateManifestPath } from './protected-link-resolution.ts';
const SHA=/^[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[]):boolean=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const pathOk=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=4096&&!/[\u0000-\u001f\u007f]/u.test(v);
export interface SignedVerificationPolicy {
  schema:'pcb.verification-policy.v1';policy_id:string;project_id:string;board_id:string;operation:string;
  board_path:string;gate_board:string;gate_project:string;
  required_checks:string[];warnings_as_errors:boolean;parity_not_applicable_allowed:boolean;
  verifier_image_sha256:string;toolchain_sha256:string;archive_tool_sha256:string;
  tool_versions:Record<string,string>;
  external_inputs:{path:string;sha256:string|null;link?:string}[];
  allowed_pours:{name:string;net:string;layer:string}[];issued_at_ms:number;expires_at_ms:number;
}
/** Signatures bind the exact canonical policy and domain. The caller owns trusted key enrollment and revocation. */
export function verifySignedPolicy(policyBytes:Uint8Array,signatureBase64:string,key:KeyObject,expectedKeyId:string,revoked:boolean,nowMs:number):
  {policy:SignedVerificationPolicy;policySha256:string;keyId:string} {
  if (!key || key.type!=='public' || key.asymmetricKeyType!=='ed25519' || !SHA.test(expectedKeyId) || revoked!==false || !Number.isSafeInteger(nowMs) || nowMs<1 ||
      typeof signatureBase64!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64)) throw new Error('policy signer is not authorized');
  const der=key.export({type:'spki',format:'der'}), keyId=createHash('sha256').update(der).digest('hex');
  if(keyId!==expectedKeyId)throw new Error('policy signer identity mismatch');
  const parsed=parseCanonicalJson(policyBytes,{maxBytes:8*1024*1024,maxNodes:200_000,maxDepth:16});
  if(!Buffer.from(policyBytes).equals(parsed.canonical))throw new Error('policy bytes are not canonical');
  const signature=Buffer.from(signatureBase64,'base64');
  if(signature.length!==64 || signature.toString('base64')!==signatureBase64 || !verify(null,Buffer.concat([Buffer.from('pcb.verification-policy.v1\0'),parsed.canonical]),key,signature))
    throw new Error('policy signature is invalid');
  const p=parsed.value;
  if(!object(p)||!exact(p,['schema','policy_id','project_id','board_id','operation','board_path','gate_board','gate_project','required_checks','warnings_as_errors','parity_not_applicable_allowed','verifier_image_sha256','toolchain_sha256','archive_tool_sha256','tool_versions','external_inputs','allowed_pours','issued_at_ms','expires_at_ms'])||
    p.schema!=='pcb.verification-policy.v1'||![p.policy_id,p.project_id,p.board_id,p.operation,p.gate_board].every(x=>typeof x==='string'&&ID.test(x))||!pathOk(p.board_path)||!pathOk(p.gate_project)||
    ![p.verifier_image_sha256,p.toolchain_sha256,p.archive_tool_sha256].every(x=>typeof x==='string'&&SHA.test(x))||typeof p.warnings_as_errors!=='boolean'||typeof p.parity_not_applicable_allowed!=='boolean'||
    !Number.isSafeInteger(p.issued_at_ms)||!Number.isSafeInteger(p.expires_at_ms)||(p.issued_at_ms as number)<1||(p.issued_at_ms as number)>nowMs||(p.expires_at_ms as number)<=nowMs||
    !Array.isArray(p.required_checks)||!p.required_checks.length||p.required_checks.length>5000||!p.required_checks.every(x=>typeof x==='string'&&ID.test(x))||new Set(p.required_checks).size!==p.required_checks.length||
    !object(p.tool_versions)||Object.keys(p.tool_versions).length<1||Object.keys(p.tool_versions).length>1000||
    Object.entries(p.tool_versions).some(([key,value])=>!ID.test(key)||typeof value!=='string'||!value||Buffer.byteLength(value)>1024)||
    !Array.isArray(p.external_inputs)||p.external_inputs.length>100_000||!Array.isArray(p.allowed_pours)||p.allowed_pours.length>10_000) throw new Error('invalid signed verification policy');
  try { validateManifestPath(p.board_path as string); validateManifestPath(p.gate_project as string); } catch { throw new Error('invalid signed policy path'); }
  let previous='';
  for(const row of p.external_inputs){
    if(!object(row)||!exact(row,Object.hasOwn(row,'link')?['path','sha256','link']:['path','sha256'])||!pathOk(row.path)||
      (row.sha256!==null&&(typeof row.sha256!=='string'||!SHA.test(row.sha256)))||(Object.hasOwn(row,'link')&&!pathOk(row.link))||
      (previous&&Buffer.compare(Buffer.from(previous),Buffer.from(row.path as string))>=0))throw new Error('invalid policy external input');
    previous=row.path as string;
  }
  const pours=new Set<string>();
  for(const row of p.allowed_pours){
    if(!object(row)||!exact(row,['name','net','layer'])||![row.name,row.net,row.layer].every(x=>pathOk(x)&&Buffer.byteLength(x)<=256))throw new Error('invalid policy pour');
    const identity=JSON.stringify([row.name,row.net,row.layer]);if(pours.has(identity))throw new Error('duplicate policy pour');pours.add(identity);
  }
  if(p.allowed_pours.length && p.operation!=='route')throw new Error('pours require route policy');
  return {policy:p as unknown as SignedVerificationPolicy,policySha256:parsed.sha256,keyId};
}
