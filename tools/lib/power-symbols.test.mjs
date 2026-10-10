import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readPopulation,sha256} from './kicad-population.mjs';
import {inspectBomCoverage} from './bom-coverage.mjs';
import {parseCsv} from './csv.mjs';
const prefix='hardware-design/boards/X',project=prefix+'/cad/P';
const header='Designator,Function block,MPN/value,LCSC,Quantity\n';
function fixture(t,library='(symbol "rail" (power global))',partExtra='',libId='rail',pcbExtra='') {
 const root=mkdtempSync(join(tmpdir(),'power-bom-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(p,v)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),typeof v==='string'?v:JSON.stringify(v));};
 const pwr=`(symbol (lib_id "${libId}") (unit 1) (in_bom yes) (on_board yes) (dnp no)
 (property "Reference" "RAIL") ${partExtra} (instances (project "P" (path "/ROOT" (reference "RAIL") (unit 1)))))`;
 put(project+'.kicad_sch',`(kicad_sch (uuid ROOT) (lib_symbols ${library}) ${pwr}
 (symbol (lib_id "Part") (unit 1) (in_bom yes) (on_board yes) (dnp no)
 (property "Reference" "R1") (property "MPN" "RES") (property "LCSC" "C123") (property "Footprint" "Res")
 (instances (project "P" (path "/ROOT" (reference "R1") (unit 1))))))`);
 put(project+'.kicad_pcb',`(kicad_pcb (footprint "Res" (property "Reference" "R1") (property "MPN" "RES") (property "LCSC" "C123") (attr smd)) ${pcbExtra})`);
 put(prefix+'/SPEC.md','Synthetic test spec');put(prefix+'/review.md','Synthetic explicit power and fitted-part classification review');
 const csv=header+'R1,resistor,RES,C123,1\n',review=prefix+'/review.md';
 const native=()=>readPopulation(root,project);
 const scope={schema_version:1,board:'X',revision:'A',revision_spec:prefix+'/SPEC.md',spec_sha256:sha256('Synthetic test spec'),project,
 bom:prefix+'/BOM-VERIFIED.csv',bom_sha256:sha256(csv),source_hashes:native().sources,review_evidence:{[review]:sha256('Synthetic explicit power and fitted-part classification review')},native_population:'DEFAULT',
 classification:{R1:{kind:'component',reason:'actual fitted resistor',review,assembly_dependencies:[]},RAIL:{kind:'nonphysical',reason:'embedded native power marker, no physical part',review,assembly_dependencies:[]}},
 assembly:{review,basis:'Synthetic fixture has no external interface',bom:prefix+'/ASSEMBLY.csv',bom_sha256:sha256(header),requirements:[]}};
 put(scope.assembly.bom,header);put(prefix+'/scope.json',scope);
 const entry={directory:'X',revisions:[{revision:'A',spec:'SPEC.md',project:'cad/P',bom:'BOM-VERIFIED.csv',bom_scope:'scope.json'}]};
 return {root,native,scope,put,run:()=>inspectBomCoverage(root,entry,csv,parseCsv(csv))};
}
test('actual native power flag permits reviewed nonphysical coverage without changing raw flags',t=>{
 const f=fixture(t);assert.equal(f.native().symbols.get('RAIL').in_bom,true);assert.equal(f.run().required_references,1);
});
test('legacy and local power markers and inherited names are attributable',async t=>{
 for(const library of ['(symbol "rail" (power))','(symbol "rail" (power local))',
 '(symbol "base" (power global)) (symbol "rail" (extends "base"))',
 '(symbol "x:base" (power global)) (symbol "x:rail" (extends "base"))'])await t.test(library,t=>assert.equal(fixture(t,library,'',library.includes('x:rail')?'x:rail':'rail').run().required_references,1));
});
test('power-shaped names and reference text cannot exempt ordinary or unknown symbols',async t=>{
 for(const library of ['','(symbol "rail")'])await t.test(library||'missing',t=>assert.throws(()=>fixture(t,library).run(),/nonphysical classification/));
});
test('native power evidence cannot hide MPN, LCSC, footprint or actual PCB component',async t=>{
 for(const [name,extra,pcb] of [['MPN','(property "MPN" "REAL")',''],['LCSC','(property "LCSC" "C777")',''],
 ['footprint','(property "Footprint" "Land")',''],['PCB','','(footprint "Land" (property "Reference" "RAIL") (attr smd))']])
 await t.test(name,t=>assert.throws(()=>fixture(t,undefined,extra,'rail',pcb).run()));
});
test('malformed, ambiguous, cyclic and conflicting inheritance fail closed',async t=>{
 for(const library of ['(symbol "rail" (power wrong))','(symbol "rail" (power global extra))',
 '(symbol "rail" (power global) (power local))','(symbol "rail" (power global)) (symbol "rail")',
 '(symbol "rail" (power global) (property "Footprint" "Physical:Land"))',
 '(symbol "rail" (power global) (property "MPN" "PHYSICAL"))',
 '(symbol "base" (power global) (property "LCSC" "C123")) (symbol "rail" (extends "base"))',
 '(symbol "rail" (extends "missing"))','(symbol "rail" (extends "rail"))',
 '(symbol "base" (power global)) (symbol "mid" (extends "base")) (symbol "rail" (extends "mid") (power local))',
 '(symbol "base" (power global)) (symbol "x:base" (power global)) (symbol "x:rail" (extends "base"))'])
 await t.test(library,t=>assert.throws(()=>fixture(t,library,'',library.includes('x:rail')?'x:rail':'rail')));
});
test('real BASE A and explicit B native closure recognizes power symbols without selected-state promotion',()=>{
 const root=process.env.COVERAGE_TEST_REPO??fileURLToPath(new URL('../..',import.meta.url)),base='hardware-design/boards/BASE-PWR/cad/BASE-PWR-B/blocks/';
 const map=Object.fromEntries(['IF-RS485','IF-BKP-LINK-ESD','PSW-TPS2553'].map(n=>[base+n+'.kicad_sch','BASE-PWR']));
 for(const [rev,expected,mapping] of [['BASE-PWR',159,{}],['BASE-PWR-B',181,map]]) {
  const project=`hardware-design/boards/BASE-PWR/cad/${rev}/${rev}`,p=readPopulation(root,project,mapping);
  assert.equal([...p.symbols.values()].filter(x=>x.in_bom&&!x.footprint&&x.power_symbol).length,expected);
  assert.equal(p.symbols.get('#PWR001').power_symbol,true);assert.equal(p.symbols.get('U1').power_symbol,false);
  assert.ok(p.symbols.get('U1').mpn);assert.ok(!p.footprints.has('#PWR001'));
 }
});
test('power child cannot hide physical identities in ordinary ancestors',async t=>{
 for(const property of ['Footprint','MPN','LCSC'])await t.test(property,t=>{
  const value=property==='LCSC'?'C123':'Physical';
  const library=`(symbol "ordinary" (property "${property}" "${value}"))
   (symbol "middle" (extends "ordinary"))
   (symbol "rail" (power global) (extends "middle") (property "${property}" ""))`;
  assert.throws(()=>fixture(t,library),/conflicting physical identity/);
 });
});
test('fully qualified inherited parents must belong to the same embedded library',async t=>{
 await t.test('same namespace',t=>assert.equal(fixture(t,
  '(symbol "x:base" (power global)) (symbol "x:rail" (extends "x:base"))','','x:rail').run().required_references,1));
 for(const id of ['x:rail','rail'])await t.test(id,t=>assert.throws(()=>fixture(t,
  `(symbol "other:base" (power global)) (symbol "${id}" (extends "other:base"))`,'',id),/crosses library ownership/));
});
