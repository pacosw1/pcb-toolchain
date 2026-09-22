#!/usr/bin/env node
import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
const root = new URL('../hardware-design/boards/', import.meta.url);
const boards = ['BASE-PWR','POE-ETHERNET','BACKUP-POWER','PQ-METER'];
const required = ['README.md','STATUS.md','SPEC.md','BOM-VERIFIED.csv','SCHEMATIC.md','DATASHEETS.md','POWER-AND-IC-ANALYSIS.md','MECHANICAL.md','JLC-SUBMISSION.md','BRINGUP-TEST-PLAN.md','DOC-RECONCILIATION.md','reports/README.md','handoff/README.md'];
const failures=[];
for(const board of boards){
  for(const file of required){
    try{await access(new URL(`${board}/${file}`,root));}catch{failures.push(`${board}/${file}`);}
  }
  const bom=await readFile(new URL(`${board}/BOM-VERIFIED.csv`,root),'utf8').catch(()=>null);
  if(bom && !bom.startsWith('Designator,Function block,MPN/value,LCSC')) failures.push(`${board}/BOM-VERIFIED.csv:header`);
}
if(failures.length){console.error(JSON.stringify({ok:false,failures},null,2));process.exit(1);}
console.log(JSON.stringify({ok:true,boards,required_files:required.length}));
