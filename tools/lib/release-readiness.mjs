import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {inspectPackets,loadBoardRegistry,FULL_PACKET} from './board-packets.mjs';
import {loadBoardSelection} from './board-selections.mjs';
import {parseCsv} from './csv.mjs';
import {owningBomRevision} from './bom-ownership.mjs';
import {fileHashes,sha256,releaseRecipe,verifyFab,verifyReleaseGate,verifyBoardChecks} from './release-evidence.mjs';
import {openDefects} from './change-log.ts';
import {g5Decision} from './release-approval.mjs';

const json=path=>JSON.parse(readFileSync(path,'utf8'));
const need=(condition,message)=>{if(!condition)throw new Error(message);};
const digest=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const sourceUrl='https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
function evidenceFile(base,path,hash) {
 need(typeof path==='string' && path.split('/').every(p=>p && p!=='.' && p!=='..') && !path.includes('\\'),'unsafe evidence path');
 const owner=realpathSync(base),target=realpathSync(join(base,path)),rel=relative(owner,target);
 need(rel && rel!=='..' && !rel.startsWith('../') && !rel.startsWith('/'),'evidence escapes owner');
 const bytes=readFileSync(target);need(bytes.length && digest(hash) && sha256(bytes)===hash,'evidence hash mismatch: '+path);return bytes;
}

export function inspectStock(candidate,manifest,stockDir,{asOf,boards,models}) {
 const receipt=json(join(stockDir,'stock.json'));
 need(receipt.schema_version===1 && receipt.board===manifest.board && receipt.candidate_sha256===sha256(readFileSync(join(candidate,'release-manifest.json'))),'stock receipt belongs to another candidate');
 need(receipt.source_url===sourceUrl && receipt.order_day_utc===asOf && receipt.boards===boards,'stock source/order day/quantity differs from requested review');
 need(receipt.parts && Object.keys(receipt.parts).length,'stock contains no parts');
 const expected=new Map();
 for(const population of Object.values(manifest.assembly.populations))for(const code of new Set(Object.values(population.references))) {
  const refs=Object.entries(population.references).filter(([,c])=>c===code).map(([r])=>r).sort();
  expected.set(code,Math.max(expected.get(code)??0,refs.length*boards));
 }
 need(Object.keys(receipt.parts).length===expected.size,'stock does not cover exact candidate codes');
 for(const [code,quantity] of expected) {
  const p=receipt.parts[code];need(p && p.required===quantity && p.fetched_at_utc?.slice(0,10)===asOf && Number.isFinite(Date.parse(p.fetched_at_utc)),'stock code/quantity/freshness missing: '+code);
  const response=JSON.parse(evidenceFile(stockDir,p.response,p.response_sha256));
  const rows=response.data?.componentPageInfo?.list;
  need(Array.isArray(rows),'invalid original JLC stock response: '+code);
  const matches=rows.filter(r=>r.componentCode===code);need(matches.length===1,'JLC response lacks one exact code: '+code);
  const row=matches[0];need(typeof row.componentModelEn==='string' && row.componentModelEn && Number.isSafeInteger(row.stockCount) && row.stockCount>=quantity,'insufficient/unverified assembly stock: '+code);
  if(models)need(models[code]===row.componentModelEn,'current catalog MPN differs from selected BOM: '+code);
 }
 return {status:'passed',source_url:sourceUrl,order_day_utc:asOf,boards,codes:expected.size,
  receipt_sha256:sha256(readFileSync(join(stockDir,'stock.json'))),scope:'Each population checked independently; mixed-population totals and stock reservation are not established.'};
}

export function inspectCompleteAssembly(root,entry,candidate,manifest,stockDir,{asOf,boards}) {
 const revision=owningBomRevision(entry,entry.bom_policy==='per-revision'?manifest.revision:undefined);
 const scope=json(join(root,'hardware-design/boards',entry.directory,revision.bom_scope));
 const requirements=scope.assembly?.requirements;
 need(Array.isArray(requirements),'reviewed complete assembly scope missing');
 if(!requirements.length)return {status:'passed',items:0,scope:'Reviewed explicit assembly scope declares no off-board items.'};
 need(stockDir,'fresh complete-assembly availability review required in STOCK_DIR/assembly.json');
 const receipt=json(join(stockDir,'assembly.json'));
 need(receipt.schema_version===1 && receipt.board===manifest.board && receipt.candidate_sha256===sha256(readFileSync(join(candidate,'release-manifest.json'))) &&
  receipt.order_day_utc===asOf && receipt.boards===boards && typeof receipt.reviewer==='string' && receipt.reviewer.trim(),'complete-assembly stock candidate/day/quantity/reviewer mismatch');
 need(Array.isArray(receipt.items) && receipt.items.length===requirements.length,'complete-assembly stock must cover every required mate/contact/harness/battery');
 const seen=new Set();
 for(const item of receipt.items) {
  const required=requirements.find(p=>p.reference===item.reference);
  need(required && !seen.has(item.reference) && item.mpn===required.mpn && item.lcsc===required.lcsc &&
   Number.isSafeInteger(item.available_quantity) && item.available_quantity>=required.quantity*boards &&
   item.observed_at_utc?.slice(0,10)===asOf && Number.isFinite(Date.parse(item.observed_at_utc)) && /^https:\/\//.test(item.source_url??''), 'complete-assembly identity/availability/freshness missing: '+item.reference);
  evidenceFile(stockDir,item.evidence,item.evidence_sha256);seen.add(item.reference);
 }
 return {status:'passed',items:seen.size,reviewer:receipt.reviewer,receipt_sha256:sha256(readFileSync(join(stockDir,'assembly.json'))),scope:'Attributed supplier-availability review; quantities are not reserved.'};
}

export function inspectOrientation(candidate,manifest,path) {
 const review=json(path),base=resolve(path,'..');
 need(review.schema_version===1 && review.board===manifest.board && review.revision===manifest.revision &&
  review.candidate_sha256===sha256(readFileSync(join(candidate,'release-manifest.json'))),'assembly orientation review belongs to another candidate/revision');
 need(typeof review.reviewer==='string' && review.reviewer.trim() && Number.isFinite(Date.parse(review.reviewed_at_utc)),'assembly reviewer/time missing');
 const expected=Object.entries(manifest.assembly.populations).flatMap(([population,p])=>Object.entries(p.references).map(([reference,lcsc])=>({population,reference,lcsc})));
 need(Array.isArray(review.placements) && review.placements.length===expected.length,'assembly review must cover every fitted population reference');
 const seen=new Set();
 for(const p of review.placements) {
  const key=p.population+'/'+p.reference;
  need(!seen.has(key) && p.orientation_verified===true && expected.some(e=>e.population===p.population && e.reference===p.reference && e.lcsc===p.lcsc),'unknown, duplicate or unreviewed assembly orientation: '+key);
  evidenceFile(base,p.evidence,p.evidence_sha256);seen.add(key);
 }
 return {status:'passed',reviewer:review.reviewer,reviewed_at_utc:review.reviewed_at_utc,placements:seen.size,review_sha256:sha256(readFileSync(path))};
}

export async function releaseReadiness(root,board,candidate,{stock,orientation,asOf=new Date().toISOString().slice(0,10),boards=1,environment={},externalRoots={}}={}) {
 need(releaseRecipe(root,board),'unsupported board');need(/^\d{4}-\d{2}-\d{2}$/.test(asOf) && Number.isFinite(Date.parse(asOf)) && new Date(asOf).toISOString().slice(0,10)===asOf,'invalid order day');
 need(Number.isSafeInteger(boards) && boards>0,'boards must be a positive integer');
 const findings=[],checks={},inputs={};
 const check=async(name,fn)=>{try{checks[name]=await fn();}catch(error){checks[name]={status:'blocked',cause:error.message};findings.push({check:name,cause:error.message});}};
 let manifest,selectedModels;
 await check('cad_fabrication',()=>{
  manifest=json(join(candidate,'release-manifest.json'));
  need(manifest.schema_version===1 && manifest.board===board && manifest.scope==='cad_fabrication_candidate' && manifest.input_sha256 && manifest.g5_ready===false && manifest.g6_qualified===false,'invalid candidate manifest');
  const actual=fileHashes(candidate);
  for(const [path,hash] of Object.entries(manifest.artifacts??{}))need(actual[path]===hash,'candidate artifact missing or changed: '+path);
  need(Object.keys(manifest.artifacts??{}).length>0 && actual['fab/VERIFIED'],'candidate artifact evidence absent');
  const gate=verifyReleaseGate(root,board,join(candidate,'gate'),environment,externalRoots);
  need(gate.token===manifest.gate_token && gate.input_sha256===manifest.input_sha256,'candidate gate evidence changed');
  const fresh=verifyFab(root,board,join(candidate,'fab'));
  need(JSON.stringify(fresh)===JSON.stringify(manifest.assembly),'native source/assembly population changed since export');
  need(JSON.stringify(verifyBoardChecks(board,candidate,root))===JSON.stringify(manifest.board_checks),'board-specific semantic evidence missing or changed');
  return {status:'passed',input_sha256:manifest.input_sha256,candidate_sha256:sha256(readFileSync(join(candidate,'release-manifest.json')))};
 });
 const registry=loadBoardRegistry(root),entry=registry.boards.find(e=>e.id===board);
 await check('packet',()=>{
  need(entry,'board registry entry missing');
  const packet=inspectPackets(root,registry),findings=packet.findings.filter(f=>f.board===board);
  for(const p of FULL_PACKET) {const path=join(root,'hardware-design/boards',entry.directory,p);if(existsSync(path))inputs[relative(root,path)]=sha256(readFileSync(path));}
  need(!findings.length,findings.map(f=>f.check+': '+f.detail).join('; '));return {status:'passed',files:Object.keys(inputs).length,scope:'Structural packet and exact BOM/complete-assembly coverage; engineering conclusions still require review.'};
 });
 await check('selected_bom',async()=>{
  need(entry,'board registry entry missing');
  const revision=entry.revisions.find(r=>r.gate===board);need(revision && revision.revision===manifest?.revision,'candidate revision registry ownership mismatch');
  const bom=revision.bom??'BOM-VERIFIED.csv',path=join(root,'hardware-design/boards',entry.directory,bom),csv=readFileSync(path,'utf8'),rows=parseCsv(csv);
  need(rows.length>1,'verified BOM has no component rows');
  const ledger=await loadBoardSelection(root,entry,csv,rows,entry.bom_policy==='per-revision'?revision.revision:undefined);
  need(ledger && ledger.revision===revision.revision,'attributable selected BOM ledger missing or belongs to another revision');
  selectedModels=Object.fromEntries([...ledger.parts].map(([code,p])=>[code,p.mpn]));
  inputs[relative(root,path)]=sha256(csv);return {status:'passed',revision:ledger.revision,references:ledger.references.size,scope:'Historical electrical selection; current stock is checked separately.'};
 });
 await check('assembly_stock',()=>{need(stock,'fresh order-day JLC assembly stock receipt required (--stock DIR)');need(checks.cad_fabrication.status==='passed' && selectedModels,'valid fabrication candidate and selected BOM required');return inspectStock(candidate,manifest,stock,{asOf,boards,models:selectedModels});});
 await check('complete_assembly_stock',()=>{need(entry && checks.packet.status==='passed' && checks.cad_fabrication.status==='passed','valid packet and fabrication candidate required');return inspectCompleteAssembly(root,entry,candidate,manifest,stock,{asOf,boards});});
 await check('supplier_orientation',()=>{need(orientation,'attributable supplier package orientation review required (--orientation FILE)');need(checks.cad_fabrication.status==='passed','valid fabrication candidate required');return inspectOrientation(candidate,manifest,orientation);});
 await check('open_defect',()=>{const hash=sha256(readFileSync(join(candidate,'release-manifest.json')));need(!openDefects(root,board).has(hash),`release ${hash} has an open defect. End it: tools/pcb change ${board} --kind defect_closed --refs ${hash},DECISION --reason TEXT --by NAME`);return {status:'passed'};});
 return {schema_version:1,board,revision:manifest?.revision??null,status:findings.length?'blocked':'ready_for_user_review',
  scope:'order_preparation',order_day_utc:asOf,boards,checks,findings,inputs,...g5Decision(root,board,candidate,findings),g6_qualified:false,ordered:false,
  limits:['Readiness is evidence for user review; it does not approve, order, reserve stock, assemble or establish measured qualification.']};
}
