import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,rmSync,symlinkSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {inspectBomCoverage} from './bom-coverage.mjs';
import {parseCsv} from './csv.mjs';
import {readPopulation,parseNative,sha256} from './kicad-population.mjs';
import {inspectPackets,FULL_PACKET} from './board-packets.mjs';

const repo=fileURLToPath(new URL('../..',import.meta.url));
const header='Designator,Function block,MPN/value,LCSC,Quantity,Population\n';
const symbol=(ref,path='/ROOT',extra='',unit=1)=>`(symbol (lib_id "Fixture:Part") (unit ${unit}) (in_bom yes) (on_board yes) (dnp no)
 (property "Reference" "${ref}") (property "Footprint" "Fixture:Part") (property "MPN" "PART") (property "LCSC" "C123") ${extra}
 (instances (project "PROJECT" (path "${path}" (reference "${ref}") (unit ${unit})))))`;
const footprint=(ref,attrs='smd')=>`(footprint "Fixture:Part" (property "Reference" "${ref}") (property "MPN" "PART") (property "LCSC" "C123") (attr ${attrs}))`;
function fixture(t) {
 const root=mkdtempSync(join(tmpdir(),'bom-coverage-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const prefix='hardware-design/boards/X',project=prefix+'/cad/PROJECT',review=prefix+'/reports/review.md';
 const put=(p,v)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 for(const p of FULL_PACKET) if(p!=='BOM-VERIFIED.csv') put(prefix+'/'+p,'Synthetic fixture document, no hardware or selection claim.');
 put(review,'Synthetic reviewed scope fixture; not a real engineering approval.');
 put(project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1')} ${symbol('J1')})`);
 put(project+'.kicad_pcb',`(kicad_pcb ${footprint('U1')} ${footprint('J1')})`);
 const entry={id:'X',kind:'board',lifecycle:'active',packet:'full',directory:'X',revisions:[{revision:'A',state:'layout',spec:'SPEC.md',project:'cad/PROJECT',bom:'BOM-VERIFIED.csv',bom_scope:'BOM-VERIFIED.scope.json'}]};
 let csv=header+'U1,IC,PART,C123,1,DEFAULT\nJ1,connector,PART,C123,1,DEFAULT\n';
 let assembly=header+'MATE-J1,mate,MATE,C456,2,DEFAULT\n';
 const scope={schema_version:1,board:'X',revision:'A',revision_spec:prefix+'/SPEC.md',spec_sha256:sha256(readFileSync(join(root,prefix+'/SPEC.md'))),
  project,bom:prefix+'/BOM-VERIFIED.csv',bom_sha256:sha256(csv),source_hashes:{},review_evidence:{[review]:sha256(readFileSync(join(root,review)))},
  native_population:'DEFAULT',classification:{U1:{kind:'component',reason:'Fixture IC',review,assembly_dependencies:[]},J1:{kind:'component',reason:'Fixture connector',review,assembly_dependencies:['MATE-J1']}},
  assembly:{review,basis:'Fixture requires two loose mating pieces; quantities are explicit.',bom:prefix+'/ASSEMBLY-BOM.csv',bom_sha256:sha256(assembly),requirements:[{reference:'MATE-J1',kind:'mate',mpn:'MATE',lcsc:'C456',quantity:2,populations:['DEFAULT'],for_references:['J1'],review}]}};
 const save=(refresh=true)=>{
  put(prefix+'/BOM-VERIFIED.csv',csv);if(scope.assembly) put(scope.assembly.bom,assembly);
  if(refresh){scope.bom_sha256=sha256(csv);if(scope.assembly) scope.assembly.bom_sha256=sha256(assembly);scope.source_hashes=readPopulation(root,scope.project).sources;
   if(entry.variants) scope.source_hashes[prefix+'/'+entry.variants.file]=sha256(readFileSync(join(root,prefix,entry.variants.file)));}
  put(prefix+'/BOM-VERIFIED.scope.json',scope);
 };
 const run=()=>inspectBomCoverage(root,entry,csv,parseCsv(csv));
 save();return {root,prefix,project,review,entry,scope,put,save,run,get csv(){return csv;},set csv(v){csv=v;},get assembly(){return assembly;},set assembly(v){assembly=v;}};
}

test('complete synthetic board and required mates pass packet coverage without implying selected state',t=>{
 const f=fixture(t);assert.equal(f.run().required_references,2);assert.equal(f.run().required_assembly_items,1);
 assert.equal(inspectPackets(f.root,{schema_version:1,boards:[f.entry]}).ok,true);
});
test('partial, duplicate, wrong-identity and wrong-quantity rows fail',async t=>{
 const cases={
  'omitted native':f=>{f.csv=header+'U1,IC,PART,C123,1,DEFAULT\n';},
  'duplicate native':f=>{f.csv+='U1,IC,PART,C123,1,DEFAULT\n';},
  'unlisted native':f=>{f.csv+='U9,IC,PART,C123,1,DEFAULT\n';},
  'MPN mismatch':f=>{f.csv=f.csv.replace('U1,IC,PART','U1,IC,OTHER');},
  'LCSC mismatch':f=>{f.csv=f.csv.replace('U1,IC,PART,C123','U1,IC,PART,C999');},
  'native quantity':f=>{f.csv=f.csv.replace('U1,IC,PART,C123,1','U1,IC,PART,C123,2');},
  'native classification omitted':f=>{delete f.scope.classification.J1;},
  'mate omitted':f=>{f.assembly=header;},
  'mate quantity reduced':f=>{f.assembly=f.assembly.replace('C456,2','C456,1');},
  'mate requirement silently removed':f=>{f.scope.assembly.requirements=[];f.assembly=header;},
  'native dependency silently removed':f=>{f.scope.classification.J1.assembly_dependencies=[];},
  'assembly scope absent':f=>{delete f.scope.assembly;},
 };
 for(const [name,mutate] of Object.entries(cases)) await t.test(name,tt=>{const f=fixture(tt);mutate(f);f.save();assert.throws(f.run);});
});
test('attribution, source bounds and revision ownership fail closed',async t=>{
 const cases={
  'scope not registered':f=>{delete f.entry.revisions[0].bom_scope;},
  'wrong revision':f=>{f.scope.revision='B';},
  'ambiguous revision owner':f=>{f.entry.revisions.push({...f.entry.revisions[0],revision:'B'});},
  'unknown lifecycle claim':f=>{f.scope.stock_current=true;},
  'unreviewed classification':f=>{f.scope.classification.U1.review=f.prefix+'/SPEC.md';},
  'review tampered':f=>{f.put(f.review,'changed');},
  'spec tampered':f=>{f.put(f.prefix+'/SPEC.md','changed');},
  'native closure incomplete':f=>{delete f.scope.source_hashes[f.project+'.kicad_sch'];},
  'native hash stale':f=>{f.scope.source_hashes[f.project+'.kicad_sch']='0'.repeat(64);},
  'BOM hash stale':f=>{f.scope.bom_sha256='0'.repeat(64);},
  'assembly hash stale':f=>{f.scope.assembly.bom_sha256='0'.repeat(64);},
  'review traversal':f=>{f.scope.classification.U1.review=f.prefix+'/../outside.md';},
 };
 for(const [name,mutate] of Object.entries(cases)) await t.test(name,tt=>{const f=fixture(tt);mutate(f);f.save(false);assert.throws(f.run);});
 await t.test('review symlink escapes owner',tt=>{const f=fixture(tt);f.put('outside.md','escape');rmSync(join(f.root,f.review));symlinkSync(join(f.root,'outside.md'),join(f.root,f.review));assert.throws(f.run,/escapes owner/);});
});
test('recursive repeated sheet instances use their own references and cannot be collapsed',t=>{
 const f=fixture(t),child=f.prefix+'/cad/part.kicad_sch';
 f.put(f.project+'.kicad_sch','(kicad_sch (uuid "ROOT") (sheet (uuid "A") (property "Sheetfile" "part.kicad_sch")) (sheet (uuid "B") (property "Sheetfile" "part.kicad_sch")))');
 f.put(child,`(kicad_sch (uuid "CHILD") (symbol (lib_id "Fixture:Part") (in_bom yes) (on_board yes) (dnp no)
  (property "Footprint" "Fixture:Part") (property "MPN" "PART") (property "LCSC" "C123")
  (instances (project "PROJECT" (path "/ROOT/A" (reference "U1") (unit 1)) (path "/ROOT/B" (reference "J1") (unit 1))))))`);
 f.save();assert.equal(f.run().native_references,2);assert.equal(Object.keys(f.scope.source_hashes).length,3);
 f.csv=header+'U1,IC,PART,C123,1,DEFAULT\n';f.save();assert.throws(f.run,/missing required references: J1/);
});
test('native schematic/PCB mismatch, missing footprints and duplicate units are rejected',async t=>{
 const cases={
  'identity disagreement':f=>{f.put(f.project+'.kicad_pcb',`(kicad_pcb ${footprint('U1').replace('"PART"','"OTHER"')} ${footprint('J1')})`);},
  'land identity disagreement':f=>{f.put(f.project+'.kicad_pcb',`(kicad_pcb ${footprint('U1').replace('Fixture:Part','Wrong:Land')} ${footprint('J1')})`);},
  'zero unit':f=>{f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1','/ROOT','',0)} ${symbol('J1')})`);},
  'noncanonical duplicate unit':f=>{f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1')} ${symbol('U1','/ROOT','','01')} ${symbol('J1')})`);},
  'placed unit disagrees':f=>{f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1').replace('(unit 1)','(unit 2)')} ${symbol('J1')})`);},
  'missing footprint':f=>{f.put(f.project+'.kicad_pcb',`(kicad_pcb ${footprint('U1')})`);},
  'duplicate symbol unit':f=>{f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1')} ${symbol('U1')} ${symbol('J1')})`);},
  'wrong project instance':f=>{f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1').replace('project "PROJECT"','project "OTHER"')} ${symbol('J1')})`);},
  'missing hierarchy instance':f=>{f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1','/WRONG')} ${symbol('J1')})`);},
 };
 for(const [name,mutate] of Object.entries(cases)) await t.test(name,tt=>{const f=fixture(tt);mutate(f);assert.throws(()=>{f.save();f.run();});});
});
test('multi-unit part merges only compatible different units',t=>{
 const f=fixture(t);f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1')} ${symbol('U1','/ROOT','',2)} ${symbol('J1')})`);
 f.save();assert.equal(f.run().required_references,2);
});
test('complete variant map binds every physical ref, DNP and assembly population',t=>{
 const f=fixture(t);f.entry.variants={file:'variants.json',names:['AIR','ALL']};
 f.scope.native_population='ALL';f.put(f.prefix+'/variants.json',{variants:['AIR','ALL'],fit:{U1:['ALL'],J1:['AIR','ALL']},dnp:[]});
 f.csv=header+'U1,IC,PART,C123,1,ALL\nJ1,connector,PART,C123,1,AIR;ALL\n';
 f.scope.assembly.requirements[0].populations=['AIR','ALL'];f.assembly=header+'MATE-J1,mate,MATE,C456,2,AIR;ALL\n';
 f.save();assert.deepEqual(f.run().populations,['AIR','ALL']);
 f.put(f.prefix+'/variants.json',{variants:['AIR','ALL'],fit:{U1:['ALL']}});f.save();assert.throws(f.run,/complete native population/);
});
test('native DNP exclusions are explicit; testpoint-looking references receive no implicit exemption',t=>{
 const f=fixture(t);f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1').replace('dnp no','dnp yes')} ${symbol('J1')} ${symbol('TP99')})`);
 f.put(f.project+'.kicad_pcb',`(kicad_pcb ${footprint('U1','smd dnp')} ${footprint('J1')} ${footprint('TP99')})`);
 f.scope.classification.U1.kind='dnp';f.scope.classification.TP99={kind:'component',reason:'Catalog part despite its ref name',review:f.review,assembly_dependencies:[]};
 f.csv=header+'J1,connector,PART,C123,1,DEFAULT\n';f.save();assert.throws(f.run,/missing required references: TP99/);
 f.csv+='TP99,part,PART,C123,1,DEFAULT\n';f.save();assert.equal(f.run().required_references,2);
 f.scope.classification.TP99.kind='fabrication-feature';f.save();assert.throws(f.run,/native exclusion\/board-only evidence/);
});
test('empty catalog fields do not turn a native fitted BOM part into a fabrication feature',t=>{
 const f=fixture(t);
 f.put(f.project+'.kicad_sch',`(kicad_sch (uuid "ROOT") ${symbol('U1').replace('(property "MPN" "PART")','').replace('(property "LCSC" "C123")','')} ${symbol('J1')})`);
 f.put(f.project+'.kicad_pcb',`(kicad_pcb ${footprint('U1').replace('(property "MPN" "PART")','').replace('(property "LCSC" "C123")','')} ${footprint('J1')})`);
 f.scope.classification.U1.kind='fabrication-feature';f.csv=header+'J1,connector,PART,C123,1,DEFAULT\n';
 f.save();assert.throws(f.run,/native exclusion\/board-only evidence/);
});
test('PCB BOM and board-only flags cannot disagree with a fitted selected component',async t=>{
 for(const attr of ['smd exclude_from_bom','smd board_only']) await t.test(attr,t=>{
  const f=fixture(t);f.put(f.project+'.kicad_pcb',`(kicad_pcb ${footprint('U1',attr)} ${footprint('J1')})`);
  f.save();assert.throws(f.run,/PCB flags disagree/);
 });
});
test('unqualified required mates cover every owner variant and duplicate headers fail',t=>{
 const f=fixture(t);f.entry.variants={file:'variants.json',names:['AIR','ALL']};f.scope.native_population='ALL';
 f.put(f.prefix+'/variants.json',{variants:['AIR','ALL'],fit:{U1:['AIR','ALL'],J1:['AIR','ALL']}});
 f.csv=header+'U1,IC,PART,C123,1,AIR;ALL\nJ1,connector,PART,C123,1,AIR;ALL\n';
 f.scope.assembly.requirements[0].populations=['AIR'];f.assembly=header+'MATE-J1,mate,MATE,C456,2,AIR\n';
 f.save();assert.throws(f.run,/every native owner population/);
 f.scope.assembly.requirements[0].populations=['AIR','ALL'];f.assembly=header+'MATE-J1,mate,MATE,C456,2,AIR;ALL\n';
 f.csv=f.csv.replace('Quantity,Population','Quantity,Population,Population').replaceAll('1,AIR;ALL','1,AIR;ALL,AIR;ALL');
 f.save();assert.throws(f.run,/headers must be nonempty and unique/);
});
test('custom harness definition is attributable without inventing a JLC C-number',t=>{
 const f=fixture(t),def=f.prefix+'/assembly/harness.json',item=f.scope.assembly.requirements[0];
 f.put(def,{schema_version:1,reference:'MATE-J1',mpn:'HARNESS-1',materials:[{mpn:'WIRE-1',quantity:2}]});
 Object.assign(item,{kind:'harness',mpn:'HARNESS-1',lcsc:'',definition:def,definition_sha256:sha256(readFileSync(join(f.root,def)))});
 f.assembly=header+'MATE-J1,harness,HARNESS-1,,2,DEFAULT\n';f.save();assert.equal(f.run().required_assembly_items,1);
 f.put(def,{schema_version:1,reference:'MATE-J1',mpn:'HARNESS-1',materials:[]});f.save();assert.throws(f.run,/materials\/hash/);
});
test('strict native parser rejects malformed roots, strings and escaping hierarchy',t=>{
 for(const raw of ['(root','(root))','(root) (other)','outside (root)','(root "unfinished)','(root "bad\\q")'])assert.throws(()=>parseNative(raw));
 const f=fixture(t);f.put(f.project+'.kicad_sch','(kicad_sch (uuid "ROOT") (sheet (uuid "A") (property "Sheetfile" "../../../outside.kicad_sch")))');
 f.put('outside.kicad_sch','(kicad_sch (uuid "CHILD"))');assert.throws(()=>readPopulation(f.root,f.project));
});
test('actual AC fourteen-part geometry rejects a one-row selected BOM even with a complete synthetic scope',t=>{
 const f=fixture(t),prefix='hardware-design/boards/AC-24V',project=prefix+'/cad/AC-24V/AC-24V';
 cpSync(join(repo,prefix,'cad/AC-24V'),join(f.root,prefix,'cad/AC-24V'),{recursive:true});
 f.put(prefix+'/SPEC.md',readFileSync(join(repo,prefix,'SPEC.md'),'utf8'));
 const review=prefix+'/reports/fixture.md';f.put(review,'Synthetic negative fixture; does not select or approve any AC component.');
 const native=readPopulation(f.root,project);assert.equal([...native.symbols.values()].filter(p=>p.footprint).length,14);
 const scope=f.scope;scope.board='AC-24V';scope.revision_spec=prefix+'/SPEC.md';scope.spec_sha256=sha256(readFileSync(join(f.root,scope.revision_spec)));
 scope.project=project;scope.bom=prefix+'/BOM-VERIFIED.csv';scope.review_evidence={[review]:sha256(readFileSync(join(f.root,review)))};
 scope.classification={};for(const ref of new Set([...native.symbols.keys(),...native.footprints.keys()])) {
  const p=native.symbols.get(ref);scope.classification[ref]={kind:p?(p.footprint?'component':'nonphysical'):'fabrication-feature',reason:'Explicit synthetic classification for negative regression only',review,assembly_dependencies:[]};
 }
 scope.classification.J1.assembly_dependencies=['AC-MATE'];
 for(const ref of ['J2','J3','J4']) scope.classification[ref].assembly_dependencies=['DC-MATES'];
 const assembly=header+'AC-MATE,fixture candidate,WJ2EDGK-5.08-02P-14-00A,C71370,1,DEFAULT\nDC-MATES,fixture candidate,MX15EDGK-3.5-02P-GN01-Cu-Y-A,C5188249,3,DEFAULT\n';
 scope.assembly={review,basis:'Synthetic negative fixture uses the four recorded loose-plug candidates; no selection or harness qualification.',bom:prefix+'/ASSEMBLY-BOM.csv',bom_sha256:sha256(assembly),requirements:[
  {reference:'AC-MATE',kind:'mate',mpn:'WJ2EDGK-5.08-02P-14-00A',lcsc:'C71370',quantity:1,populations:['DEFAULT'],for_references:['J1'],review},
  {reference:'DC-MATES',kind:'mate',mpn:'MX15EDGK-3.5-02P-GN01-Cu-Y-A',lcsc:'C5188249',quantity:3,populations:['DEFAULT'],for_references:['J2','J3','J4'],review}]};
 const csv=header+'U1,module,IRM-60-24,C41434963,1,DEFAULT\n';scope.bom_sha256=sha256(csv);scope.source_hashes=native.sources;
 const entry={directory:'AC-24V',revisions:[{revision:'A',spec:'SPEC.md',project:'cad/AC-24V/AC-24V',bom:'BOM-VERIFIED.csv',bom_scope:'BOM-VERIFIED.scope.json'}]};
 f.put(scope.assembly.bom,assembly);f.put(prefix+'/BOM-VERIFIED.scope.json',scope);
 assert.throws(()=>inspectBomCoverage(f.root,entry,csv,parseCsv(csv)),/missing required references:/);
 for(const ref of Object.keys(scope.classification))if(ref!=='U1' && scope.classification[ref].kind==='component') {
  scope.classification[ref].kind='excluded';scope.classification[ref].assembly_dependencies=[];
 }
 f.put(prefix+'/BOM-VERIFIED.scope.json',scope);assert.throws(()=>inspectBomCoverage(f.root,entry,csv,parseCsv(csv)),/exclusion lacks native/);
});
