// Read-only policy signer configuration. Call only from a service-owned fixed path, never a client-selected path.
import { createHash, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseCanonicalJson } from './canonical-json.ts';
const SHA=/^[0-9a-f]{64}$/;
const obj=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[]):boolean=>Object.keys(v).length===names.length&&names.every(n=>Object.hasOwn(v,n));
export interface PolicyTrustSnapshot {version:number;sha256:string;signers:{keyId:string;pem:string;revoked:boolean}[]}
/** Production must pass uid 0 or a dedicated service owner; ancestors are root/owner-controlled. */
export function readPolicyTrust(file:string,ownerUid:number):PolicyTrustSnapshot {
  if(!path.isAbsolute(file)||!Number.isSafeInteger(ownerUid)||ownerUid<0)throw new Error('invalid policy trust path');
  let current=path.parse(file).root;
  const parts=file.slice(current.length).split('/');
  if(parts.some(x=>!x||x==='.'||x==='..'))throw new Error('invalid policy trust path');
  for(const part of parts.slice(0,-1)){
    current=path.join(current,part);const stat=fs.lstatSync(current),stickyRoot=stat.uid===0&&(stat.mode&0o1000)!==0;
    if(!stat.isDirectory()||stat.isSymbolicLink()||![0,ownerUid].includes(stat.uid)||((stat.mode&0o022)!==0&&!stickyRoot))throw new Error('unsafe policy trust directory');
  }
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd);
    if(!before.isFile()||before.uid!==ownerUid||(before.mode&0o022)!==0||before.size<1||before.size>1024*1024)throw new Error('unsafe policy trust file');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);
    if(bytes.length!==before.size||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error('policy trust file changed while reading');
    const parsed=parseCanonicalJson(bytes,{maxBytes:1024*1024,maxNodes:10000,maxDepth:8});
    if(!bytes.equals(parsed.canonical))throw new Error('policy trust file is not canonical');
    const doc=parsed.value;
    if(!obj(doc)||!keys(doc,['schema','version','signers'])||doc.schema!=='pcb.policy-trust.v1'||!Number.isSafeInteger(doc.version)||(doc.version as number)<1||
      !Array.isArray(doc.signers)||doc.signers.length<1||doc.signers.length>1000)throw new Error('invalid policy trust document');
    const seen=new Set<string>(),signers:PolicyTrustSnapshot['signers']=[];
    for(const row of doc.signers){
      if(!obj(row)||!keys(row,['key_id','public_key_pem','revoked'])||typeof row.key_id!=='string'||!SHA.test(row.key_id)||seen.has(row.key_id)||
        typeof row.public_key_pem!=='string'||!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/.test(row.public_key_pem)||typeof row.revoked!=='boolean')throw new Error('invalid policy signer');
      let key;try{key=createPublicKey(row.public_key_pem);}catch{throw new Error('invalid policy public key');}
      if(key.type!=='public'||key.asymmetricKeyType!=='ed25519'||createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')!==row.key_id)throw new Error('policy signer identity mismatch');
      seen.add(row.key_id);signers.push({keyId:row.key_id,pem:row.public_key_pem,revoked:row.revoked});
    }
    return {version:doc.version as number,sha256:parsed.sha256,signers};
  } finally {fs.closeSync(fd);}
}
