import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {gateInputs,fingerprint} from './gate-inputs.mjs';
import {readReport} from './gate-runtime.mjs';

// Routing can use a completed exploratory DRC with findings, but cannot use a
// failed invocation, an obsolete board or evidence from a different input set.
export function latestDrc(root,board,environment={},externalRoots={}) {
 const dir=join(root,'hardware-design/boards',board,'.gate');
 const latest=JSON.parse(readFileSync(join(dir,'latest.json'),'utf8'));
 if(!/^run-[A-Za-z0-9_-]+$/.test(latest.run)) throw new Error('invalid gate run pointer');
 const run=join(dir,latest.run);const result=JSON.parse(readFileSync(join(run,'result.json'),'utf8'));
 if(result.changedDuringRun || !Number.isSafeInteger(result.metrics?.drc_errors) || result.metrics.drc_errors<0 || !result.provenance?.input_sha256) throw new Error('DRC invocation did not complete with valid evidence');
 const current=fingerprint(root,gateInputs(root,board,'gate.json',environment).files,result.provenance.tools,externalRoots);
 if(current.input_sha256!==result.provenance.input_sha256) throw new Error('gate inputs have changed; run the gate again');
 const report=readReport(join(run,'drc.json'),'drc',{code:0});
 if(!report) throw new Error('missing or malformed DRC report');
 return report;
}
