import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseNative} from './kicad-population.mjs';
import {decimal, footprintHashes, symbolHash} from './reviewed-native-hashes.ts';

test('normalizes native package and symbol asset identities',()=>{
  assert.deepEqual(['100','1.500','0.0000001','-0.0','+1.2e3'].map(decimal), ['1E+2','1.5','1E-7','0','1.2E+3']);
  const fp=parseNative('(footprint "Lib:Part" (at 10 20 90) (pad "1" smd rect (at 1.500 0 180) (size 2 1) (net 3 "VCC") (uuid "x")))');
  const geometry=[{definition:['smd','rect',['at','1.5','0','9E+1'],['size','2','1']],number:'1'}];
  const hash=(v: unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  assert.equal(footprintHashes(fp).land_geometry_sha256,hash(geometry));
  assert.equal(footprintHashes(fp).footprint_sha256,hash({graphics:[],identifier:'Lib:Part',pads:geometry}));
  assert.equal(symbolHash([{unit:1,definitions:[['symbol','S']]}]),hash([{definitions:[['symbol','S']],unit:1}]));
  const rotated=parseNative('(footprint "X" (at 0 0 1.5) (pad "1" smd rect))');
  assert.throws(()=>footprintHashes(rotated),/non-integer/);
});
