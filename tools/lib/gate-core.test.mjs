import test from 'node:test';
import assert from 'node:assert/strict';
import {passes, ratchet, metricsText, countFrom, validateConfig, expectedMetrics} from './gate-core.mjs';
const core={erc_errors:0,drc_errors:0,drc_parity:0,drc_unconnected:0};
test('complete zero targets pass; info remains advisory',()=>assert.equal(passes({...core,drc_warnings:164}).ok,true));
test('empty, missing, invalid and unknown metrics fail closed',()=>{
  for(const m of [{},{drc_errors:0},{...core,drc_errors:NaN},{...core,drc_errors:-1},{...core,drc_errors:'0'},{...core,drc_errors:null},{...core,typo:0}]) assert.equal(passes(m).ok,false);
});
test('required checks depend on gate stage; layout cannot disable DRC',()=>{
  const cfg={project:'cad/X',checks:{erc:true,drc:true,paths:'current-paths.json',viapads:{allow:[]},kicad_happy:{},port_labels:true}};
  assert.deepEqual(validateConfig(cfg),[]);
  assert.ok(expectedMetrics(cfg).includes('drc_parity'));
  assert.ok(validateConfig({...cfg,checks:{...cfg.checks,drc:false}}).length);
  assert.deepEqual(validateConfig({project:'cad/X',stage:'G3',checks:{erc:true}}),[]);
});
test('removed hard and soft checks block',()=>{
  const r=ratchet({...core,viapads:0},{...core,drc_errors:undefined});
  assert.ok(r.blocked.some(x=>x.includes('viapads')));assert.ok(r.blocked.some(x=>x.includes('drc_errors')));
  assert.ok(ratchet(core,{}).blocked.length);
});
test('hard increases block, soft increases warn, info is ignored',()=>{
  const r=ratchet({...core,paths_low:2,drc_warnings:164},{...core,drc_unconnected:1,paths_low:3,drc_warnings:200});
  assert.deepEqual(r.blocked,['drc_unconnected: 0 -> 1']);assert.deepEqual(r.warnings,['paths_low: 2 -> 3']);
});
test('waivers require owner, exact baseline, expiry, revision and fingerprint',()=>{
  const context={revision:'cad/X',inputFingerprint:'abc',today:'2026-10-09'};
  const w={metric:'drc_errors',from:0,to:5,reason:'exploratory commit only',owner:'user',date:'2026-10-09',expires:'2026-10-10',revision:'cad/X',inputFingerprint:'abc'};
  assert.equal(ratchet(core,{...core,drc_errors:3},[w],context).waived.length,1);
  for(const change of [{expires:'2026-10-08'},{owner:''},{from:1},{revision:'cad/Y'},{inputFingerprint:'old'}]) assert.equal(ratchet(core,{...core,drc_errors:3},[{...w,...change}],context).blocked.length,1);
  assert.equal(passes({...core,drc_errors:3}).ok,false);
  assert.equal(ratchet(core,{...core,drc_errors:3},[{metric:'drc_errors',to:5,reason:'old',date:'2026-01-01'}],context).blocked.length,1);
});
test('no baseline permits exploratory counts, missing tools block',()=>{
  assert.deepEqual(ratchet(null,{...core,drc_errors:5}).blocked,[]);assert.ok(ratchet(null,{...core,drc_errors:null}).blocked.length);
});
test('metrics serialization is stable and records provenance',()=>{
  const a=metricsText({board:'X',pcbSha256:'p',schSha256:'s',metrics:core,provenance:{input_sha256:'h'}});
  const b=metricsText({board:'X',pcbSha256:'p',schSha256:'s',metrics:Object.fromEntries(Object.entries(core).reverse()),provenance:{input_sha256:'h'}});
  assert.equal(a,b);assert.equal(JSON.parse(a).schema_version,2);
});
test('count parser returns null without completion count',()=>{
  assert.equal(countFrom('0 vias in SMD pads',/(\d+) vias in SMD pads/),0);assert.equal(countFrom('Traceback',/(\d+) vias in SMD pads/),null);
});
