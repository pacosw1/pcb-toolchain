import {sha256,requireValue as need,ownedFile,readPopulation} from './kicad-population.mjs';
import {parseCsv} from './csv.mjs';

const digest=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const object=x=>x && typeof x==='object' && !Array.isArray(x);
const text=x=>typeof x==='string' && x.trim()===x && x.length>0;
function exactKeys(value,keys,message) {
 need(object(value) && Object.keys(value).every(k=>keys.includes(k)),message);
}
function sameSet(a,b,message) {
 need(Array.isArray(a) && new Set(a).size===a.length && a.length===b.length && a.every(v=>b.includes(v)),message);
}
function names(a,allowed,message) {
 need(Array.isArray(a) && a.length>0 && new Set(a).size===a.length && a.every(x=>allowed.includes(x)),message);
}

// Structural completeness is independent of electrical selection. Review hashes
// attribute human requirements; this cannot infer mating parts from ref prefixes
// or prove the engineering conclusions in a review.
export function inspectBomCoverage(root,entry,csv,rows) {
 const board=entry.directory,prefix=`hardware-design/boards/${board}`;
 const owners=entry.revisions.filter(r=>r.bom==='BOM-VERIFIED.csv' && r.bom_scope);
 need(owners.length===1,'BOM coverage requires one explicitly owning revision/project/scope');
 const revision=owners[0];
 need(entry.revisions.filter(r=>r.bom===revision.bom || r.bom_scope===revision.bom_scope).length===1,'ambiguous BOM coverage revision ownership');
 need(text(revision.project) && !revision.project.includes('..') && !revision.project.startsWith('/'),'BOM coverage native project missing/unsafe');
 const path=`${prefix}/${revision.bom_scope}`;
 const scope=JSON.parse(ownedFile(root,path,prefix));
 exactKeys(scope,['schema_version','board','revision','revision_spec','spec_sha256','project','bom','bom_sha256',
  'source_hashes','review_evidence','classification','native_population','assembly','instance_project_names'],'unsupported BOM coverage field');
 need(scope.schema_version===1 && scope.board===board && scope.revision===revision.revision,'BOM coverage board/revision/schema mismatch');
 const spec=`${prefix}/${revision.spec}`,project=`${prefix}/${revision.project}`;
 need(scope.revision_spec===spec && digest(scope.spec_sha256) && sha256(ownedFile(root,spec,prefix))===scope.spec_sha256,'BOM coverage spec identity/hash mismatch');
 need(scope.project===project && scope.bom===`${prefix}/BOM-VERIFIED.csv` &&
  digest(scope.bom_sha256) && sha256(csv)===scope.bom_sha256,'BOM coverage project/BOM identity/hash mismatch');
 need(object(scope.review_evidence) && Object.keys(scope.review_evidence).length>0,'BOM coverage attributable reviews missing');
 for(const [p,h] of Object.entries(scope.review_evidence)) {
  need(p.endsWith('.md') && digest(h),'invalid BOM coverage review attribution');
  const content=ownedFile(root,p,prefix);need(content.toString().trim() && sha256(content)===h,'BOM coverage review hash mismatch');
 }
 const reviewed=x=>need(text(x) && x!==spec && digest(scope.review_evidence[x]),'BOM coverage scoped review missing');
 const native=readPopulation(root,project,scope.instance_project_names);let populations=['DEFAULT'],fit=null;
 if(entry.variants) {
  const file=`${prefix}/${entry.variants.file}`,raw=ownedFile(root,file,prefix),v=JSON.parse(raw);
  sameSet(v.variants,entry.variants.names,'BOM coverage variant names mismatch');
  need(v.variants.length && object(v.fit),'BOM coverage variant fit map missing');
  populations=v.variants;fit=v.fit;native.sources[file]=sha256(raw);
  const physical=[...native.symbols].filter(([,p])=>p.on_board && p.footprint).map(([ref])=>ref);
  sameSet(Object.keys(fit),physical,'BOM coverage variant map does not cover complete native population');
  for(const [ref,pops] of Object.entries(fit)) need(Array.isArray(pops) && new Set(pops).size===pops.length && pops.every(p=>populations.includes(p)),`invalid variant fit for ${ref}`);
  if(v.dnp!==undefined) sameSet(v.dnp,physical.filter(ref=>!fit[ref].length),'variant DNP list differs from empty fit lists');
 }
 need(populations.includes(scope.native_population),'BOM coverage native population missing/unknown');
 need(object(scope.source_hashes),'BOM coverage native source hashes missing');
 sameSet(Object.keys(scope.source_hashes),Object.keys(native.sources),'BOM coverage native source closure mismatch');
 for(const [p,h] of Object.entries(native.sources)) need(scope.source_hashes[p]===h,`BOM coverage native source hash mismatch: ${p}`);
 need(object(scope.classification),'BOM coverage explicit population classification missing');
 const refs=[...new Set([...native.symbols.keys(),...native.footprints.keys()])];
 sameSet(Object.keys(scope.classification),refs,'BOM coverage classification does not cover complete native references');
 const expected=new Map();
 for(const ref of refs) {
  const sch=native.symbols.get(ref),pcb=native.footprints.get(ref),c=scope.classification[ref];
  exactKeys(c,['kind','reason','review','assembly_dependencies'],'unsupported BOM coverage classification');
  need(text(c.reason),`BOM coverage classification reason missing: ${ref}`);reviewed(c.review);
  need(Array.isArray(c.assembly_dependencies) && new Set(c.assembly_dependencies).size===c.assembly_dependencies.length &&
   c.assembly_dependencies.every(text),`invalid assembly dependencies: ${ref}`);
  if(sch && sch.on_board && sch.footprint) {
   need(pcb,`native fitted/physical reference missing from PCB: ${ref}`);
   if(native.rootPropertyOrigins.has(ref))
    need([...native.rootPropertyOrigins.get(ref)].some(uuid=>pcb.path==='/'+uuid),`root property reference lacks matching PCB placed-unit source path: ${ref}`);
   need(sch.mpn===pcb.mpn && sch.lcsc===pcb.lcsc,`native schematic/PCB identity differs: ${ref}`);
   need(sch.footprint===pcb.footprint,`native schematic/PCB land identity differs: ${ref}`);
   need(sch.dnp===pcb.dnp,`native schematic/PCB DNP differs: ${ref}`);
  } else if(sch) need(!pcb,`nonphysical/off-board schematic reference appears on PCB: ${ref}`);
  const pops=sch && sch.on_board && sch.footprint ? (fit?fit[ref]:(sch.dnp?[]:['DEFAULT'])):[];
  if(sch && sch.on_board && sch.footprint && fit)
   need(sch.dnp===!pops.includes(scope.native_population),`native DNP differs from declared native population: ${ref}`);
  if(c.kind==='component') {
   need(sch && pcb && sch.in_bom && sch.on_board && sch.footprint && pops.length && !pcb.excluded && !pcb.board_only,`component classification is not fitted or PCB flags disagree: ${ref}`);
   need(/^C\d+$/.test(sch.lcsc) && text(sch.mpn),`native fitted exact MPN/LCSC missing: ${ref}`);
   expected.set(ref,{...sch,populations:pops,quantity:1});
  } else {
   need(c.assembly_dependencies.length===0,`non-fitted reference has assembly dependencies: ${ref}`);
   if(c.kind==='dnp') need(sch && pcb && !pops.length && sch.dnp,`DNP classification lacks native/variant evidence: ${ref}`);
   else if(c.kind==='excluded') need((sch && !sch.in_bom) || (!sch && pcb?.excluded && pcb?.board_only),`exclusion lacks native BOM/board-only evidence: ${ref}`);
   else if(c.kind==='fabrication-feature') need(pcb && pcb.excluded && pcb.board_only && !pcb.mpn && !pcb.lcsc && (!sch || (!sch.in_bom && !sch.mpn && !sch.lcsc)),`fabrication feature lacks native exclusion/board-only evidence: ${ref}`);
   else if(c.kind==='nonphysical') need(sch && !sch.footprint && !sch.in_bom && !pcb,`nonphysical classification lacks native evidence: ${ref}`);
   else need(false,`unknown BOM coverage classification: ${ref}`);
  }
 }
 exactKeys(scope.assembly,['review','basis','bom','bom_sha256','requirements'],'invalid/missing required assembly scope');
 reviewed(scope.assembly.review);need(text(scope.assembly.basis) && Array.isArray(scope.assembly.requirements),'required assembly scope is not explicit');
 need(scope.assembly.bom!==scope.bom && scope.assembly.bom?.endsWith('.csv') && digest(scope.assembly.bom_sha256),'required assembly BOM missing');
 const assemblyCsv=ownedFile(root,scope.assembly.bom,prefix);
 need(sha256(assemblyCsv)===scope.assembly.bom_sha256,'required assembly BOM hash mismatch');
 const items=new Map();
 for(const item of scope.assembly.requirements) {
  exactKeys(item,['reference','kind','mpn','lcsc','quantity','populations','for_references','review','definition','definition_sha256'],'unsupported assembly requirement field');
  need(text(item.reference) && !refs.includes(item.reference) && !items.has(item.reference),'duplicate/invalid assembly requirement reference');
  need(['mate','contact','harness','battery','other'].includes(item.kind) && text(item.mpn) &&
   Number.isSafeInteger(item.quantity) && item.quantity>0,'assembly requirement exact identity/quantity missing');
  if(item.definition!==undefined) {
   need(item.lcsc==='' && item.definition.endsWith('.json') && digest(item.definition_sha256),'invalid noncatalog assembly definition');
   const raw=ownedFile(root,item.definition,prefix),def=JSON.parse(raw);
   need(sha256(raw)===item.definition_sha256 && def.schema_version===1 && def.reference===item.reference && def.mpn===item.mpn &&
    Array.isArray(def.materials) && def.materials.length>0,'assembly definition identity/materials/hash missing');
   for(const material of def.materials) need(text(material.mpn) && Number.isSafeInteger(material.quantity) && material.quantity>0,
    'assembly definition material identity/quantity missing');
  } else need(/^C\d+$/.test(item.lcsc) && item.definition_sha256===undefined,'assembly catalog identity missing');
  names(item.populations,populations,'assembly requirement populations missing/invalid');
  need(Array.isArray(item.for_references) && item.for_references.length && new Set(item.for_references).size===item.for_references.length &&
   item.for_references.every(ref=>expected.has(ref)),'assembly requirement has unknown/nonfitted native owner');reviewed(item.review);
  for(const ref of item.for_references) {
   need(scope.classification[ref].assembly_dependencies.includes(item.reference),`required assembly item not declared by native owner: ${ref}`);
   sameSet(item.populations,expected.get(ref).populations,`assembly requirement must cover every native owner population: ${ref}`);
  }
  items.set(item.reference,item);
 }
 for(const [ref,c] of Object.entries(scope.classification)) for(const dep of c.assembly_dependencies)
  need(items.get(dep)?.for_references.includes(ref),`native assembly dependency missing from required scope: ${ref}/${dep}`);
 function checkRows(records,required,assembly=false) {
  const headers=records[0]??[],qty=headers.indexOf('Quantity'),pop=headers.indexOf('Population');
  need(headers.slice(0,4).join(',')==='Designator,Function block,MPN/value,LCSC','BOM coverage invalid CSV header');
  need(headers.every(text) && new Set(headers).size===headers.length,'BOM coverage CSV headers must be nonempty and unique');
  need((!assembly || qty>=0) && headers.filter(x=>x==='Quantity').length<=1,'assembly BOM requires explicit unique Quantity column');
  need(!entry.variants || (pop>=0 && headers.filter(x=>x==='Population').length===1),'variant BOM coverage requires Population column');
  const seen=new Set();
  for(const row of records.slice(1)) {
   need(row.length===headers.length,'BOM coverage inconsistent CSV column count');
   const ref=row[0]?.trim(),part=required.get(ref);
   need(part && !seen.has(ref),`BOM coverage extra/duplicate/non-fitted reference: ${ref}`);seen.add(ref);
   need(row[2]?.trim()===part.mpn && row[3]?.trim()===part.lcsc,`BOM coverage exact MPN/LCSC mismatch: ${ref}`);
   if(qty>=0) need(/^\d+$/.test(row[qty]?.trim()??'') && Number(row[qty])===part.quantity,`BOM coverage quantity mismatch: ${ref}`);
   const rowPops=pop>=0?row[pop].trim().split(';'):['DEFAULT'];sameSet(rowPops,part.populations,`BOM coverage population mismatch: ${ref}`);
  }
  const missing=[...required.keys()].filter(ref=>!seen.has(ref));need(!missing.length,`BOM coverage missing required references: ${missing.join(', ')}`);
 }
 checkRows(rows,expected);checkRows(parseCsv(assemblyCsv.toString()),items,true);
 return {revision:revision.revision,manifest:path,native_references:native.symbols.size,required_references:expected.size,
  required_assembly_items:items.size,populations};
}
