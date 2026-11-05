import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {inspectBomCoverage} from './bom-coverage.mjs';
import {parseCsv} from './csv.mjs';
import {revisionBoms} from './bom-ownership.mjs';
import {ownedFile} from './kicad-population.mjs';
export {parseCsv} from './csv.mjs';

export const FULL_PACKET=['README.md','STATUS.md','SPEC.md','BOM-VERIFIED.csv','SCHEMATIC.md','DATASHEETS.md','POWER-AND-IC-ANALYSIS.md','MECHANICAL.md','JLC-SUBMISSION.md','BRINGUP-TEST-PLAN.md','DOC-RECONCILIATION.md','reports/README.md','handoff/README.md'];

export function inspectPackets(root,registry) {
 const findings=[];const checked=[];
 const fail=(board,check,detail)=>findings.push({level:'alert',board,check,detail});
 if(registry.schema_version!==1 || !Array.isArray(registry.boards)) throw new Error('invalid board registry schema');
 const base=join(root,'hardware-design/boards');const entries=new Map();
 for(const e of registry.boards) {
  if(!e.id || entries.has(e.id)) throw new Error(`missing or duplicate board ID: ${e.id}`);
  if(!['active','planned','historical','obsolete'].includes(e.lifecycle) || !['board','variant','gate-only'].includes(e.kind)) throw new Error(`invalid classification: ${e.id}`);
  if(e.directory && (relative(base,resolve(base,e.directory)).startsWith('..') || e.directory.includes('/'))) throw new Error(`unsafe board directory: ${e.id}`);
  if('pending_gate' in e && (e.pending_gate!=='gate.pending.json' || !e.directory || !['board','gate-only'].includes(e.kind) || e.lifecycle==='active')) fail(e.id,'pending_gate','pending_gate requires a non-active board or gate-only directory and gate.pending.json');
  entries.set(e.id,e);
 }
 const directories=new Set(registry.boards.map(e=>e.directory).filter(Boolean));
 for(const d of readdirSync(base,{withFileTypes:true})) if(d.isDirectory() && !d.name.startsWith('.') && !(registry.excluded_directories??[]).includes(d.name) && !directories.has(d.name)) fail(d.name,'unregistered_board',`${d.name} has no explicit lifecycle/packet classification`);
 for(const e of registry.boards) {
  if(e.kind==='gate-only') {
   const owner=entries.get(e.owner);const rev=owner?.revisions?.find(r=>r.revision===e.revision);
   const pending=e.pending_gate==='gate.pending.json';
   if(owner?.kind!=='board' || !rev || (pending?!!rev.gate:rev.gate!==e.id)) fail(e.id,'gate_owner',pending?'pending gate-only entry must resolve to an owner revision with no active gate':'gate-only entry must resolve to an owner revision');
   const name=pending?'gate.pending.json':'gate.json';
   if(pending && existsSync(join(base,e.directory,'gate.json'))) fail(e.id,'pending_gate','pending_gate cannot register an active gate.json');
   if(!existsSync(join(base,e.directory,name))) fail(e.id,'gate_config',`missing ${name}`);
   else if(pending) {
    try {
     const cfg=JSON.parse(ownedFile(root,`hardware-design/boards/${e.directory}/${name}`,`hardware-design/boards/${e.directory}`).toString());
     if(!cfg || !['G3','G4','G5'].includes(cfg.stage)) fail(e.id,'pending_gate','pending gate requires an explicit supported stage');
     if(!rev?.project || typeof cfg?.project!=='string' || resolve(base,e.directory,cfg.project)!==resolve(base,owner.directory,rev.project)) fail(e.id,'revision_gate','pending gate points to a different owner revision project');
    } catch(error){fail(e.id,'pending_gate',error.message);}
   }
   checked.push({id:e.id,kind:e.kind,owner:e.owner,revision:e.revision,...(pending?{gate_state:'pending'}:{})});continue;
  }
  if(e.pending_gate==='gate.pending.json') {
   if(existsSync(join(base,e.directory,'gate.json'))) fail(e.id,'pending_gate','pending_gate cannot register an active gate.json');
   try {
    const cfg=JSON.parse(ownedFile(root,`hardware-design/boards/${e.directory}/${e.pending_gate}`,`hardware-design/boards/${e.directory}`).toString());
    if(!cfg || !['G3','G4','G5'].includes(cfg.stage)) fail(e.id,'pending_gate','pending gate requires an explicit supported stage');
    if(!e.revisions?.some(r=>!r.gate && r.project && typeof cfg.project==='string' && resolve(base,e.directory,cfg.project)===resolve(base,e.directory,r.project))) fail(e.id,'revision_gate','pending gate must resolve to a revision with no active gate');
   } catch(error){fail(e.id,'pending_gate',error.message);}
  }
  if(e.kind==='variant' || e.variant_of) {
   if(!entries.has(e.variant_of) || entries.get(e.variant_of).kind!=='board') fail(e.id,'variant_owner','variant must resolve to a physical board');
   if(e.source && !existsSync(join(base,e.source))) fail(e.id,'variant_source',`missing ${e.source}`);
   if(!e.directory){checked.push({id:e.id,kind:e.kind,lifecycle:e.lifecycle});continue;}
  }
  const dir=join(base,e.directory);
  if(!Array.isArray(e.revisions) || !e.revisions.length) fail(e.id,'revisions','board requires explicit revisions');
  for(const r of e.revisions??[]) {
   if(!r.revision || !r.state || !r.spec || !existsSync(join(dir,r.spec))) fail(e.id,'revision_spec',`missing revision/spec for ${r.revision}`);
   if(r.gate) {
    const gateFile=join(base,r.gate,'gate.json');
    if(!existsSync(gateFile)) fail(e.id,'revision_gate',`missing ${r.gate}/gate.json`);
    else {
     const cfg=JSON.parse(readFileSync(gateFile,'utf8'));
     if(resolve(base,r.gate,cfg.project)!==resolve(dir,r.project??'')) fail(e.id,'revision_gate',`gate ${r.gate} points to a different revision project`);
    }
   }
  }
  if(e.lifecycle==='active' && e.packet!=='full') fail(e.id,'packet_profile','active physical boards require a full packet');
  let boms=[];
  if(e.lifecycle==='active')try {boms=revisionBoms(e);}catch(error){fail(e.id,'bom_ownership',error.message);}
  const required=e.lifecycle==='active'?(e.bom_policy==='per-revision'?FULL_PACKET.filter(p=>p!=='BOM-VERIFIED.csv'):FULL_PACKET):['SPEC.md'];
  for(const file of required) {
   const p=join(dir,file);
   if(!existsSync(p) || !readFileSync(p,'utf8').trim()) fail(e.id,'packet_file',`missing or empty ${e.directory}/${file}`);
  }
  if(e.lifecycle==='active') {
   for(const bom of boms) {
   const p=join(dir,bom.bom),label=bom.revision?`${bom.bom} (revision ${bom.revision})`:bom.bom;
   if(!existsSync(p) && e.bom_policy==='per-revision')fail(e.id,'packet_file',`missing or empty ${e.directory}/${label}`);
   if(existsSync(p)) {
    try {
     const csv=e.bom_policy==='per-revision'?ownedFile(root,`hardware-design/boards/${e.directory}/${bom.bom}`,`hardware-design/boards/${e.directory}`).toString():readFileSync(p,'utf8');
     const rows=parseCsv(csv);
     if(rows[0]?.slice(0,4).join(',')!=='Designator,Function block,MPN/value,LCSC') fail(e.id,'bom_header',`invalid ${label} header`);
     if(rows.length<2) fail(e.id,'bom_empty',`${label} has no component rows; verification is not established`);
     for(const [i,r] of rows.slice(1).entries()) {
      if(r.length!==rows[0].length) fail(e.id,'bom_row',`BOM row ${i+2} has inconsistent column count`);
      if(r[3] && !/^C\d+$/.test(r[3].trim())) fail(e.id,'bom_identity',`BOM row ${i+2} has invalid LCSC ID`);
     }
     if(rows.length>1) {
      try {inspectBomCoverage(root,e,csv,rows,bom.revision);}
      catch(error) {fail(e.id,'bom_coverage',`${label}: ${error.message}`);}
     }
    } catch(error){fail(e.id,'bom_csv',error.message);}
   }
   }
  }
  if(e.variants) {
   const p=join(dir,e.variants.file);
   if(!existsSync(p)) fail(e.id,'variants','missing BOM variant fit map');
   else {
    const v=JSON.parse(readFileSync(p,'utf8'));const names=new Set(e.variants.names);
    if(!Array.isArray(v.variants) || new Set(v.variants).size!==names.size || v.variants.some(n=>!names.has(n))) fail(e.id,'variants','variant names disagree with registry');
    if(!v.fit || typeof v.fit!=='object' || Array.isArray(v.fit) || !Object.keys(v.fit).length) fail(e.id,'variants','missing variant designator fit map');
    else for(const [ref,fit] of Object.entries(v.fit)) if(!Array.isArray(fit) || fit.some(n=>!names.has(n))) fail(e.id,'variants',`invalid fit list for ${ref}`);
   }
  }
  checked.push({id:e.id,lifecycle:e.lifecycle,kind:e.kind,revisions:e.revisions?.map(r=>r.revision),required_files:required.length});
 }
 return {ok:!findings.length,checked,findings};
}

export function loadBoardRegistry(root) {
 return JSON.parse(readFileSync(join(root,'hardware-design/registry/boards.json'),'utf8'));
}
