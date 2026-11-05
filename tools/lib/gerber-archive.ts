import {readFileSync} from 'node:fs';
import {openZip,readEntry} from './zip-read.mjs';
export function archive(path:string): Map<string,string> {
 const z=openZip(readFileSync(path)), files=new Map<string,string>();
 for(const e of z.entries) { if(files.has(e.filename)) throw new Error(`duplicate Gerber archive entry: ${e.filename}`);files.set(e.filename,readEntry(z,e).toString('utf8')); }
 return files;
}
export function unique(files:Map<string,string>, suffix:string): [string,string] {
 const matches=[...files].filter(([name])=>name.endsWith(suffix));
 if(matches.length!==1) throw new Error(`need one ${suffix} in Gerber archive, got ${matches.length}`);
 return matches[0]!;
}
