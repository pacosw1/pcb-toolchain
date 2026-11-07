// The order record: what a person ordered, from which release, how many, and under which order reference.
// hardware-design/boards/BOARD/release-orders.jsonl (schema iot-lab.release-order.v1) holds one JSON line per order.
// This module only records. It never places an order and never uploads a file. A record needs a fresh release approval
// (lib/release-approval.mjs); an order for a stale or unapproved release is refused. The file is no gate input.
import {createHash} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,mkdirSync,openSync,readFileSync,writeSync} from 'node:fs';
import {join} from 'node:path';
import {releaseApprovalPath,releaseApprovalStatus} from './release-approval.mjs';

export const RELEASE_ORDER_SCHEMA='iot-lab.release-order.v1';
const KEYS=['schema','board','by','candidate_sha256','approval_sha256','what','quantity','reference'];
const text=value=>typeof value==='string' && value.trim()!=='';
const hex=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const need=(condition,message)=>{if(!condition)throw new Error(message);};

export const releaseOrdersPath=(root,board)=>join(root,'hardware-design/boards',board,'release-orders.jsonl');

/** The orders of BOARD in the order they were recorded. A missing file is no orders; a damaged line is an error, never skipped. */
export function releaseOrders(root,board) {
 const path=releaseOrdersPath(root,board);
 if(!existsSync(path))return [];
 return readFileSync(path,'utf8').split('\n').flatMap((line,index)=>{
  if(!line.trim())return [];
  const fail=reason=>{throw new Error(`${path} line ${index+1} is not an order of ${board}: ${reason}`);};
  let entry;
  try {entry=JSON.parse(line);} catch(error) {return fail(error.message);}
  if(!entry || typeof entry!=='object' || Array.isArray(entry))return fail('not a JSON object');
  if(Object.keys(entry).length!==KEYS.length || KEYS.some(key=>!(key in entry)))return fail(`keys must be ${KEYS.join(', ')}`);
  if(entry.schema!==RELEASE_ORDER_SCHEMA || entry.board!==board)return fail(`schema must be ${RELEASE_ORDER_SCHEMA} and board ${board}`);
  if(!text(entry.by) || !text(entry.what) || !text(entry.reference) || !hex(entry.candidate_sha256) || !hex(entry.approval_sha256) || !Number.isSafeInteger(entry.quantity) || entry.quantity<1)return fail('a field is missing or has the wrong type');
  return [entry];
 });
}

/**
 * Records one order of the candidate in CANDIDATE. Fail closed: no person, text, whole quantity or reference, a release
 * without a fresh approval, or a reference that is already recorded stops before anything is written.
 */
export function recordOrder(root,board,candidate,{by,what,quantity,reference}={}) {
 need(text(by),'order record requires --by NAME');
 need(text(what),'order record requires --what TEXT (what was ordered)');
 need(Number.isSafeInteger(quantity) && quantity>0,'order record requires --quantity N (a positive whole number)');
 need(text(reference),'order record requires --reference TEXT (the order reference of the supplier)');
 const approval=releaseApprovalStatus(root,board,candidate);
 const details=[...approval.problems,...approval.stale].join('; ');
 need(approval.state==='approved',`${board} has no approved release (approval state: ${approval.state})${details?`: ${details}`:''}. A person approves the release first: tools/pcb release-approval ${board} --candidate DIR --approve --by NAME --reason TEXT --report FILE --image FILE`);
 const orders=releaseOrders(root,board);
 need(!orders.some(entry=>entry.reference===reference.trim()),`order reference ${reference.trim()} is already recorded for ${board}`);
 const entry={schema:RELEASE_ORDER_SCHEMA,board,by:by.trim(),candidate_sha256:approval.approval.candidate_sha256,
  approval_sha256:createHash('sha256').update(readFileSync(releaseApprovalPath(root,board))).digest('hex'),what:what.trim(),quantity,reference:reference.trim()};
 const path=releaseOrdersPath(root,board);
 mkdirSync(join(path,'..'),{recursive:true});
 const file=openSync(path,'a');
 try {writeSync(file,JSON.stringify(entry)+'\n');fsyncSync(file);} finally {closeSync(file);}
 return entry;
}
