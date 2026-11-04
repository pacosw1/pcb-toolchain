// File ownership is independent of selected state or engineering sufficiency.
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const relativeFile=(value,extension)=>typeof value==='string' && value.endsWith(extension) &&
 value.split('/').every(x=>x && x!=='.' && x!=='..') && !value.includes('\\');
export function revisionBoms(entry) {
 need(entry.bom_policy===undefined || entry.bom_policy==='per-revision','unsupported board BOM ownership policy');
 if(entry.bom_policy===undefined)return [{revision:null,bom:'BOM-VERIFIED.csv',selection:'BOM-VERIFIED.selection.json'}];
 need(Array.isArray(entry.revisions) && entry.revisions.length>0,'revision BOM ownership missing revisions');
 const seen=new Set(),paths=new Set();
 return entry.revisions.map(r=>{
  need(typeof r.revision==='string' && r.revision && !seen.has(r.revision),'duplicate/missing BOM revision');seen.add(r.revision);
  for(const [field,extension] of [['bom','.csv'],['bom_scope','.json'],['selection','.json']]) {
   need(relativeFile(r[field],extension),`revision ${r.revision} requires safe ${field} path`);
   need(!paths.has(r[field]),'revision BOM records have ambiguous shared file ownership');paths.add(r[field]);
  }
  need(/(^|\/)BOM-VERIFIED(?:-[A-Za-z0-9_-]+)?\.csv$/.test(r.bom),'selected revision BOM must be named BOM-VERIFIED');
  need(typeof r.project==='string' && r.project && typeof r.spec==='string' && r.spec,'revision BOM requires native project/spec ownership');
  return {revision:r.revision,bom:r.bom,selection:r.selection,scope:r.bom_scope};
 });
}
export function owningBomRevision(entry,revisionName) {
 if(entry.bom_policy==='per-revision') {
  revisionBoms(entry);
  need(typeof revisionName==='string','per-revision BOM requires explicit revision selector');
  const revision=entry.revisions.find(r=>r.revision===revisionName);
  need(revision,'unknown BOM revision selector');return revision;
 }
 need(revisionName===undefined || revisionName===null,'legacy BOM cannot use revision selector');
 const owners=entry.revisions.filter(r=>r.bom==='BOM-VERIFIED.csv' && r.bom_scope);
 need(owners.length===1,'BOM coverage requires one explicitly owning revision/project/scope');return owners[0];
}
