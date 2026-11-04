import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {verifyReleaseGate,verifyFab,sha256,fileHashes,releaseRecipe,verifyBoardChecks,readGateObservation,releaseInputs,probeReleaseTools} from './release-evidence.mjs';
import {happyRuntime} from './env.mjs';
import {fileURLToPath} from 'node:url';
import {inspectStock,inspectOrientation,releaseReadiness,inspectCompleteAssembly} from './release-readiness.mjs';
import {gateInputs,fingerprint} from './gate-inputs.mjs';

// The release recipes of the shipping boards, from their gate.json (the fixture copies them).
const repo=fileURLToPath(new URL('../..',import.meta.url));
const RECIPES=Object.fromEntries(['BASE-PWR','ENV-SENSE'].map(b=>[b,releaseRecipe(repo,b)]));
function fixture(t,board='BASE-PWR') {
 const root=mkdtempSync(join(tmpdir(),'release-evidence-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(path,value)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value));};
 const prefix=`hardware-design/boards/${board}`,project=prefix+`/cad/${board}/${board}`,gate=join(root,'candidate/gate'),fab=join(root,'candidate/fab');
 const checks={erc:true,drc:true,paths:'current-paths.json',viapads:{},kicad_happy:{},port_labels:true};
 put(prefix+'/gate.json',{project:`cad/${board}/${board}`,checks,release:RECIPES[board]});
 put(project+'.kicad_sch','(kicad_sch (uuid "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") (symbol (lib_id "Device:R") (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") (property "Reference" "R1") (property "Value" "10R") (property "Footprint" "iot-lab:C123") (property "LCSC" "C123")))');
 put(project+'.kicad_pcb','(kicad_pcb (layers (0 "F.Cu" signal)(31 "B.Cu" signal)) (footprint "iot-lab:C123" (layer "F.Cu") (at 10 20 -90) (property "Reference" "R1") (property "LCSC" "C123") (attr smd)))');
 const erc={sheets:[{violations:[]}]},drc={violations:[],schematic_parity:[],unconnected_items:[]};
 put('candidate/gate/erc.json',erc);put('candidate/gate/drc.json',drc);
 const metrics={erc_errors:0,erc_warnings:0,drc_errors:0,drc_warnings:0,drc_parity:0,drc_unconnected:0,paths_low:0,viapads:0,kicad_happy_findings:0,port_label_failures:0};
 const events=[{type:'gate.start',board,project:`cad/${board}/${board}`}];
 for(const stage of Object.keys(checks))events.push({type:'tool.exit',stage,code:0},{type:'check.end',stage,status:'passed'});
 events.push({type:'gate.end',exit:0,changedDuringRun:false});put('candidate/gate/events.jsonl',events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const result={exit:0,changedDuringRun:false,metrics,provenance:fingerprint(root,gateInputs(root,board).files,{kicad:'fixture',node:process.version})};
 put('candidate/gate/result.json',result);
 for(const layer of [...(RECIPES[board].copper),'F_Mask','B_Mask','F_Paste','B_Paste','F_Silkscreen','B_Silkscreen','Edge_Cuts'])put(`candidate/fab/gerber/${board}-${layer}.gbr`,'gerber fixture');
 for(const drill of ['PTH','NPTH'])put(`candidate/fab/gerber/${board}-${drill}.drl`,'drill fixture');
 put(`candidate/fab/${board}-gerber.zip`,'zip fixture');
 const populations=RECIPES[board].variants??['DEFAULT'];
 if(board==='ENV-SENSE') {
  put(prefix+'/variants.json',{variants:populations,fit:{R1:populations}});
  result.provenance=fingerprint(root,gateInputs(root,board).files,result.provenance.tools);put('candidate/gate/result.json',result);
 }
 for(const pop of populations) {
  const name=board+(pop==='DEFAULT'?'':'-'+pop);
  put(`candidate/fab/${name}-BOM-JLC.csv`,'Comment,Designator,Footprint,LCSC Part #\n10R,R1,iot-lab:C123,C123\n');
  put(`candidate/fab/${name}-CPL-JLC.csv`,'Designator,Mid X,Mid Y,Layer,Rotation\nR1,10mm,-20mm,Top,270\n');
 }
 const candidate=join(root,'candidate');
 const finish=()=>{
  const evidence=verifyReleaseGate(root,board,gate),assembly=verifyFab(root,board,fab);
  put('candidate/fab/VERIFIED','CAD/fabrication only');
  if(board==='BASE-PWR')put('candidate/audit/base-pwr-pcb-audit.json',{board,ok:true,passed:1,total:1,checks:[{ok:true}]});
  else {put('candidate/env-pcb.json',{fails:[]});put('candidate/env-schematic.log','OK datasheet nets: fixture\nOK every part has a variant entry\n');}
  const board_checks=verifyBoardChecks(board,candidate,root);
  const manifest={schema_version:1,board,revision:'A',scope:'cad_fabrication_candidate',input_sha256:evidence.input_sha256,gate_token:evidence.token,assembly,board_checks,artifacts:fileHashes(candidate),g5_ready:false,g6_qualified:false};
  put('candidate/release-manifest.json',manifest);return manifest;
 };
 return {root,board,prefix,project,gate,fab,candidate,put,result,events,finish};
}

test('release provenance names the kicad-happy runtime, not a Python on this host',t=>{
 const tool=join(mkdtempSync(join(tmpdir(),'release-tools-')),'tool');t.after(()=>rmSync(join(tool,'..'),{recursive:true,force:true}));
 writeFileSync(tool,'#!/bin/sh\necho 10.0.6\n',{mode:0o755});
 const paths={kicadCli:tool,kicadPython:tool,pinnedRepos:[]};
 const tools=probeReleaseTools(paths,{erc:true,drc:true,paths:'paths.json',viapads:{},port_labels:true,kicad_happy:{}});
 assert.deepEqual(tools,{kicad:'10.0.6',kicad_happy_runtime:happyRuntime(),node:process.version});
 assert.equal(probeReleaseTools(paths,{erc:true,planes:'planes.json'}).pcbnew,'10.0.6');
 assert.throws(()=>probeReleaseTools(paths),/gate checks required/);
});

test('both shipping boards have native/fabrication release recipes and exact population coverage',t=>{
 for(const board of ['BASE-PWR','ENV-SENSE']) {
  const f=fixture(t,board),result=verifyFab(f.root,board,f.fab);
  assert.deepEqual(Object.keys(result.populations),RECIPES[board].variants??['DEFAULT']);
  for(const p of Object.values(result.populations))assert.deepEqual(p.references,{R1:'C123'});
  assert.match(result.rotation_scope,/supplier package orientation/);
 }
});
test('measured export helper is sealed as an exact release input',t=>{
 const f=fixture(t);f.put('tools/pcb_timing.ts','original timing helper');
 const first=releaseInputs(f.root,f.board);
 assert.equal(first['tools/pcb_timing.ts'],sha256('original timing helper'));
 f.put('tools/pcb_timing.ts','changed timing helper');
 assert.notEqual(releaseInputs(f.root,f.board)['tools/pcb_timing.ts'],first['tools/pcb_timing.ts']);
});
for(const [name,replacement] of [['X coordinate','R1,11mm,-20mm,Top,270'],['Y sign','R1,10mm,20mm,Top,270'],['side','R1,10mm,-20mm,Bottom,270'],['rotation','R1,10mm,-20mm,Top,90'],['angle range','R1,10mm,-20mm,Top,-90'],['duplicate','R1,10mm,-20mm,Top,270\nR1,10mm,-20mm,Top,270']])test('staged CPL rejects '+name,t=>{
 const f=fixture(t);f.put('candidate/fab/BASE-PWR-CPL-JLC.csv','Designator,Mid X,Mid Y,Layer,Rotation\n'+replacement+'\n');
 assert.throws(()=>verifyFab(f.root,f.board,f.fab),/CPL/);
});
test('heterogeneous ENV BOM rows cannot masquerade as verified assembly identities',t=>{
 const f=fixture(t,'ENV-SENSE');f.put('candidate/fab/ENV-SENSE-ALL-BOM-JLC.csv','Comment,Designator,Footprint,LCSC Part #\n"10R,20R",R1,"iot-lab:C123,iot-lab:C456","C123,C456"\n');
 assert.throws(()=>verifyFab(f.root,f.board,f.fab),/one exact LCSC/);
});
test('native gate evidence rejects changed input, tool, process lifecycle and report contents',t=>{
 const f=fixture(t);assert.ok(verifyReleaseGate(f.root,f.board,f.gate).token);
 assert.throws(()=>verifyReleaseGate(f.root,f.board,f.gate,{}, {},{kicad:'changed',node:process.version}),/tool versions/);
 f.put(f.project+'.kicad_dru','changed');assert.throws(()=>verifyReleaseGate(f.root,f.board,f.gate),/inputs have changed/);
 rmSync(join(f.root,f.project+'.kicad_dru'));
 f.events.find(e=>e.type==='tool.exit').code=2;f.put('candidate/gate/events.jsonl',f.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 assert.throws(()=>verifyReleaseGate(f.root,f.board,f.gate),/did not complete/);
 f.events.find(e=>e.type==='tool.exit').code=0;f.put('candidate/gate/events.jsonl',f.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 f.put('candidate/gate/drc.json',{violations:[{severity:'error'}],schematic_parity:[],unconnected_items:[]});
 assert.throws(()=>verifyReleaseGate(f.root,f.board,f.gate),/disagree/);
});
test('diagnostic observation preserves a failed shared verdict and cannot satisfy release',t=>{
 const f=fixture(t),tools=f.result.provenance.tools;f.result.exit=1;f.result.metrics.paths_low=null;
 f.put('candidate/gate/result.json',f.result);
 const path=f.events.find(e=>e.type==='check.end' && e.stage==='paths');path.status='error';
 f.events.find(e=>e.type==='tool.exit' && e.stage==='paths').code=1;f.events.at(-1).exit=1;
 f.put('candidate/gate/events.jsonl',f.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
 assert.equal(readGateObservation(f.root,f.board,f.gate,{}, {},tools).at_targets,false);
 assert.throws(()=>verifyReleaseGate(f.root,f.board,f.gate),/not at release targets/);
 assert.throws(()=>readGateObservation(f.root,f.board,f.gate),/current tool/);
});
test('stock requires original exact-source responses, candidate identity, quantity and order-day attribution',t=>{
 const f=fixture(t),manifest=f.finish(),stock=join(f.root,'stock');
 const raw=JSON.stringify({data:{componentPageInfo:{list:[{componentCode:'C123',componentModelEn:'MPN-123',stockCount:5}]}}});
 f.put('stock/C123.json',raw);
 const receipt={schema_version:1,board:f.board,candidate_sha256:sha256(readFileSync(join(f.candidate,'release-manifest.json'))),source_url:'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList',order_day_utc:'2026-10-15',boards:5,parts:{C123:{required:5,fetched_at_utc:'2026-10-15T12:00:00Z',response:'C123.json',response_sha256:sha256(raw)}}};
 f.put('stock/stock.json',receipt);
 assert.equal(inspectStock(f.candidate,manifest,stock,{asOf:'2026-10-15',boards:5}).status,'passed');
 assert.throws(()=>inspectStock(f.candidate,manifest,stock,{asOf:'2026-10-15',boards:5,models:{C123:'OTHER-MPN'}}),/MPN differs/);
 assert.throws(()=>inspectStock(f.candidate,manifest,stock,{asOf:'2026-10-16',boards:5}),/order day/);
 f.put('stock/C123.json',raw+' ');assert.throws(()=>inspectStock(f.candidate,manifest,stock,{asOf:'2026-10-15',boards:5}),/hash mismatch/);
});
test('supplier orientation requires every population/reference and hashed review evidence',t=>{
 const f=fixture(t,'ENV-SENSE'),manifest=f.finish();f.put('review/preview.png','review evidence');
 const review={schema_version:1,board:f.board,revision:'A',candidate_sha256:sha256(readFileSync(join(f.candidate,'release-manifest.json'))),reviewer:'Reviewer',reviewed_at_utc:'2026-10-15T12:00:00Z',placements:['VIB','AIR','ALL'].map(population=>({population,reference:'R1',lcsc:'C123',orientation_verified:true,evidence:'preview.png',evidence_sha256:sha256('review evidence')}))};
 f.put('review/orientation.json',review);const path=join(f.root,'review/orientation.json');
 assert.equal(inspectOrientation(f.candidate,manifest,path).placements,3);
 review.placements.pop();f.put('review/orientation.json',review);assert.throws(()=>inspectOrientation(f.candidate,manifest,path),/every fitted/);
});
test('complete assembly availability cannot omit required harness, contact or battery scope',t=>{
 const f=fixture(t),manifest=f.finish(),entry={directory:f.board,revisions:[{revision:'A',bom:'BOM-VERIFIED.csv',bom_scope:'scope.json'}]};
 f.put(f.prefix+'/scope.json',{assembly:{requirements:[{reference:'HARNESS1',mpn:'EXACT-HARNESS',lcsc:'',quantity:2}]}});
 const stock=join(f.root,'stock');f.put('stock/supplier.html','original supplier evidence');
 const receipt={schema_version:1,board:f.board,candidate_sha256:sha256(readFileSync(join(f.candidate,'release-manifest.json'))),order_day_utc:'2026-10-15',boards:5,reviewer:'Reviewer',items:[{reference:'HARNESS1',mpn:'EXACT-HARNESS',lcsc:'',available_quantity:10,observed_at_utc:'2026-10-15T12:00:00Z',source_url:'https://supplier.example/item',evidence:'supplier.html',evidence_sha256:sha256('original supplier evidence')}]};
 f.put('stock/assembly.json',receipt);const args={asOf:'2026-10-15',boards:5};
 assert.equal(inspectCompleteAssembly(f.root,entry,f.candidate,manifest,stock,args).items,1);
 receipt.items[0].available_quantity=9;f.put('stock/assembly.json',receipt);
 assert.throws(()=>inspectCompleteAssembly(f.root,entry,f.candidate,manifest,stock,args),/availability/);
 receipt.items=[];f.put('stock/assembly.json',receipt);assert.throws(()=>inspectCompleteAssembly(f.root,entry,f.candidate,manifest,stock,args),/every required/);
});
test('an empty candidate, a publication claim in progress or left by a crash, is blocked',async t=>{
 const f=fixture(t);f.finish();f.put('hardware-design/registry/boards.json',{schema_version:1,boards:[]});const claim=join(f.root,'claim');mkdirSync(claim);
 const result=await releaseReadiness(f.root,f.board,claim,{asOf:'2026-10-15'});
 assert.equal(result.status,'blocked');assert.equal(result.checks.cad_fabrication.status,'blocked');assert.match(result.checks.cad_fabrication.cause,/release-manifest\.json/);
});
test('CAD/fab success never converts missing verified BOM/stock/review into order readiness',async t=>{
 const f=fixture(t);f.finish();f.put('hardware-design/registry/boards.json',{schema_version:1,boards:[{id:f.board,directory:f.board,kind:'board',lifecycle:'active',packet:'full',revisions:[{revision:'A',spec:'SPEC.md',state:'candidate',gate:f.board,project:'cad/BASE-PWR/BASE-PWR'}]}]});
 f.put(f.prefix+'/SPEC.md','spec');f.put(f.prefix+'/BOM-VERIFIED.csv','Designator,Function block,MPN/value,LCSC\n');
 const result=await releaseReadiness(f.root,f.board,f.candidate,{asOf:'2026-10-15'});
 assert.equal(result.checks.cad_fabrication.status,'passed');assert.equal(result.status,'blocked');
 assert.equal(result.checks.packet.status,'blocked');assert.equal(result.checks.selected_bom.status,'blocked');assert.equal(result.checks.assembly_stock.status,'blocked');assert.equal(result.checks.supplier_orientation.status,'blocked');assert.equal(result.g6_qualified,false);
});
test('release artifact hashes reject escaping symbolic links',t=>{
 const f=fixture(t);symlinkSync(join(f.root,f.project+'.kicad_pcb'),join(f.fab,'linked'));
 assert.throws(()=>fileHashes(f.candidate),/symbolic links/);
});
test('atomic publication refuses an existing empty destination without nesting or replacement',t=>{
 const f=fixture(t),destination=join(f.root,'destination');mkdirSync(destination);
 const command=new URL('../publish-release.mjs',import.meta.url).pathname;
 const failed=spawnSync(process.execPath,[command,f.candidate,destination],{encoding:'utf8'});assert.notEqual(failed.status,0);
 assert.ok(readFileSync(join(f.candidate,'gate/result.json')));rmSync(destination,{recursive:true});
 const passed=spawnSync(process.execPath,[command,f.candidate,destination],{encoding:'utf8'});assert.equal(passed.status,0,passed.stderr);assert.ok(readFileSync(join(destination,'gate/result.json')));
});
test('BASE exporter honors staged output and the chosen KiCad executable without replacing canonical files',t=>{
 const f=fixture(t),tools=join(f.root,'tools');mkdirSync(tools,{recursive:true});
 writeFileSync(join(tools,'make-base-pwr-fab.sh'),readFileSync(new URL('../make-base-pwr-fab.sh',import.meta.url)));
 writeFileSync(join(tools,'pack-fab.py'),readFileSync(new URL('../pack-fab.py',import.meta.url)));
 f.put(f.prefix+'/cad/fab/keep','canonical artifact');
 const fake=join(f.root,'fake-kicad');writeFileSync(fake,'#!/usr/bin/env python3\nimport pathlib,sys\na=sys.argv[1:];p=pathlib.Path(a[a.index("-o")+1])\nif str(p).endswith("gerber"):\n p.mkdir(exist_ok=True);(p/"fixture.gbr").write_text("fixture")\nelse:\n p.parent.mkdir(parents=True,exist_ok=True);p.write_text("Ref,Val,Package,PosX,PosY,Rot,Side\\nR1,10R,0603,10,-20,-90,top\\n")\n',{mode:0o755});
 const out=join(f.root,'new-fab'),render=join(f.root,'new-renders'),env={...process.env,FAB_OUT:out,RENDER_OUT:render,KICAD_CLI:fake};
 const result=spawnSync('sh',[join(tools,'make-base-pwr-fab.sh')],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 assert.equal(readFileSync(join(f.root,f.prefix,'cad/fab/keep'),'utf8'),'canonical artifact');assert.ok(readFileSync(join(out,'EXPLORATORY')));
 const before=fileHashes(out),again=spawnSync('sh',[join(tools,'make-base-pwr-fab.sh')],{env,encoding:'utf8'});assert.notEqual(again.status,0);assert.deepEqual(fileHashes(out),before);
});
test('fabrication packaging is deterministic and never overwrites existing archives',t=>{
 const f=fixture(t),helper=new URL('../pack-fab.py',import.meta.url).pathname;
 const a=join(f.root,'one.zip'),b=join(f.root,'two.zip');
 for(const destination of [a,b]){const r=spawnSync('python3',[helper,join(f.fab,'gerber'),destination],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
 assert.deepEqual(readFileSync(a),readFileSync(b));const before=readFileSync(a);
 assert.notEqual(spawnSync('python3',[helper,join(f.fab,'gerber'),a],{encoding:'utf8'}).status,0);assert.deepEqual(readFileSync(a),before);
});
test('a board without a release entry in its gate config fails with a clear message',t=>{
 const f=fixture(t);f.put(f.prefix+'/gate.json',{project:`cad/${f.board}/${f.board}`,checks:{erc:true}});
 assert.equal(releaseRecipe(f.root,f.board),null);
 assert.throws(()=>releaseInputs(f.root,f.board),/has no "release" entry/);
 assert.throws(()=>verifyFab(f.root,f.board,f.fab),/has no "release" entry/);
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('../release-recipe.mjs',import.meta.url)),f.board,'shell'],{cwd:f.root,encoding:'utf8'});
 assert.equal(r.status,2);assert.match(r.stderr,/FAIL: unsupported board: BASE-PWR has no "release" entry/);
});
