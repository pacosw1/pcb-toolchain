import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeFindings,logFindings,findingsDocument,loadFindingsBaseline} from './gate-findings.mjs';

test('native findings preserve locations, rule evidence, refs and nets with stable object identity',()=>{
 const violation={type:'clearance',severity:'error',description:"Clearance (netclass 'Default'; clearance 0.2 mm; actual 0.1 mm)",items:[{uuid:'pad-1',description:'Pad 1 [/SIG] of U3 on F.Cu',pos:{x:2,y:4}},{uuid:'via-1',description:'Via [GND]',pos:{x:2.1,y:4}}]};
 const report={coordinate_units:'mm',violations:[violation],schematic_parity:[],unconnected_items:[]};
 const [found]=nativeFindings(report,'drc');
 assert.equal(found.rule,'clearance');assert.deepEqual(found.refs,['U3']);assert.deepEqual(found.nets,['/SIG','GND']);
 assert.deepEqual(found.location,{x:2,y:4,unit:'mm'});assert.deepEqual(found.measured,{value:0.1,unit:'mm'});
 assert.deepEqual(found.required,{name:'clearance',value:0.2,unit:'mm'});assert.deepEqual(found.source,{kind:'netclass',name:'Default'});
 assert.deepEqual(found.evidence,{path:'drc.json',pointer:'/violations/0'});
 violation.description=violation.description.replace('0.1 mm','0.15 mm');violation.items.reverse();
 assert.equal(nativeFindings(report,'drc')[0].id,found.id);
 const unknown=nativeFindings({sheets:[{violations:[{severity:'warning',description:'Unspecified warning'}]}]},'erc')[0];
 for(const key of ['location','measured','required','source','refs','nets']) assert.equal(key in unknown,false,key);
});
test('checker logs preserve explicit values and omit unavailable thresholds and units',()=>{
 const text='LOW /PWR U1.4->J1.1: 0.50 A < 1 A; thin neck\nWARN unproved-fastest-edge F.Cu /CLK: missing source\nFAIL detour B.Cu /SIG: at (1.5, 2.5), no path';
 const rows=logFindings(text,'paths');
 assert.equal(rows.length,3);assert.deepEqual(rows[0].refs,['J1','U1']);assert.deepEqual(rows[0].nets,['/PWR']);
 assert.deepEqual(rows[0].measured,{value:0.5,unit:'A'});assert.equal(rows[0].required.value,1);
 const warning=logFindings(text,'planes')[1];assert.equal(warning.severity,'warning');assert.deepEqual(warning.nets,['/CLK']);assert.equal('required' in warning,false);
 const located=logFindings(text,'planes')[2];assert.deepEqual(located.location,{x:1.5,y:2.5});assert.equal('unit' in located.location,false);
});
test('explicit findings deltas never resolve a finding in a blocked stage',t=>{
 const root=mkdtempSync(join(tmpdir(),'findings-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'drc.json'),JSON.stringify({violations:[],schematic_parity:[],unconnected_items:[]}));
 const prior={schema_version:1,board:'X',project:'cad/X',findings:[{id:'fixed',stage:'drc'},{id:'not-checked',stage:'planes'}]};
 mkdirSync(join(root,'prior'));writeFileSync(join(root,'prior/findings.json'),JSON.stringify(prior));
 const baseline=loadFindingsBaseline(join(root,'prior'),'X','cad/X');
 const report=findingsDocument({board:'X',project:'cad/X',evidenceDir:root,baseline,checks:{drc:{status:'passed'},planes:{status:'blocked',cause:'parity'}}});
 assert.equal(report.complete,false);assert.deepEqual(report.completed_checks,['drc']);
 assert.deepEqual(report.delta.resolved.map(row=>row.id),['fixed']);assert.deepEqual(report.delta.unverified.map(row=>row.id),['not-checked']);
 assert.equal(report.findings[0].rule,'dependency-blocked');
 assert.throws(()=>loadFindingsBaseline(join(root,'prior'),'Y','cad/X'),/incompatible/);
});
test('invalid input evidence cannot resolve baseline findings or serve as a new baseline',t=>{
 const root=mkdtempSync(join(tmpdir(),'findings-invalid-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'drc.json'),JSON.stringify({violations:[],schematic_parity:[],unconnected_items:[]}));
 const report=findingsDocument({board:'X',project:'cad/X',evidenceDir:root,checks:{drc:{status:'passed'}},inputsValid:false,
   baseline:{path:'explicit prior evidence',findings:[{id:'previous',stage:'drc'}]}});
 assert.equal(report.complete,false);assert.deepEqual(report.completed_checks,[]);assert.deepEqual(report.delta.resolved,[]);
 assert.equal(report.delta.unverified[0].id,'previous');
 writeFileSync(join(root,'findings.json'),JSON.stringify(report));
 assert.throws(()=>loadFindingsBaseline(root,'X','cad/X'),/incompatible/);
});
