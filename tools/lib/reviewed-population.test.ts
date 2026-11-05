import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256} from './kicad-population.mjs';
import {reconstructSnapshot} from './reviewed-population.ts';

test('reconstructs snapshot identities and nets and rejects changed sources', t => {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-native-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const project = 'hardware-design/boards/X/cad/PROJECT';
  const put = (name: string, text: string) => {const path=join(root,name); mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);};
  put(project+'.kicad_sch', `(kicad_sch (uuid "ROOT") (symbol (uuid "symbol-uuid") (lib_id "Fixture:Part") (unit 1) (in_bom yes) (on_board yes) (dnp no)
    (property "Reference" "U1") (property "Footprint" "Fixture:Part") (property "MPN" "PART") (property "LCSC" "C123")
    (instances (project "PROJECT" (path "/ROOT" (reference "U1") (unit 1))))))`);
  put(project+'.kicad_pcb', `(kicad_pcb (footprint "Fixture:Part" (property "Reference" "U1")
    (property "MPN" "PART") (property "LCSC" "C123") (path "/symbol-uuid") (attr smd)
    (pad "1" smd rect (net 1 "VCC"))))`);
  const expected = Object.fromEntries([project+'.kicad_sch', project+'.kicad_pcb'].map(p=>[p,sha256(readFileSync(join(root,p)))]));
  const result = reconstructSnapshot(root, project, expected);
  assert.equal(result.verified_review, false);
  assert.deepEqual(result.parts.U1.pad_net_map, {'1':'VCC'});
  const original = readFileSync(join(root,project+'.kicad_pcb')).toString();
  put(project+'.kicad_pcb', original.replace('symbol-uuid','wrong-uuid'));
  const rebound = {...expected, [project+'.kicad_pcb']:sha256(readFileSync(join(root,project+'.kicad_pcb')))};
  assert.throws(()=>reconstructSnapshot(root, project, rebound), /does not bind a schematic instance/);
  put(project+'.kicad_pcb', original);
  put(project+'.kicad_pcb', readFileSync(join(root,project+'.kicad_pcb')).toString().replace('VCC','OTHER'));
  assert.throws(()=>reconstructSnapshot(root, project, expected), /snapshot sources differ/);
});
