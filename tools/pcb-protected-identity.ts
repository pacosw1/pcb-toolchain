// Trusted verifier subprocess entry point; this output is not itself authorization to adopt a board.
import { verifyProtectedBoardIdentity } from './lib/protected-board-identity.ts';
if (process.argv.length !== 4) { console.error('usage: pcb-protected-identity SOURCE.kicad_pcb CANDIDATE.kicad_pcb'); process.exitCode=2; }
else {
  try {
    const result=verifyProtectedBoardIdentity(process.argv[2],process.argv[3]);
    console.log(JSON.stringify({schema:'pcb.board-identity.v1',...result}));
    process.exitCode=result.identityPreserved ? 0 : 1;
  } catch(error) { console.error(`protected board identity: ${error instanceof Error ? error.message : String(error)}`); process.exitCode=2; }
}
