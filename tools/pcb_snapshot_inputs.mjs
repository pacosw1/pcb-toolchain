// Read the gate's repository dependency closure without launching native tools.
import {gateInputs, fingerprint} from './lib/gate-inputs.mjs';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {kicadCli,kicadPython,happyRuntime,kicadShared,kicadConfig,pinnedRepos} from './lib/env.mjs';
import {verifyReleaseGate, releaseRecipe} from './lib/release-evidence.mjs';
import {readReport} from './lib/gate-runtime.mjs';
const [root, board, mode, evidence, failedStage] = process.argv.slice(2);
try {
  const input = gateInputs(root, board);
  const c=input.cfg.checks;
  const environment={configDir:kicadConfig,variables:{KICAD10_FOOTPRINT_DIR:join(kicadShared,'footprints'),KICAD10_SYMBOL_DIR:join(kicadShared,'symbols')},repositories:c.kicad_happy ? pinnedRepos.filter(r=>r.needed==='gate').map(r=>r.dir) : []};
  if (!mode) console.log(JSON.stringify(gateInputs(root,board,'gate.json',environment).files));
  else {
    if (!['--verify','--verify-failed','--verify-inputs'].includes(mode) || !evidence) throw Error('unknown receipt verification request');
    const externalRoots={kicad:kicadShared,kicad_config:kicadConfig,...Object.fromEntries(pinnedRepos.map(r=>[r.name,r.dir]))};
    const probe=(cmd,args)=>execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
    const tools={kicad:probe(kicadCli,['--version']),node:process.version};
    if(Object.keys(c).some(k=>c[k] && !['erc','drc','kicad_happy'].includes(k))) tools.pcbnew=probe(kicadPython,['-c','import pcbnew; print(pcbnew.Version())']);
    if(c.kicad_happy) {
      tools.kicad_happy_runtime=happyRuntime();
      for(const repo of pinnedRepos.filter(r=>r.needed==='gate')) tools[repo.name]=probe('git',['-C',repo.dir,'rev-parse','HEAD']);
    }
    const result=JSON.parse(readFileSync(join(evidence,'result.json'),'utf8'));
    if(JSON.stringify(Object.entries(tools).sort())!==JSON.stringify(Object.entries(result.provenance.tools).sort()))throw Error('gate tool versions changed');
    const current=fingerprint(root,gateInputs(root,board,'gate.json',environment).files,tools,externalRoots);
    if(current.input_sha256!==result.provenance.input_sha256 || result.changedDuringRun)throw Error('gate input dependencies changed');
    if(mode==='--verify') verifyReleaseGate(root,board,evidence,environment,externalRoots,tools);
    else if(mode==='--verify-failed') {
      const check=result.checks?.[failedStage];
      if(result.exit!==1 || check?.status!=='failed' || !check.metrics || Object.values(check.metrics).some(v=>v===null))throw Error('named baseline stage lacks valid failed-check evidence');
      if(['erc','drc'].includes(failedStage) && !readReport(join(evidence,failedStage+'.json'),failedStage,{code:0}))throw Error('named baseline native report is invalid');
    }
    console.log(JSON.stringify({verified:true,input_sha256:current.input_sha256,
      ...(mode==='--verify-inputs' ? {board,project:input.cfg.project,release_supported:Boolean(releaseRecipe(root,board))} : {})}));
  }
}
catch (error) { console.error(error.message); process.exitCode = 2; }
