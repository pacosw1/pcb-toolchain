#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {root,kicadShared,kicadConfig,pinnedRepos} from './lib/env.mjs';
import {latestDrc} from './lib/gate-evidence.mjs';
import {passes,expectedMetrics,validateConfig} from './lib/gate-core.mjs';
try {
 const board=process.argv[2];
 if(!/^[A-Z0-9-]+$/.test(board??'')) throw new Error('board required');
 const dir=join(root,'hardware-design/boards',board);
 const environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:join(kicadShared,'symbols')},repositories:pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir)};
 const externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
 latestDrc(root,board,environment,externalRoots);
 const pointer=JSON.parse(readFileSync(join(dir,'.gate/latest.json'),'utf8'));
 const result=JSON.parse(readFileSync(join(dir,'.gate',pointer.run,'result.json'),'utf8'));
 const cfg=JSON.parse(readFileSync(join(dir,'gate.json'),'utf8'));
 if(validateConfig(cfg).length || result.exit!==0 || !passes(result.metrics,expectedMetrics(cfg)).ok) throw new Error('gate is not at release targets');
 const token=pointer.run+':'+result.provenance.input_sha256;
 if(process.argv[3] && process.argv[3]!==token) throw new Error('gate evidence changed during export');
 if(process.argv[4]) writeFileSync(process.argv[4],JSON.stringify({board,run:pointer.run,...result},null,2)+'\n');
 console.log(token);
} catch(error) {console.error('release evidence: '+error.message);process.exit(1);}
