// The G5 release approval record: a person approves one release candidate after a readiness report that says ready_for_user_review.
// hardware-design/boards/BOARD/release-approval.json (schema iot-lab.release-approval.v1) holds the person, the reason, the sha256 of
// the candidate manifest and of the kept readiness report and image. The report and the image are kept beside the record as
// release-approval.report.json and release-approval.png or .svg, because a candidate folder is not committed.
// A change of the candidate, the report or the image makes the approval stale. Readiness reports g5_release_approved only for a fresh record.
// These files are no gate input (lib/gate-inputs.mjs): an approval written after the gate run must not make the gate evidence stale.
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join,relative,resolve,sep} from 'node:path';
import {withdrawnBy} from './change-log.ts';
import {assertCommand} from './board-machine.ts';

export const RELEASE_APPROVAL_SCHEMA='iot-lab.release-approval.v1';
const KEYS=['schema','board','by','reason','candidate_sha256','report','report_sha256','image','image_sha256'];
const PNG_SIGNATURE=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
// An SVG may start with a BOM, an XML declaration, comments and a doctype. The first element must be svg.
const SVG_START=/^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s/>]/;
const sha256=data=>createHash('sha256').update(data).digest('hex');
const text=value=>typeof value==='string' && value.trim()!=='';
const hex=value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const need=(condition,message)=>{if(!condition)throw new Error(message);};

const boardFolder=(root,board)=>join(root,'hardware-design/boards',board);
export const releaseApprovalPath=(root,board)=>join(boardFolder(root,board),'release-approval.json');
const reportCopyPath=(root,board)=>join(boardFolder(root,board),'release-approval.report.json');
const imageCopyPath=(root,board,extension)=>join(boardFolder(root,board),`release-approval.${extension}`);
const inProject=(root,path)=>relative(resolve(root),resolve(root,path)).split(sep).join('/');

/** The sha256 of release-manifest.json in CANDIDATE, or null when the file is missing. */
function candidateSha256(candidate) {
 const path=join(candidate,'release-manifest.json');
 return existsSync(path)?sha256(readFileSync(path)):null;
}

function atomicWrite(path,data) {
 mkdirSync(join(path,'..'),{recursive:true});
 const temporary=`${path}.tmp-${randomBytes(6).toString('hex')}`;
 try {writeFileSync(temporary,data,{mode:0o600});renameSync(temporary,path);}
 catch(error) {rmSync(temporary,{force:true});throw error;}
}

/** Where the approval of BOARD stands against the candidate in CANDIDATE: missing, invalid, stale or approved. It never reads a bad record as approved. */
export function releaseApprovalStatus(root,board,candidate) {
 const path=releaseApprovalPath(root,board);
 const status=(state,more={})=>({board,state,path,problems:[],stale:[],approval:null,...more});
 if(!existsSync(path))return status('missing');
 let record;
 try {record=JSON.parse(readFileSync(path,'utf8'));} catch(error) {return status('invalid',{problems:[`release approval ${path} is not JSON: ${error.message}`]});}
 const problems=[];
 if(!record || typeof record!=='object' || Array.isArray(record))problems.push('the release approval is not a JSON object');
 else {
  for(const key of Object.keys(record))if(!KEYS.includes(key))problems.push(`unknown key ${key}`);
  if(record.schema!==RELEASE_APPROVAL_SCHEMA)problems.push(`schema must be ${RELEASE_APPROVAL_SCHEMA}`);
  if(record.board!==board)problems.push(`the approval belongs to board ${record.board}, not ${board}`);
  for(const key of ['by','reason','report','image'])if(!text(record[key]))problems.push(`${key} must be text`);
  for(const key of ['candidate_sha256','report_sha256','image_sha256'])if(!hex(record[key]))problems.push(`${key} must be a sha256`);
  for(const key of ['report','image'])if(text(record[key]) && (record[key].startsWith('/') || record[key].split('/').includes('..')))problems.push(`${key} must be a path inside the project`);
 }
 if(problems.length)return status('invalid',{problems});
 const stale=[],current=candidateSha256(candidate),withdrawn=withdrawnBy(root,board,'release',sha256(readFileSync(path)));
 if(withdrawn)stale.push(withdrawn);
 if(current===null)stale.push(`the candidate has no release-manifest.json (${join(candidate,'release-manifest.json')})`);
 else if(current!==record.candidate_sha256)stale.push('the release candidate changed since the approval');
 for(const [key,name] of [['report','report'],['image','image']]) {
  const file=join(root,record[key]);
  if(!existsSync(file))stale.push(`the approved ${name} is missing`);
  else if(sha256(readFileSync(file))!==record[`${key}_sha256`])stale.push(`the approved ${name} changed since the approval`);
 }
 return status(stale.length?'stale':'approved',{stale,approval:record});
}

/**
 * G5 for a readiness result: true only when the approval record is fresh and readiness found nothing.
 * The candidate manifest stays g5_ready false; the record, not the manifest, holds the approval.
 */
export function g5Decision(root,board,candidate,findings) {
 const status=releaseApprovalStatus(root,board,candidate);
 return {g5_release_approved:status.state==='approved' && findings.length===0,g5_approval:{state:status.state,problems:status.problems,stale:status.stale}};
}

/**
 * Records the approval of the candidate in CANDIDATE. The report must be a readiness report of the same board and candidate with
 * status ready_for_user_review. Fail closed: a missing person, reason, report or image, or a report or image that does not fit, stops
 * before any file is written. This function approves; it never orders or uploads.
 */
export function approveRelease(root,board,candidate,{by,reason,report,image}={}) {
 need(text(by),'release approval requires --by NAME');
 need(text(reason),'release approval requires --reason TEXT');
 need(text(report),'release approval requires --report FILE (the output of tools/pcb readiness --json)');
 need(text(image),'release approval requires --image FILE (the image that the person saw)');
 assertCommand(root,board,'release');
 const current=candidateSha256(candidate);
 need(current!==null,`the candidate has no release-manifest.json (${join(candidate,'release-manifest.json')})`);
 let reportBytes,parsed;
 try {reportBytes=readFileSync(report);parsed=JSON.parse(reportBytes.toString('utf8'));} catch(error) {throw new Error(`report ${report} is not a readable JSON file: ${error.message}`);}
 need(parsed && typeof parsed==='object' && !Array.isArray(parsed),`report ${report} is not a JSON object`);
 need(parsed.board===board,`the report belongs to another board (${parsed.board})`);
 need(parsed.status==='ready_for_user_review',`the report status is ${parsed.status}, not ready_for_user_review`);
 need(parsed.checks?.cad_fabrication?.candidate_sha256===current,'the report belongs to another candidate');
 let imageBytes;
 try {imageBytes=readFileSync(image);} catch(error) {throw new Error(`image ${image} is not readable: ${error.message}`);}
 const extension=imageBytes.subarray(0,PNG_SIGNATURE.length).equals(PNG_SIGNATURE)?'png':SVG_START.test(imageBytes.toString('utf8'))?'svg':null;
 need(extension,`image ${image} is not a PNG or SVG file`);
 atomicWrite(reportCopyPath(root,board),reportBytes);
 atomicWrite(imageCopyPath(root,board,extension),imageBytes);
 // One image only: the copy of the other type belonged to an earlier approval.
 for(const other of ['png','svg'])if(other!==extension)rmSync(imageCopyPath(root,board,other),{force:true});
 const record={schema:RELEASE_APPROVAL_SCHEMA,board,by:by.trim(),reason:reason.trim(),candidate_sha256:current,
  report:inProject(root,reportCopyPath(root,board)),report_sha256:sha256(reportBytes),image:inProject(root,imageCopyPath(root,board,extension)),image_sha256:sha256(imageBytes)};
 atomicWrite(releaseApprovalPath(root,board),JSON.stringify(record,null,2)+'\n');
 return releaseApprovalStatus(root,board,candidate);
}
