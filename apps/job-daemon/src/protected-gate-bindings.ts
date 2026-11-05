// Bind an independently scanned gate input set to content-addressed manifests and a separately approved tool/runtime set.
// This does not discover dependencies, attest external inputs, or authenticate the scanner.
import { createManifestResolver, validateManifestPath } from './protected-link-resolution.ts';
import type { ManifestClosure } from './protected-closure.ts';
export interface GateInputBinding {path:string;sha256:string|null;link?:string}
const SHA=/^[0-9a-f]{64}$/;
function valid(row:GateInputBinding):boolean {
  return !!row && typeof row.path==='string' && row.path.length>0 && row.path.length<=4096 && !/[\u0000-\u001f\u007f]/u.test(row.path) &&
    (row.sha256===null || typeof row.sha256==='string' && SHA.test(row.sha256)) && (row.link===undefined || typeof row.link==='string' && row.link.length<=4096);
}
function equal(a:GateInputBinding,b:GateInputBinding):boolean {return a.path===b.path && a.sha256===b.sha256 && a.link===b.link && Object.hasOwn(a,'link')===Object.hasOwn(b,'link');}

/** Caller must derive scanned inputs independently and authenticate every external allowlist entry. */
export function bindGateInputsToManifest(closure:ManifestClosure, scanned:readonly GateInputBinding[], approvedExternal:readonly GateInputBinding[]): GateInputBinding[] {
  if (!Array.isArray(scanned) || scanned.length<1 || scanned.length>100_000 || !Array.isArray(approvedExternal) || approvedExternal.length>100_000)
    throw new Error('invalid gate input set');
  const allowed=new Map<string,GateInputBinding>(), occupied=new Set<string>();
  const add=(row:GateInputBinding):void=>{if(!valid(row)||allowed.has(row.path)) throw new Error('ambiguous gate input binding');allowed.set(row.path,row);};
  for (const node of closure.nodes) {
    occupied.add(node.path);const parts=node.path.split('/');for(let i=1;i<parts.length;i++)occupied.add(parts.slice(0,i).join('/'));
    if(node.kind==='file') add({path:node.path,sha256:node.sha256});
  }
  const resolver=createManifestResolver(closure.nodes), absent=new Set(closure.optionalAbsentPaths);
  for (const link of resolver.links) {
    if(link.resolvedKind==='file' && link.sha256) add({path:link.path,sha256:link.sha256,link:link.target});
  }
  for (const path of closure.optionalAbsentPaths) add({path,sha256:null});
  const external=new Map<string,GateInputBinding>();
  for (const row of approvedExternal) {
    if(!valid(row)||occupied.has(row.path)||allowed.has(row.path)||external.has(row.path)) throw new Error('ambiguous gate input binding');
    external.set(row.path,{...row});
  }
  const seen=new Set<string>(), result:GateInputBinding[]=[];
  for(const row of scanned) {
    if(!valid(row) || seen.has(row.path)) throw new Error('invalid or duplicate scanned gate input');
    let expected=allowed.get(row.path);
    if(!expected) {
      let safe=true;try{validateManifestPath(row.path);}catch{safe=false;}
      if(safe){
        const resolved=resolver.resolve(row.path);
        if(resolved?.resolvedKind==='file') expected={path:row.path,sha256:resolved.sha256,...(resolved.terminalLink===undefined?{}:{link:resolved.terminalLink})};
        else if(resolved?.resolvedKind==='missing' && absent.has(resolved.resolvedPath)) expected={path:row.path,sha256:null};
      }
    }
    expected ??= external.get(row.path);
    if(!expected || !equal(row,expected)) throw new Error('gate input is not bound to an approved snapshot');
    seen.add(row.path); result.push({...row});
  }
  return result;
}
