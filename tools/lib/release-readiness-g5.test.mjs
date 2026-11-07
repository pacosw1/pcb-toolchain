// The readiness result reports the G5 state from the release approval record (lib/release-approval.mjs).
// The fixture has no board data, so every other readiness check is blocked: G5 is then false, and the state still shows.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {approveRelease} from './release-approval.mjs';
import {releaseReadiness} from './release-readiness.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
const MANIFEST='{"schema_version":1,"board":"X","g5_ready":false}\n';

function fixture(t) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'readiness-g5-')));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,content)=>{const full=join(root,path);mkdirSync(dirname(full),{recursive:true});writeFileSync(full,content);return full;};
 put('hardware-design/boards/X/gate.json',JSON.stringify({project:'cad/X',checks:{},release:{maker:'tools/make-x-fab.sh',fab:'fab'}}));
 put('hardware-design/registry/boards.json',JSON.stringify({schema_version:1,boards:[]}));
 put('candidate/release-manifest.json',MANIFEST);
 const report=put('report.json',JSON.stringify({board:'X',status:'ready_for_user_review',checks:{cad_fabrication:{candidate_sha256:sha(MANIFEST)}}}));
 const image=put('top.svg','<svg xmlns="http://www.w3.org/2000/svg"/>');
 return {root,candidate:join(root,'candidate'),approve:()=>approveRelease(root,'X',join(root,'candidate'),{by:'Ana',reason:'checked',report,image})};
}

test('readiness reports a missing approval and keeps G5 false',async t=>{
 const f=fixture(t);
 const result=await releaseReadiness(f.root,'X',f.candidate);
 assert.equal(result.g5_release_approved,false);
 assert.equal(result.g5_approval.state,'missing');
});

test('readiness shows a fresh approval, and G5 stays false while another check is blocked',async t=>{
 const f=fixture(t);
 f.approve();
 const result=await releaseReadiness(f.root,'X',f.candidate);
 assert.equal(result.status,'blocked');
 assert.equal(result.g5_approval.state,'approved');
 assert.equal(result.g5_release_approved,false);
});

test('readiness shows a stale approval after the candidate changed',async t=>{
 const f=fixture(t);
 f.approve();
 writeFileSync(join(f.candidate,'release-manifest.json'),MANIFEST.replace('false','true'));
 const result=await releaseReadiness(f.root,'X',f.candidate);
 assert.equal(result.g5_approval.state,'stale');
 assert.equal(result.g5_release_approved,false);
});
