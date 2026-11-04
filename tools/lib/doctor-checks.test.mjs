import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {hookCheck} from './doctor-checks.mjs';
test('relative and absolute hooks resolve identically; nonexecutables fail',t=>{
 const r=mkdtempSync(join(tmpdir(),'doctor-test-'));t.after(()=>rmSync(r,{recursive:true,force:true}));
 mkdirSync(join(r,'tools/hooks'),{recursive:true});const f=join(r,'tools/hooks/pre-commit');writeFileSync(f,'#!/bin/sh\n');chmodSync(f,0o755);
 assert.equal(hookCheck(r,'tools/hooks').ok,true);assert.equal(hookCheck(r,join(r,'tools/hooks')).ok,true);
 chmodSync(f,0o644);assert.equal(hookCheck(r,'tools/hooks').ok,false);assert.equal(hookCheck(r,null).ok,false);
});
