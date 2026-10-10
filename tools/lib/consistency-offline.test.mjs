import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {FULL_PACKET} from './board-packets.mjs';
const sha=v=>createHash('sha256').update(v).digest('hex');
test('offline evidence validation checks candidate state, exact MPN and original source hashes',t=>{
 const root=mkdtempSync(join(tmpdir(),'consistency-offline-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 const repo=fileURLToPath(new URL('../..',import.meta.url));
 for(const p of ['tools/check-consistency.mjs','tools/lib/board-packets.mjs','tools/lib/board-selections.mjs','tools/lib/bom-ownership.mjs','tools/lib/jev-client.mjs','tools/lib/bom-coverage.mjs','tools/lib/kicad-population.mjs','tools/lib/csv.mjs']) {mkdirSync(join(root,p,'..'),{recursive:true});copyFileSync(join(repo,p),join(root,p));}
 for(const p of ['STATUS','REQUIREMENTS','DECISIONS','DOC-RECONCILIATION','BOARD-INDEX']) put('hardware-design/'+p+'.md','current evidence');
 for(const p of ['PLATFORM.md','MODULES.md','README.md']) put(p,'current evidence');
 put('hardware-design/registry/boards.json',{schema_version:1,boards:[{id:'CELLULAR',directory:'CELLULAR',kind:'board',lifecycle:'active',packet:'full',revisions:[{revision:'A',state:'review',spec:'SPEC.md'}]}]});
 for(const p of FULL_PACKET) put('hardware-design/boards/CELLULAR/'+p,p==='BOM-VERIFIED.csv'?'Designator,Function block,MPN/value,LCSC\nU1,LTE,EG912U,C123\n':'documented');
 const component={lcsc:'C123',mpn:'EG912U',state:'electrically-selected',evidence:'evidence/C123.json',datasheet:'datasheets/module.pdf'};
 const records=()=>put('hardware-design/registry/components.json',{candidates:[component]});records();
 put('hardware-design/registry/evidence/C123.html','original JLC source');
 put('hardware-design/registry/evidence/C123.json',{expected_lcsc:'C123',identity_matched:true,stock_verified:true,fetched_at_utc:'2026-10-09T00:00:00Z',source_sha256:sha('original JLC source')});
 put('hardware-design/registry/datasheets/module.pdf','original manufacturer PDF');
 put('hardware-design/registry/datasheets/module.pdf.source.json',{source_url:'https://manufacturer.example/datasheet.pdf',fetched_at_utc:'2026-10-09T00:00:00Z',sha256:sha('original manufacturer PDF')});
 const run=()=>{try{return JSON.parse(execFileSync(process.execPath,[join(root,'tools/check-consistency.mjs'),'--offline'],{encoding:'utf8'}));}catch(e){assert.equal(e.status,1);return JSON.parse(e.stdout);}};
 assert.equal(run().ok,false);assert.ok(run().findings.some(f=>f.check==='bom_coverage'));
 component.state='stock-observed';records();assert.ok(run().findings.some(f=>f.check==='bom_candidate_state'));
 component.state='electrically-selected';component.mpn='Different';records();assert.ok(run().findings.some(f=>f.check==='bom_mpn_identity'));
 component.mpn='EG912U';records();put('hardware-design/registry/evidence/C123.html','altered');assert.ok(run().findings.some(f=>f.check==='bom_stock_evidence'));
 put('hardware-design/registry/evidence/C123.html','original JLC source');put('hardware-design/registry/datasheets/module.pdf','altered');assert.ok(run().findings.some(f=>f.check==='bom_datasheet_evidence'));
 // A reviewed board selection resolves only this BOM, without globally
 // promoting the shared candidate or bypassing exclusions.
 put('hardware-design/registry/datasheets/module.pdf','original manufacturer PDF');
 component.state='stock-observed';records();
 put('hardware-design/registry/boards.json',{schema_version:1,boards:[{id:'CELLULAR',directory:'CELLULAR',kind:'board',lifecycle:'active',packet:'full',revisions:[{revision:'A',state:'review',spec:'SPEC.md',bom:'BOM-VERIFIED.csv',selection:'BOM-VERIFIED.selection.json'}]}]});
 const snapshot={expected_lcsc:'C123',identity_matched:true,stock_verified:true,fetched_at_utc:'2026-10-09T00:00:00Z',source_sha256:sha('original JLC source'),purchase_record:{componentModelEn:'EG912U',componentCode:'C123'}};
 put('hardware-design/registry/evidence/C123.json',snapshot);
 const prefix='hardware-design/boards/CELLULAR', review=prefix+'/reports/selection.md';
 put(review,'historical electrical selection review');
 const ledger={schema_version:1,board:'CELLULAR',revision:'A',revision_spec:prefix+'/SPEC.md',bom:prefix+'/BOM-VERIFIED.csv',bom_sha256:sha('Designator,Function block,MPN/value,LCSC\nU1,LTE,EG912U,C123\n'),state:'electrically-selected',state_basis:'Historical review',limits:['Assembly pending'],stock_current:false,qualified:false,release_approved:false,
   selection_review:review,review_evidence:{[review]:sha('historical electrical selection review'),[prefix+'/SPEC.md']:sha('documented')},
   parts:[{lcsc:'C123',mpn:'EG912U',state:'electrically-selected',references:['U1'],reviews:[review],evidence:'evidence/C123.json',evidence_sha256:sha(JSON.stringify(snapshot)),observed_at_utc:snapshot.fetched_at_utc,datasheet:'datasheets/module.pdf',datasheet_sha256:sha('original manufacturer PDF')}]};
 put(prefix+'/BOM-VERIFIED.selection.json',ledger);
 assert.equal(run().ok,false);assert.ok(run().findings.some(f=>f.check==='bom_coverage'));assert.equal(component.state,'stock-observed');
 component.state='excluded-zero-stock';records();assert.ok(run().findings.some(f=>f.check==='bom_excluded_part'));
 component.state='electrically-selected';records();
 put(review,'altered review');assert.ok(run().findings.some(f=>f.check==='bom_selection_evidence'));
});
