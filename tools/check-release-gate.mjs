#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {root,kicadCli,kicadPython,modernPython,kicadShared,kicadConfig,pinnedRepos} from './lib/env.mjs';
import {verifyReleaseGate,probeReleaseTools} from './lib/release-evidence.mjs';
try {
 const args=process.argv.slice(2),index=args.indexOf('--gate-dir');
 let gateDir;
 if(index>=0){if(!args[index+1])throw new Error('--gate-dir requires a directory');gateDir=resolve(args[index+1]);args.splice(index,2);}
 const [board,expected,out]=args;
 if(!/^[A-Z0-9-]+$/.test(board??'') || args.length>3)throw new Error('usage: check-release-gate.mjs BOARD [TOKEN [OUT]] [--gate-dir DIRECTORY]');
 if(!gateDir) {
  const dir=join(root,'hardware-design/boards',board,'.gate'),pointer=JSON.parse(readFileSync(join(dir,'latest.json'),'utf8'));
  if(!/^run-[A-Za-z0-9_-]+$/.test(pointer.run))throw new Error('invalid gate run pointer');
  gateDir=join(dir,pointer.run);
 }
 const environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:join(kicadShared,'symbols')},repositories:pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir)};
 const externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
 const evidence=verifyReleaseGate(root,board,gateDir,environment,externalRoots,probeReleaseTools({kicadCli,kicadPython,modernPython:modernPython(),pinnedRepos}));
 if(expected && expected!==evidence.token)throw new Error('gate evidence changed during export');
 if(out)writeFileSync(out,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
 console.log(evidence.token);
}catch(error){console.error('FAIL: release evidence: '+error.message);process.exit(1);}
