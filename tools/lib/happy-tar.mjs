// The kicad-happy clone as a tar for a job, for tools/router/route-dispatch.mjs and tools/lib/kicad-happy-phases.ts.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One tar per pinned commit: a tar made again differs in its gzip time, so its hash misses the daemon's file cache. */
export function happyTar(happyDir,commit){
  const dir=path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache'),'pcb-toolchain');
  const file=path.join(dir,`kicad-happy-${commit}.tar.gz`);
  if(fs.statSync(file,{throwIfNoEntry:false})?.isFile())return file;
  fs.mkdirSync(dir,{recursive:true});
  const tmp=`${file}.${process.pid}`;
  const r=spawnSync('tar',['--no-xattrs','-czf',tmp,'-C',happyDir,'.'],{env:{...process.env,COPYFILE_DISABLE:'1'},stdio:['ignore','ignore','inherit']});
  if(r.status!==0)throw Error(`tar of ${happyDir} failed`);
  fs.renameSync(tmp,file);
  return file;
}
