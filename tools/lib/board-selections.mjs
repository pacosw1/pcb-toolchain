import {readFile,realpath,lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {revisionBoms} from './bom-ownership.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
// This ledger proves historical design selection only. Later lifecycle states
// need their own CAD/order/assembly/measurement evidence model.
const states = new Set(['electrically-selected']);
const partFields = ['lcsc','mpn','state','references','reviews','evidence','evidence_sha256',
                    'observed_at_utc','datasheet','datasheet_sha256'];
function need(condition, reason) { if(!condition) throw new Error(reason); }

// Canonical relative paths plus realpath containment reject traversal and symlinks
// outside the relevant evidence owner. A hash does not authorize another board.
async function bounded(root, path, prefix) {
  need(typeof path==='string' && path.startsWith(prefix+'/') && !isAbsolute(path) &&
       !path.includes('\\') && path.split('/').every(p=>p && p!=='.' && p!=='..'), 'unsafe selection evidence path');
  const owner = await realpath(resolve(root,prefix));
  const ownerRel=relative(await realpath(root),owner);
  need(ownerRel && !ownerRel.startsWith('..') && !isAbsolute(ownerRel), 'selection evidence owner escapes repository');
  const target = await realpath(resolve(root,path));
  const rel = relative(owner,target);
  need(rel && !rel.startsWith('..') && !isAbsolute(rel), 'selection evidence escapes owner');
  return readFile(target);
}

export async function loadBoardSelection(root, entry, csv, rows,revisionName) {
  const board=entry.directory;
  const prefix=`hardware-design/boards/${board}`;
  const perRevision=entry.bom_policy==='per-revision';
  revisionBoms(entry);
  need(!perRevision || typeof revisionName==='string','per-revision selection requires explicit revision selector');
  const owner=perRevision?entry.revisions.find(r=>r.revision===revisionName):null;
  need(!perRevision || owner,'unknown selection revision selector');
  if(owner)need(sha(await bounded(root,`${prefix}/${owner.bom}`,prefix))===sha(csv),
   'selection supplied BOM differs from owned revision source');
  const manifestPath=`${prefix}/${owner?.selection??'BOM-VERIFIED.selection.json'}`;
  try { await lstat(resolve(root,manifestPath)); }
  catch(error) {
    if(error.code==='ENOENT') {
      need(!perRevision && !entry.revisions.some(r=>r.selection==='BOM-VERIFIED.selection.json'), 'registered board selection ledger missing');
      return null;
    }
    throw error;
  }
  const text=await bounded(root,manifestPath,prefix);
  const ledger=JSON.parse(text);
  need(ledger.schema_version===1 && ledger.board===board, 'selection board/schema mismatch');
  const revision=entry.revisions.find(r=>r.revision===ledger.revision);
  need(!owner || revision===owner,'selection ledger belongs to a different requested revision');
  need(revision && ledger.revision_spec===`${prefix}/${revision.spec}`, 'selection revision/spec mismatch');
  need((perRevision || revision.bom==='BOM-VERIFIED.csv') && `${prefix}/${revision.selection}`===manifestPath,
       'selection revision does not own this BOM/ledger');
  need(entry.revisions.filter(r=>r.bom===revision.bom || r.selection===revision.selection).length===1,
       'selection BOM/ledger has ambiguous revision ownership');
  need(ledger.bom===`${prefix}/${revision.bom}` && hash(ledger.bom_sha256) && sha(csv)===ledger.bom_sha256,
       'selection BOM identity/hash mismatch');
  need(states.has(ledger.state), 'selection state does not establish electrical/CAD selection');
  need(ledger.stock_current===false && ledger.qualified===false && ledger.release_approved===false,
       'historical selection cannot assert current stock or qualification');
  need(typeof ledger.state_basis==='string' && ledger.state_basis.trim() &&
       Array.isArray(ledger.limits) && ledger.limits.length && ledger.limits.every(x=>typeof x==='string' && x.trim()),
       'selection basis/limits missing');
  need(ledger.review_evidence && typeof ledger.review_evidence==='object' && !Array.isArray(ledger.review_evidence),
       'selection review evidence missing');
  need(typeof ledger.selection_review==='string' && ledger.selection_review!==ledger.revision_spec &&
       hash(ledger.review_evidence[ledger.selection_review]) && hash(ledger.review_evidence[ledger.revision_spec]),
       'selection requires attributable review and revision spec');
  for(const [path,digest] of Object.entries(ledger.review_evidence)) {
    need(path.endsWith('.md') && hash(digest), 'invalid selection review attribution');
    const content=await bounded(root,path,prefix);
    need(content.toString().trim() && sha(content)===digest, 'selection review hash mismatch');
  }
  need(Array.isArray(ledger.parts) && ledger.parts.length, 'selection parts missing');
  const parts=new Map(), references=new Map();
  for(const p of ledger.parts) {
    need(p && typeof p==='object' && !Array.isArray(p) &&
         Object.keys(p).every(key=>partFields.includes(key)), 'unsupported selection part field/lifecycle claim');
    need(/^C\d+$/.test(p.lcsc) && typeof p.mpn==='string' && p.mpn.trim()===p.mpn && p.mpn &&
         !parts.has(p.lcsc), 'invalid/duplicate selection part identity');
    need(p.state===ledger.state && states.has(p.state), 'selection part state mismatch');
    need(Array.isArray(p.references) && p.references.length && p.references.every(x=>typeof x==='string' && x.trim()===x && x),
         'selection references missing');
    need(Array.isArray(p.reviews) && p.reviews.includes(ledger.selection_review) &&
         p.reviews.every(path=>hash(ledger.review_evidence[path])), 'selection part review missing');
    // Return only the validated historical schema, never arbitrary manifest
    // properties or mutable aliases to its arrays.
    const selected=Object.fromEntries(partFields.map(key=>[key,
      Array.isArray(p[key]) ? [...p[key]] : p[key]]));
    for(const ref of p.references) {
      need(!references.has(ref), 'duplicate selected reference');
      references.set(ref,selected);
    }
    need(hash(p.evidence_sha256) && hash(p.datasheet_sha256), 'selection evidence hashes missing');
    const registry='hardware-design/registry';
    need(typeof p.evidence==='string' && p.evidence.startsWith('evidence/') && p.evidence.endsWith('.json') &&
         typeof p.datasheet==='string' && p.datasheet.startsWith('datasheets/') && p.datasheet.endsWith('.pdf'),
         'selection requires registry snapshot and PDF');
    const raw=await bounded(root,`${registry}/${p.evidence}`,registry);
    need(sha(raw)===p.evidence_sha256, 'selection snapshot hash mismatch');
    const snapshot=JSON.parse(raw);
    const html=await bounded(root,`${registry}/${p.evidence.replace(/\.json$/,'.html')}`,registry);
    need(snapshot.expected_lcsc===p.lcsc && snapshot.identity_matched===true && snapshot.stock_verified===true &&
         typeof p.observed_at_utc==='string' && Number.isFinite(Date.parse(p.observed_at_utc)) &&
         snapshot.fetched_at_utc===p.observed_at_utc && sha(html)===snapshot.source_sha256 &&
         snapshot.purchase_record?.componentModelEn===p.mpn && snapshot.purchase_record?.componentCode===p.lcsc,
         'selection historical stock/MPN/source identity mismatch');
    const pdf=await bounded(root,`${registry}/${p.datasheet}`,registry);
    const receipt=JSON.parse(await bounded(root,`${registry}/${p.datasheet}.source.json`,registry));
    need(sha(pdf)===p.datasheet_sha256 && receipt.sha256===p.datasheet_sha256 &&
         typeof receipt.source_url==='string' && /^https?:\/\//.test(receipt.source_url) &&
         Number.isFinite(Date.parse(receipt.fetched_at_utc)), 'selection PDF provenance/hash mismatch');
    parts.set(p.lcsc,selected);
  }
  const seen=new Set();
  for(const row of rows.slice(1)) {
    const ref=row[0]?.trim(), lcsc=row[3]?.trim(), p=references.get(ref);
    need(p && !seen.has(ref) && p.lcsc===lcsc && p.mpn===row[2]?.trim(), 'selection BOM reference/MPN/LCSC mismatch');
    seen.add(ref);
  }
  need(seen.size===references.size, 'selection has references outside BOM');
  return {revision:ledger.revision,parts,references,manifest:manifestPath};
}
