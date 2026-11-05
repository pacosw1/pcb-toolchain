// GEOS 3.11.4 from the hash-pinned Shapely 2.0.7 Linux wheel; no Python runtime is used.
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {openZip,readEntry} from './zip-read.mjs';
const wheel='shapely-2.0.7-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl';
const wheelHash='adeddfb1e22c20548e840403e5e0b3d9dc3daf66f05fa59f1fcf5b5f664f0e98';
const source=`https://files.pythonhosted.org/packages/f5/8a/2545cc2a30afc63fc6176c1da3b76af28ef9c7358ed4f68f7c6a9d86cf5b/${wheel}`;
const files=[['libgeos-e4f0e0c1.so.3.11.4','0740bcd8875d89da579e6e26c4dbf6db3433b3c612c036f94bf095f109f0dfb8'],['libgeos_c-1e72bdae.so.1.17.4','8e95999d99584eb610f218d73a9d01cfcede1988363986d35891783754fce068']] as const;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export function geosFiles(): string[] {
 const cache=join(process.env.XDG_CACHE_HOME || join(homedir(),'.cache'),'pcb-toolchain','geos-3.11.4');
 const valid=()=>files.every(([name,want])=>{const p=join(cache,name);return existsSync(p)&&hash(readFileSync(p))===want});
 if(!valid()) {
  const tmp=mkdtempSync(join(tmpdir(),'gerber-geos-'));
  try {
   const target=join(tmp,wheel),r=spawnSync('curl',['-fsSL','--max-time','120','-o',target,source],{encoding:'utf8'});
   if(r.status!==0)throw new Error(`GEOS download failed: ${r.stderr}`);
   const bytes=readFileSync(target);if(hash(bytes)!==wheelHash)throw new Error('GEOS wheel hash mismatch');
   const zip=openZip(bytes);mkdirSync(cache,{recursive:true});
   for(const [name,want] of files){const entry=zip.byName.get('shapely.libs/'+name);if(!entry)throw new Error('GEOS library missing from wheel');const data=readEntry(zip,entry);if(hash(data)!==want)throw new Error('GEOS library hash mismatch');const p=join(cache,`${name}.${process.pid}`);writeFileSync(p,data,{flag:'wx'});renameSync(p,join(cache,name));}
  }finally{rmSync(tmp,{recursive:true,force:true});}
 }
 if(!valid())throw new Error('GEOS runtime hash mismatch');
 return files.map(([name])=>join(cache,name));
}
