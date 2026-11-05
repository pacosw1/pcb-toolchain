// Advisory fail-closed guard for local adoption. The actual authority boundary is service-owned storage and permissions.
import fs from 'node:fs';import path from 'node:path';
export function assertLocalAdoptionAllowed(projectRoot:string):void {
 let current=fs.realpathSync(projectRoot);
 for(;;){
  try{fs.lstatSync(path.join(current,'.pcb-protected.json'));throw new Error('protected project cannot be adopted locally; use the protected coordinator API');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const parent=path.dirname(current);if(parent===current)break;current=parent;
 }
}
