import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {loadBoardSelection} from './board-selections.mjs';
import {parseCsv} from './board-packets.mjs';

const sha=v=>createHash('sha256').update(v).digest('hex');
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'board-selection-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(path,value)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value));};
  const prefix='hardware-design/boards/PQ-METER';
  const entry={directory:'PQ-METER',revisions:[{revision:'A',spec:'SPEC.md',bom:'BOM-VERIFIED.csv',selection:'BOM-VERIFIED.selection.json'},{revision:'B',spec:'SPEC-REV-B.md'}]};
  const csv='Designator,Function block,MPN/value,LCSC\nU1,AFE,ADE9000ACPZ,C578974\nU2,AFE,ADE9000ACPZ,C578974\n';
  const raw={expected_lcsc:'C578974',identity_matched:true,stock_verified:true,fetched_at_utc:'2026-09-26T00:00:00Z',source_sha256:sha('historical source'),purchase_record:{componentModelEn:'ADE9000ACPZ',componentCode:'C578974'}};
  const json=JSON.stringify(raw);
  put('hardware-design/registry/evidence/part.json',json);put('hardware-design/registry/evidence/part.html','historical source');
  put('hardware-design/registry/datasheets/part.pdf','original PDF');
  put('hardware-design/registry/datasheets/part.pdf.source.json',{sha256:sha('original PDF'),source_url:'https://manufacturer.example/part.pdf',fetched_at_utc:'2026-09-26T00:00:00Z'});
  put(prefix+'/SPEC.md','Revision A specification');put(prefix+'/SPEC-REV-B.md','Revision B specification');
  put(prefix+'/reports/review.md','Historical design selection review');
  const ledger={schema_version:1,board:'PQ-METER',revision:'A',revision_spec:prefix+'/SPEC.md',bom:prefix+'/BOM-VERIFIED.csv',bom_sha256:sha(csv),
    state:'electrically-selected',state_basis:'Historical design review',stock_current:false,qualified:false,release_approved:false,limits:['Manufacturing pending'],
    selection_review:prefix+'/reports/review.md',review_evidence:{[prefix+'/SPEC.md']:sha('Revision A specification'),[prefix+'/reports/review.md']:sha('Historical design selection review')},
    parts:[{lcsc:'C578974',mpn:'ADE9000ACPZ',state:'electrically-selected',references:['U1','U2'],reviews:[prefix+'/reports/review.md'],
      evidence:'evidence/part.json',evidence_sha256:sha(json),observed_at_utc:raw.fetched_at_utc,datasheet:'datasheets/part.pdf',datasheet_sha256:sha('original PDF')}]};
  const path=prefix+'/BOM-VERIFIED.selection.json';
  const save=()=>put(path,ledger);
  const run=(bom=csv,owner=entry)=>loadBoardSelection(root,owner,bom,parseCsv(bom));
  return {root,put,entry,csv,raw,ledger,path,save,run,prefix};
}

test('optional scoped selection preserves historical identity and does not propagate to another board',async t=>{
  const f=fixture(t);
  assert.equal(await f.run(f.csv,{directory:'PQ-METER',revisions:[{revision:'A',spec:'SPEC.md'}]}),null);
  await assert.rejects(f.run(),/registered board selection ledger missing/);
  f.save();const scoped=await f.run();
  assert.equal(scoped.revision,'A');assert.equal(scoped.references.size,2);
  assert.equal(scoped.parts.get('C578974').state,'electrically-selected');
  f.put('hardware-design/boards/OTHER/SPEC.md','Other board');
  assert.equal(await f.run(f.csv,{directory:'OTHER',revisions:[{revision:'A',spec:'SPEC.md'}]}),null);
});

test('scoped ledger rejects stale, malformed and forged attribution',async t=>{
  const cases={
    'wrong board':f=>{f.ledger.board='OTHER';},
    'revision B cannot inherit revision A BOM':f=>{f.ledger.revision='B';f.ledger.revision_spec=f.prefix+'/SPEC-REV-B.md';f.ledger.review_evidence[f.ledger.revision_spec]=sha('Revision B specification');},
    'two revisions cannot own the same historical ledger':f=>{Object.assign(f.entry.revisions[1],{bom:'BOM-VERIFIED.csv',selection:'BOM-VERIFIED.selection.json'});},
    'unreviewed candidate':f=>{f.ledger.state=f.ledger.parts[0].state='stock-observed';},
    'bench state cannot be inferred from selection review':f=>{f.ledger.state=f.ledger.parts[0].state='bench-validated';},
    'fresh stock claim':f=>{f.ledger.stock_current=true;},
    'qualification claim':f=>{f.ledger.qualified=true;},
    'missing required review':f=>{delete f.ledger.review_evidence[f.ledger.selection_review];},
    'altered review':f=>{f.put(f.ledger.selection_review,'changed review');},
    'duplicate part identity':f=>{f.ledger.parts.push(structuredClone(f.ledger.parts[0]));},
    'duplicate reference':f=>{f.ledger.parts[0].references.push('U1');},
    'unlisted BOM reference':f=>{f.ledger.parts[0].references.pop();},
    'extra reference not in BOM':f=>{f.ledger.parts[0].references.push('U3');},
    'MPN mismatch':f=>{f.ledger.parts[0].mpn='different';},
    'part review omitted':f=>{f.ledger.parts[0].reviews=[];},
    'snapshot altered':f=>{f.put('hardware-design/registry/evidence/part.json',{});},
    'stock raw HTML altered':f=>{f.put('hardware-design/registry/evidence/part.html','changed');},
    'PDF altered':f=>{f.put('hardware-design/registry/datasheets/part.pdf','changed');},
    'PDF receipt source omitted':f=>{f.put('hardware-design/registry/datasheets/part.pdf.source.json',{sha256:sha('original PDF'),fetched_at_utc:'2026-09-26T00:00:00Z'});},
    'registry path traversal':f=>{f.ledger.parts[0].evidence='../outside.json';},
    'review path traversal':f=>{f.ledger.selection_review=f.prefix+'/../OTHER/review.md';f.ledger.review_evidence[f.ledger.selection_review]=sha('x');},
    'observed timestamp changed':f=>{f.ledger.parts[0].observed_at_utc='2026-10-09T00:00:00Z';},
  };
  for(const [name,alter] of Object.entries(cases)) await t.test(name,async tt=>{
    const f=fixture(tt);alter(f);f.save();await assert.rejects(f.run());
  });
  await t.test('BOM changed with no ledger refresh',async tt=>{
    const f=fixture(tt);f.save();await assert.rejects(f.run(f.csv.replace('U2','U3')));
  });
  await t.test('CAD, order and assembly cannot be inferred from selection review',async tt=>{
    const f=fixture(tt);
    for(const state of ['cad-verified','ordered','assembled']) {
      f.ledger.state=f.ledger.parts[0].state=state;f.save();await assert.rejects(f.run());
    }
  });
  await t.test('review symlink escapes owner',async tt=>{
    const f=fixture(tt);f.put('outside.md','Historical design selection review');
    rmSync(join(f.root,f.ledger.selection_review));symlinkSync(join(f.root,'outside.md'),join(f.root,f.ledger.selection_review));
    f.save();await assert.rejects(f.run());
  });
  await t.test('broken manifest symlink is not treated as absence',async tt=>{
    const f=fixture(tt);symlinkSync(join(f.root,'missing.json'),join(f.root,f.path));await assert.rejects(f.run());
  });
});
