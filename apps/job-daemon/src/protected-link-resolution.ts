// A bounded, pure manifest-link resolver. This is not an importer or a complete path/collision policy.
// Callers must validate Unicode, filesystem collision and external dependency policy separately.
export type ManifestNode = { path: string; kind: 'file'; sha256: string } | { path: string; kind: 'link'; target: string };
export type ResolvedLink = { path: string; target: string; resolvedPath: string; resolvedKind: 'file' | 'directory'; sha256: string | null };
export type ResolvedPath = { resolvedPath:string; resolvedKind:'file'|'directory'|'missing'; sha256:string|null; terminalLink?:string };
const SHA = /^[0-9a-f]{64}$/;
function components(value: string, allowParent: boolean): string[] {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 4096 || value.startsWith('/') ||
      value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value) || /[\uD800-\uDFFF]/u.test(value)) throw new Error('invalid manifest path');
  const parts = value.split('/');
  if (parts.some(p => !p || (!allowParent && (p === '.' || p === '..')) || Buffer.byteLength(p, 'utf8') > 255)) throw new Error('invalid manifest path');
  return parts;
}
/** Syntax only; destination-specific Unicode and case collisions require additional validation. */
export function validateManifestPath(value: string): void { components(value, false); }

/** Create one bounded resolver for direct files and paths through in-root directory symlinks. */
export function createManifestResolver(nodes:readonly ManifestNode[]): {links:ResolvedLink[];resolve:(path:string)=>ResolvedPath|null} {
  if (!Array.isArray(nodes) || nodes.length > 100_000) throw new Error('invalid manifest size');
  const entries=new Map<string,ManifestNode>(), directories=new Set<string>(['']);
  for(const node of nodes){
    if(!node || (node.kind!=='file' && node.kind!=='link'))throw new Error('invalid manifest node');
    const parts=components(node.path,false);if(entries.has(node.path))throw new Error('duplicate manifest path');
    if(node.kind==='file'){if(typeof node.sha256!=='string'||!SHA.test(node.sha256))throw new Error('invalid file hash');}
    else components(node.target,true);
    entries.set(node.path,node);for(let i=1;i<parts.length;i++)directories.add(parts.slice(0,i).join('/'));
  }
  for(const dir of directories)if(entries.has(dir))throw new Error('manifest node overlaps a directory');
  let totalSteps=0;
  const resolve=(value:string):ResolvedPath|null=>{
    const pending=components(value,false),resolved:string[]=[],seen=new Set<string>();let expansions=0,steps=0,terminalLink:string|undefined;
    while(pending.length){
      if(++steps>16_384||++totalSteps>1_000_000)throw new Error('link resolution limit exceeded');
      const part=pending.shift()!;
      if(part==='.')continue;
      if(part==='..'){if(!resolved.length)throw new Error('link escapes manifest root');resolved.pop();continue;}
      resolved.push(part);const current=resolved.join('/'),entry=entries.get(current);
      if(entry?.kind==='link'){
        if(seen.has(current)||++expansions>256)throw new Error('cyclic or excessive links');
        if(!pending.length && terminalLink===undefined)terminalLink=entry.target;
        seen.add(current);resolved.pop();pending.unshift(...components(entry.target,true));
      }else if(pending.length && !directories.has(current))return null;
    }
    const resolvedPath=resolved.join('/'),entry=entries.get(resolvedPath);
    if(entry?.kind==='file')return {resolvedPath,resolvedKind:'file',sha256:entry.sha256,...(terminalLink===undefined?{}:{terminalLink})};
    if(directories.has(resolvedPath))return {resolvedPath,resolvedKind:'directory',sha256:null,...(terminalLink===undefined?{}:{terminalLink})};
    return {resolvedPath,resolvedKind:'missing',sha256:null,...(terminalLink===undefined?{}:{terminalLink})};
  };
  const links:ResolvedLink[]=[];
  for(const node of nodes)if(node.kind==='link'){
    const target=resolve(node.path);if(!target||target.resolvedKind==='missing')throw new Error('link target is missing or not a directory');
    links.push({path:node.path,target:node.target,resolvedPath:target.resolvedPath,resolvedKind:target.resolvedKind,sha256:target.sha256});
  }
  return {links,resolve};
}
/** Resolve only against records in the snapshot; never inspect or follow host filesystem paths. */
export function resolveManifestLinks(nodes:readonly ManifestNode[]):ResolvedLink[]{return createManifestResolver(nodes).links;}
