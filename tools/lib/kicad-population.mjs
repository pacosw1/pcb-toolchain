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
export function readPopulation(root,project) {
 const sources={};const read=p=>{const b=ownedFile(root,p,'hardware-design');sources[p]=sha256(b);return parseNative(b.toString());};
 const rootPath=project+'.kicad_sch',main=read(rootPath);
 requireValue(main[0]==='kicad_sch','wrong schematic root');
 const rootUuid=single(main,'uuid')?.[1];requireValue(rootUuid,'schematic root UUID missing');
 const projectName=basename(project),symbols=new Map(),units=new Map();let visits=0;
 function walk(file,tree,sheetPath,ancestors) {
  requireValue(++visits<=10000,'schematic instance bound exceeded');
  requireValue(!ancestors.has(file),'cyclic schematic hierarchy');const next=new Set(ancestors);next.add(file);
  for(const n of children(tree,'symbol')) {
   const inst=single(n,'instances');requireValue(inst,'placed symbol instance missing');
   const projects=children(inst,'project').filter(p=>p[1]===projectName);
   requireValue(projects.length===1,'placed symbol project instance missing/ambiguous');
   const paths=children(projects[0],'path').filter(p=>p[1]===sheetPath);
   requireValue(paths.length===1,'placed symbol sheet instance missing/ambiguous');
   const ref=single(paths[0],'reference')?.[1],unit=single(paths[0],'unit')?.[1];
   requireValue(typeof ref==='string' && ref.trim()===ref && ref && /^[1-9]\d*$/.test(unit??'') && Number.isSafeInteger(Number(unit)),'invalid placed reference/unit');
   const placedUnit=single(n,'unit')?.[1];requireValue(placedUnit===undefined || placedUnit===unit,'placed symbol/instance unit differs');
   const p=properties(n),part={reference:ref,...identity(p),footprint:p.Footprint??'',
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
 const pcb=read(project+'.kicad_pcb');requireValue(pcb[0]==='kicad_pcb','wrong PCB root');
 const footprints=new Map();for(const n of children(pcb,'footprint')) {
  const p=properties(n),ref=p.Reference,attrs=single(n,'attr')?.slice(1)??[];
  requireValue(ref && !footprints.has(ref),'missing/duplicate PCB reference');
  requireValue(typeof n[1]==='string' && n[1],'PCB footprint identity missing');
  footprints.set(ref,{reference:ref,footprint:n[1],...identity(p),dnp:attrs.includes('dnp'),
   excluded:attrs.includes('exclude_from_bom'),board_only:attrs.includes('board_only')});
 }
 return {symbols,footprints,sources};
}
