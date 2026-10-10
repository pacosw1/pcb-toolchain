import {readFileSync,realpathSync,statSync} from 'node:fs';
import {resolve,relative,dirname,basename,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function requireValue(ok,message) {if(!ok) throw new Error(message);}
// Native Node reader follows pq_cadlib.parse's list/string representation. It
// adds strict token consumption and bounds; packet checks need no Python/KiCad.
export function parseNative(text) {
 requireValue(text.length<=50*1024*1024,'native file exceeds parser bound');
 const token=/\s*(\(|\)|"(?:\\.|[^"\\])*"|[^\s()"]+)/gy;
 const stack=[];let root=null,pos=0,count=0;
 while(pos<text.length) {
  token.lastIndex=pos;const m=token.exec(text);
  if(!m && !text.slice(pos).trim()) break;
  requireValue(m && m.index===pos,'invalid native token');pos=token.lastIndex;
  const t=m[1];requireValue(++count<=2000000,'native token bound exceeded');
  if(t==='(') {
   const node=[];if(stack.length) stack.at(-1).push(node);
   else {requireValue(root===null,'multiple native roots');root=node;}
   stack.push(node);requireValue(stack.length<=256,'native nesting bound exceeded');
  } else if(t===')') {requireValue(stack.length>0,'unbalanced native close');stack.pop();}
  else {requireValue(stack.length>0,'native atom outside root');stack.at(-1).push(t.startsWith('"')?JSON.parse(t):t);}
 }
 requireValue(root && !stack.length,'unbalanced/empty native expression');return root;
}
export const children=(n,name)=>n.slice(1).filter(x=>Array.isArray(x)&&x[0]===name);
export function single(n,name) {const a=children(n,name);requireValue(a.length<=1,`duplicate native ${name}`);return a[0];}
export function properties(n) {
 const result={};for(const p of children(n,'property')) {
  requireValue(p.length>=3 && !(p[1] in result),'duplicate/malformed native property');result[p[1]]=p[2];
 }return result;
}
export function ownedFile(root,path,owner) {
 requireValue(typeof path==='string' && !isAbsolute(path) && !path.includes('\\') &&
  path.split('/').every(p=>p && p!=='.' && p!=='..') && path.startsWith(owner+'/'),'unsafe coverage source path');
 const base=realpathSync(resolve(root,owner)),repo=realpathSync(root),target=realpathSync(resolve(root,path));
 const baseRel=relative(repo,base),rel=relative(base,target);
 requireValue(baseRel && !baseRel.startsWith('..') && !isAbsolute(baseRel) && rel && !rel.startsWith('..') && !isAbsolute(rel),
  'coverage source escapes owner');
 requireValue(statSync(target).size<=50*1024*1024,'coverage source exceeds file bound');return readFileSync(target);
}
function identity(p) {
 const codes=['LCSC','LCSC Part','LCSC Part #'].filter(k=>p[k]).map(k=>p[k].trim());
 requireValue(new Set(codes).size<=1,'conflicting native LCSC fields');return {lcsc:codes[0]??'',mpn:(p.MPN??'').trim()};
}
function flag(n,name) {
 const value=single(n,name)?.[1];requireValue(['yes','no'].includes(value),`missing/invalid native ${name}`);return value==='yes';
}
function embeddedPowerResolver(tree) {
 const libraries=single(tree,'lib_symbols'),byId=new Map(),memo=new Map();
 for(const n of libraries?children(libraries,'symbol'):[]) {
  requireValue(typeof n[1]==='string' && n[1] && !byId.has(n[1]),'duplicate/malformed embedded library symbol');
  byId.set(n[1],n);
 }
 return function resolvePower(id,visiting=new Set()) {
  if(memo.has(id))return memo.get(id);
  const n=byId.get(id);if(!n)return {power:false,physical:false};
  requireValue(!visiting.has(id),'cyclic embedded symbol inheritance');
  requireValue(visiting.size<64,'embedded symbol inheritance bound exceeded');
  const next=new Set(visiting);next.add(id);
  const marker=single(n,'power'),extendsNode=single(n,'extends');
  if(marker)requireValue(marker.length===1 || (marker.length===2 && ['global','local'].includes(marker[1])),
   'invalid embedded library power marker');
  let inherited={power:false,physical:false};
  if(extendsNode) {
   requireValue(extendsNode.length===2 && typeof extendsNode[1]==='string' && extendsNode[1],
    'invalid embedded symbol inheritance');
   const parent=extendsNode[1],namespace=x=>x.includes(':')?x.slice(0,x.lastIndexOf(':')):'';
   requireValue(!parent.includes(':') || namespace(parent)===namespace(id),
    'embedded symbol inheritance crosses library ownership');
   const qualified=id.includes(':') && !parent.includes(':')?id.slice(0,id.lastIndexOf(':')+1)+parent:parent;
   const matches=[...new Set([parent,qualified])].filter(x=>byId.has(x));
   requireValue(matches.length===1,'embedded symbol inheritance missing/ambiguous');
   inherited=resolvePower(matches[0],next);
   if(marker && inherited.power) {
    // A derived local/global power annotation must agree with its inherited
    // annotation, rather than silently choosing one contradictory boundary.
    if(inherited.power!=='legacy' && marker[1])requireValue(inherited.power===marker[1],
     'conflicting embedded library power markers');
   }
  }
  const p=properties(n),part=identity(p);
  const result={power:marker?(marker[1]??'legacy'):inherited.power,
   physical:inherited.physical || !!(p.Footprint??'') || !!part.mpn || !!part.lcsc};
  requireValue(!result.power || !result.physical,'embedded power symbol has conflicting physical identity');
  memo.set(id,result);return result;
 };
}
export function readPopulation(root,project,instanceProjectNames={}) {
 requireValue(instanceProjectNames && typeof instanceProjectNames==='object' && !Array.isArray(instanceProjectNames),'invalid instance project mapping');
 for(const [file,name] of Object.entries(instanceProjectNames))
  requireValue(typeof file==='string' && file.startsWith('hardware-design/') && file.endsWith('.kicad_sch') &&
   file.split('/').every(p=>p && p!=='.' && p!=='..') && !file.includes('\\') &&
   typeof name==='string' && name.trim()===name && name.length>0,'invalid instance project mapping path/name');
 const usedMappings=new Set();
 const sources={};const read=p=>{const b=ownedFile(root,p,'hardware-design');sources[p]=sha256(b);return parseNative(b.toString());};
 const rootPath=project+'.kicad_sch',main=read(rootPath);
 requireValue(main[0]==='kicad_sch','wrong schematic root');
 const rootUuid=single(main,'uuid')?.[1];requireValue(rootUuid,'schematic root UUID missing');
 const projectName=basename(project),symbols=new Map(),units=new Map(),rootUuids=new Set(),origins=new Map(),fallbackRefs=new Set();let visits=0;
 function walk(file,tree,sheetPath,ancestors) {
  requireValue(++visits<=10000,'schematic instance bound exceeded');
  requireValue(!ancestors.has(file),'cyclic schematic hierarchy');const next=new Set(ancestors);next.add(file);
  const powerSymbol=embeddedPowerResolver(tree);
  for(const n of children(tree,'symbol')) {
   const p=properties(n),inst=single(n,'instances'),uuid=single(n,'uuid')?.[1],isRoot=file===rootPath && !ancestors.size;
   if(isRoot && uuid!==undefined) {
    requireValue(typeof uuid==='string' && uuid && !rootUuids.has(uuid.toLowerCase()),'missing/duplicate root placed symbol UUID');rootUuids.add(uuid.toLowerCase());
   }
   let ref,unit;
   if(inst!==undefined) {
    const expectedProject=Object.hasOwn(instanceProjectNames,file)?instanceProjectNames[file]:projectName;
    const projects=children(inst,'project').filter(p=>p[1]===expectedProject);
    requireValue(projects.length===1,'placed symbol project instance missing/ambiguous');
    const paths=children(projects[0],'path').filter(p=>p[1]===sheetPath);
    requireValue(paths.length===1,'placed symbol sheet instance missing/ambiguous');
    ref=single(paths[0],'reference')?.[1];unit=single(paths[0],'unit')?.[1];
    if(Object.hasOwn(instanceProjectNames,file))usedMappings.add(file);
   } else {
    requireValue(isRoot,'placed child symbol instance missing');
    requireValue(typeof uuid==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid),'root property reference requires exact canonical placed symbol UUID');
    ref=p.Reference;unit=single(n,'unit')?.[1];fallbackRefs.add(ref);
   }
   requireValue(typeof ref==='string' && ref.trim()===ref && ref && /^[1-9]\d*$/.test(unit??'') && Number.isSafeInteger(Number(unit)),'invalid placed reference/unit');
   const placedUnit=single(n,'unit')?.[1];requireValue(placedUnit===undefined || placedUnit===unit,'placed symbol/instance unit differs');
   if(isRoot && uuid!==undefined) {if(!origins.has(ref))origins.set(ref,new Set());origins.get(ref).add(uuid);}
   const part={reference:ref,...identity(p),footprint:p.Footprint??'',power_symbol:!!powerSymbol(single(n,'lib_id')?.[1]).power,
    in_bom:flag(n,'in_bom'),on_board:flag(n,'on_board'),dnp:flag(n,'dnp')};
   const unitKey=ref+'/'+unit;requireValue(!units.has(unitKey),'duplicate placed reference/unit');units.set(unitKey,true);
   if(symbols.has(ref)) requireValue(JSON.stringify(symbols.get(ref))===JSON.stringify(part),'inconsistent multi-unit identity');
   else symbols.set(ref,part);
  }
  for(const sheet of children(tree,'sheet')) {
   const p=properties(sheet),name=p.Sheetfile??p['Sheet file'],uuid=single(sheet,'uuid')?.[1];
   requireValue(name && uuid && !name.includes('${'),'unresolved schematic sheet path');
   const child=relative(root,resolve(root,dirname(file),name)).split('\\').join('/');
   requireValue(child.endsWith('.kicad_sch'),'invalid schematic sheet extension');
   const parsed=read(child);requireValue(parsed[0]==='kicad_sch','wrong child schematic root');
   walk(child,parsed,sheetPath+'/'+uuid,next);
  }
 }
 walk(rootPath,main,'/'+rootUuid,new Set());
 for(const file of Object.keys(instanceProjectNames))
  requireValue(Object.hasOwn(sources,file) && file.endsWith('.kicad_sch') && usedMappings.has(file),
   'instance project mapping is outside native schematic closure or unused');
 const pcb=read(project+'.kicad_pcb');requireValue(pcb[0]==='kicad_pcb','wrong PCB root');
 const footprints=new Map();for(const n of children(pcb,'footprint')) {
  const p=properties(n),ref=p.Reference,attrs=single(n,'attr')?.slice(1)??[];
  requireValue(ref && !footprints.has(ref),'missing/duplicate PCB reference');
  requireValue(typeof n[1]==='string' && n[1],'PCB footprint identity missing');
  footprints.set(ref,{reference:ref,footprint:n[1],path:single(n,'path')?.[1],...identity(p),dnp:attrs.includes('dnp'),
   excluded:attrs.includes('exclude_from_bom'),board_only:attrs.includes('board_only')});
 }
 // Direct root references are native property values, not fabricated instances.
 // Keep every actually placed root unit UUID when one unit uses that mode.
 const rootPropertyOrigins=new Map([...fallbackRefs].map(ref=>{
  const ids=origins.get(ref);requireValue(ids && [...ids].every(uuid=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid)),
   'merged root property reference has noncanonical placed-unit UUID');
  return [ref,ids];
 }));
 return {symbols,footprints,sources,rootPropertyOrigins};
}
