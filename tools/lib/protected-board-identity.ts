// Board identity comparison for an independently owned verifier workspace. This does not invoke the gate or authorize adoption.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pcbIdentity } from './pcb-identity.ts';
import type { PourSet } from './pcb-identity.ts';
import { sameValue } from './py-values.ts';

function readBoard(file:string): {sha256:string;bytes:number} {
  const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 64*1024*1024) throw new Error('invalid protected board file');
    const content=fs.readFileSync(fd); if (content.length !== stat.size) throw new Error('protected board changed while reading');
    return {sha256:createHash('sha256').update(content).digest('hex'),bytes:content.length};
  } finally {fs.closeSync(fd);}
}
/** Allowed pours must be derived by the trusted verifier from its bound policy, never from an untrusted candidate. */
export function verifyProtectedBoardIdentity(source:string,candidate:string,allowedPours:PourSet = new Set()): {sourceSha256:string;candidateSha256:string;identityPreserved:boolean} {
  const before=readBoard(source), after=readBoard(candidate);
  const sourceIdentity=pcbIdentity(source,allowedPours), candidateIdentity=pcbIdentity(candidate,allowedPours);
  const beforeAgain=readBoard(source), afterAgain=readBoard(candidate);
  if (before.sha256!==beforeAgain.sha256 || before.bytes!==beforeAgain.bytes || after.sha256!==afterAgain.sha256 || after.bytes!==afterAgain.bytes)
    throw new Error('protected board changed during identity check');
  return {sourceSha256:before.sha256,candidateSha256:after.sha256,identityPreserved:sameValue(sourceIdentity,candidateIdentity)};
}
