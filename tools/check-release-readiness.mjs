#!/usr/bin/env node
import {resolve,join} from 'node:path';
import {root,kicadShared,kicadConfig,pinnedRepos} from './lib/env.mjs';
import {releaseReadiness} from './lib/release-readiness.mjs';
try {
 const args=process.argv.slice(2),board=args.shift(),candidate=args.shift(),options={};
 if(!board || !candidate)throw new Error('usage: check-release-readiness.mjs BOARD CANDIDATE [--stock DIR] [--orientation FILE] [--boards N] [--as-of YYYY-MM-DD]');
 while(args.length) {const flag=args.shift(),value=args.shift();if(!value || !['--stock','--orientation','--boards','--as-of'].includes(flag))throw new Error('invalid readiness option');options[flag==='--as-of'?'asOf':flag.slice(2)]=flag==='--boards'?Number(value):value;}
 options.environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:join(kicadShared,'symbols')},repositories:pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir)};
 options.externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
 const result=await releaseReadiness(root,board,resolve(candidate),options);console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='blocked'?1:0;
}catch(error){console.log(JSON.stringify({schema_version:1,status:'error',cause:error.message}));process.exitCode=2;}
