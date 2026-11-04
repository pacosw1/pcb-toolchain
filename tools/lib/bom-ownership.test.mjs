import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,symlinkSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {revisionBoms} from './bom-ownership.mjs';
import {inspectBomCoverage} from './bom-coverage.mjs';
import {inspectPackets,FULL_PACKET} from './board-packets.mjs';
import {loadBoardSelection} from './board-selections.mjs';
import {sha256,readPopulation} from './kicad-population.mjs';
import {parseCsv} from './csv.mjs';
const prefix='hardware-design/boards/X',header='Designator,Function block,MPN/value,LCSC,Quantity\n';
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'revision-boms-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 const entry={id:'X',kind:'board',lifecycle:'active',packet:'full',directory:'X',bom_policy:'per-revision',revisions:[]},scopes={},csvs={},ledgers={};
 for(const p of FULL_PACKET)if(p!=='BOM-VERIFIED.csv')put(prefix+'/'+p,'Synthetic fixture only');
 for(const rev of ['A','B']) {
  const project=prefix+'/cad/'+rev,ref=rev==='A'?'U1':'U2',mpn='PART-'+rev,code=rev==='A'?'C123':'C456',spec='SPEC-'+rev+'.md',review=prefix+'/review-'+rev+'.md';
  entry.revisions.push({revision:rev,state:'review',spec,project:'cad/'+rev,bom:'BOM-VERIFIED-'+rev+'.csv',bom_scope:'scope-'+rev+'.json',selection:'selection-'+rev+'.json'});
  put(prefix+'/'+spec,'Synthetic revision '+rev);put(review,'Synthetic historical review '+rev);
  put(project+'.kicad_sch',`(kicad_sch (uuid ROOT) (symbol (unit 1) (in_bom yes) (on_board yes) (dnp no) (property "Reference" "${ref}") (property "Footprint" "Land") (property "MPN" "${mpn}") (property "LCSC" "${code}") (instances (project "${rev}" (path "/ROOT" (reference "${ref}") (unit 1))))))`);
  put(project+'.kicad_pcb',`(kicad_pcb (footprint "Land" (property "Reference" "${ref}") (property "MPN" "${mpn}") (property "LCSC" "${code}") (attr smd)))`);
  const csv=header+`${ref},IC,${mpn},${code},1\n`;csvs[rev]=csv;put(prefix+'/BOM-VERIFIED-'+rev+'.csv',csv);put(prefix+'/assembly-'+rev+'.csv',header);
  const scope={schema_version:1,board:'X',revision:rev,revision_spec:prefix+'/'+spec,spec_sha256:sha256('Synthetic revision '+rev),project,bom:prefix+'/BOM-VERIFIED-'+rev+'.csv',bom_sha256:sha256(csv),source_hashes:readPopulation(root,project).sources,review_evidence:{[review]:sha256('Synthetic historical review '+rev)},native_population:'DEFAULT',classification:{[ref]:{kind:'component',reason:'synthetic exact native part',review,assembly_dependencies:[]}},assembly:{review,basis:'Synthetic board with no external ports',bom:prefix+'/assembly-'+rev+'.csv',bom_sha256:sha256(header),requirements:[]}};
  scopes[rev]=scope;put(prefix+'/scope-'+rev+'.json',scope);
  const evidence='evidence/'+code+'.json',pdf='datasheets/'+code+'.pdf',html='Synthetic historical catalog '+rev,bytes='Synthetic manufacturer '+rev,observed='2026-09-26T00:00:00Z';
  const receipt={expected_lcsc:code,identity_matched:true,stock_verified:true,fetched_at_utc:observed,source_sha256:sha256(html),purchase_record:{componentModelEn:mpn,componentCode:code}};
  put('hardware-design/registry/'+evidence,receipt);put('hardware-design/registry/evidence/'+code+'.html',html);put('hardware-design/registry/'+pdf,bytes);put('hardware-design/registry/'+pdf+'.source.json',{sha256:sha256(bytes),source_url:'https://manufacturer.example/'+code+'.pdf',fetched_at_utc:observed});
  const ledger={schema_version:1,board:'X',revision:rev,revision_spec:prefix+'/'+spec,bom:scope.bom,bom_sha256:scope.bom_sha256,state:'electrically-selected',state_basis:'Synthetic historical selection fixture',stock_current:false,qualified:false,release_approved:false,limits:['Not a real component selection'],selection_review:review,review_evidence:{[review]:sha256('Synthetic historical review '+rev),[prefix+'/'+spec]:scope.spec_sha256},parts:[{lcsc:code,mpn,state:'electrically-selected',references:[ref],reviews:[review],evidence,evidence_sha256:sha256(JSON.stringify(receipt)),observed_at_utc:observed,datasheet:pdf,datasheet_sha256:sha256(bytes)}]};
  ledgers[rev]=ledger;put(prefix+'/selection-'+rev+'.json',ledger);
 }
 const save=()=>put('hardware-design/registry/boards.json',{schema_version:1,boards:[entry]});save();
 return {root,entry,put,scopes,csvs,ledgers,save,packets:()=>inspectPackets(root,{schema_version:1,boards:[entry]}),coverage:rev=>inspectBomCoverage(root,entry,csvs[rev],parseCsv(csvs[rev]),rev),selection:rev=>loadBoardSelection(root,entry,csvs[rev],parseCsv(csvs[rev]),rev)};
}
test('two distinct selected revisions cover both native populations and never inherit selection',async t=>{
 const f=fixture(t);assert.equal(f.packets().ok,true);assert.equal(f.coverage('A').required_references,1);assert.equal(f.coverage('B').required_references,1);
 assert.equal((await f.selection('A')).references.has('U2'),false);assert.equal((await f.selection('B')).references.has('U1'),false);
 await assert.rejects(loadBoardSelection(f.root,f.entry,f.csvs.A,parseCsv(f.csvs.A),'B'),/supplied BOM differs from owned revision source/);
 assert.throws(()=>inspectBomCoverage(f.root,f.entry,f.csvs.A,parseCsv(f.csvs.A)),/explicit revision selector/);
});
test('all owner revisions require distinct complete safe selected records',async t=>{
 for(const [name,change]of Object.entries({
  'unknown policy':f=>f.entry.bom_policy='candidate','missing B':f=>delete f.entry.revisions[1].bom,'missing scope':f=>delete f.entry.revisions[1].bom_scope,
  'missing selection':f=>delete f.entry.revisions[1].selection,'shared BOM':f=>f.entry.revisions[1].bom=f.entry.revisions[0].bom,
  'shared scope':f=>f.entry.revisions[1].bom_scope=f.entry.revisions[0].bom_scope,'shared ledger':f=>f.entry.revisions[1].selection=f.entry.revisions[0].selection,
  'unsafe path':f=>f.entry.revisions[1].bom='../BOM-VERIFIED-B.csv','candidate masquerade':f=>f.entry.revisions[1].bom='CANDIDATE-BOM.csv',
  'empty B':f=>f.put(prefix+'/BOM-VERIFIED-B.csv',header),'stale scope':f=>{f.scopes.B.revision='A';f.put(prefix+'/scope-B.json',f.scopes.B);},
  'missing fitted B':f=>f.put(prefix+'/BOM-VERIFIED-B.csv',header+'U1,IC,PART-A,C123,1\n')}))await t.test(name,t=>{const f=fixture(t);change(f);assert.equal(f.packets().ok,false);});
});
test('revision CSV symlink cannot escape its board owner',t=>{
 const f=fixture(t),target=join(f.root,prefix,'BOM-VERIFIED-B.csv');f.put('hardware-design/boards/OTHER/stolen.csv',f.csvs.B);
 unlinkSync(target);symlinkSync(join(f.root,'hardware-design/boards/OTHER/stolen.csv'),target);
 assert.equal(f.packets().ok,false);assert.throws(()=>f.coverage('B'),/escapes owner/);
});
test('offline checker validates every selected revision and keeps candidate/stock/qualified states separate',async t=>{
 const f=fixture(t),repo=fileURLToPath(new URL('../..',import.meta.url));cpSync(join(repo,'tools'),join(f.root,'tools'),{recursive:true});
 for(const p of ['STATUS','REQUIREMENTS','DECISIONS','DOC-RECONCILIATION','BOARD-INDEX'])f.put('hardware-design/'+p+'.md','Synthetic documentation');
 for(const p of ['PLATFORM.md','MODULES.md','README.md'])f.put(p,'Synthetic documentation');
 f.put('hardware-design/registry/components.json',{candidates:[]});
 const run=()=>{let output;try{output=execFileSync(process.execPath,[join(f.root,'tools/check-consistency.mjs'),'--offline'],{cwd:f.root,encoding:'utf8'});}catch(e){assert.equal(e.status,1);output=e.stdout;}
  const summary=JSON.parse(output);return JSON.parse(readFileSync(join(f.root,summary.report),'utf8'));};
 const result=run();assert.equal(result.deterministic.rows_checked,2);assert.equal(result.ok,true);
 f.ledgers.B.parts[0].state=f.ledgers.B.state='stock-observed';f.put(prefix+'/selection-B.json',f.ledgers.B);
 const failed=run();assert.equal(failed.ok,false);assert.ok(failed.findings.some(x=>x.check==='bom_selection_evidence'&&x.detail.includes('revision B')));
 assert.equal(failed.deterministic.rows_checked,2);assert.ok(failed.findings.some(x=>x.check==='bom_registry_record'&&x.detail.includes('BOM-VERIFIED-B')));
 f.ledgers.B.parts[0].state=f.ledgers.B.state='electrically-selected';f.ledgers.B.stock_current=true;f.put(prefix+'/selection-B.json',f.ledgers.B);
 assert.ok(run().findings.some(x=>x.check==='bom_selection_evidence'));
});
