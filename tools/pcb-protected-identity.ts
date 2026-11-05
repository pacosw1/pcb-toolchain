// Trusted verifier subprocess entry point; this output is not itself authorization to adopt a board.
import { verifyProtectedBoardIdentity } from './lib/protected-board-identity.ts';
import fs from 'node:fs';
if (process.argv.length !== 4 && process.argv.length !== 5) { console.error('usage: pcb-protected-identity SOURCE.kicad_pcb CANDIDATE.kicad_pcb [ALLOWED-POURS.json]'); process.exitCode=2; }
else {
  try {
    const pours=new Set<string>();
    if(process.argv[4]){
      const fd=fs.openSync(process.argv[4],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      let bytes:Buffer;try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>1024*1024)throw new Error('invalid allowed pours file');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
      const rows:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
      if(!Array.isArray(rows)||rows.length>10_000)throw new Error('invalid allowed pours');
      for(const row of rows){
        if(!Array.isArray(row)||row.length!==3||!row.every(x=>typeof x==='string'&&x.isWellFormed()&&x.length>0&&Buffer.byteLength(x)<=256&&!/[\u0000-\u001f\u007f]/u.test(x)))throw new Error('invalid allowed pour');
        const key=JSON.stringify(row);if(pours.has(key))throw new Error('duplicate allowed pour');pours.add(key);
      }
    }
    const result=verifyProtectedBoardIdentity(process.argv[2],process.argv[3],pours);
    console.log(JSON.stringify({schema:'pcb.board-identity.v1',...result}));
    process.exitCode=result.identityPreserved ? 0 : 1;
  } catch(error) { console.error(`protected board identity: ${error instanceof Error ? error.message : String(error)}`); process.exitCode=2; }
}
