#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {root} from './lib/env.mjs';
import {verifyFab,fileHashes,releaseInputs,verifyBoardChecks} from './lib/release-evidence.mjs';
try {
 const [board,stageArg,inputsArg]=process.argv.slice(2);
 if(!board || !stageArg || !inputsArg)throw new Error('usage: check-release-fab.mjs BOARD STAGING INPUTS_JSON');
 const stage=resolve(stageArg),inputs=JSON.parse(readFileSync(inputsArg,'utf8'));
 if(JSON.stringify(inputs)!==JSON.stringify(releaseInputs(root,board)))throw new Error('release tooling changed during export');
 const assembly=verifyFab(root,board,join(stage,'fab'));
 const board_checks=verifyBoardChecks(board,stage,root);
 const gerber_runtime=JSON.parse(readFileSync(join(stage,'gerber-runtime.json'),'utf8'));
 if(!gerber_runtime.python || !['gerbonara','shapely','numpy','click'].every(p=>typeof gerber_runtime.packages?.[p]==='string' && gerber_runtime.packages[p]))throw new Error('Gerber runtime provenance missing');
 const gate=JSON.parse(readFileSync(join(stage,'fab/gate-evidence.json'),'utf8'));
 if(gate.board!==board)throw new Error('gate belongs to another board');
 const artifacts=fileHashes(stage);
 const manifest={schema_version:1,board,revision:assembly.revision,scope:'cad_fabrication_candidate',
  gate_token:gate.token,input_sha256:gate.input_sha256,release_inputs:inputs,assembly,board_checks,gerber_runtime,
  artifacts,rendered_views:Object.keys(artifacts).filter(p=>p.startsWith('renders/') && p.endsWith('.png')).length,g5_ready:false,g6_qualified:false,ordered:false,
  limits:['Stock is not reserved; order-day stock, verified packet and supplier orientation review are separate readiness checks.','No purchasing, upload, assembly or measured qualification is established.']};
 writeFileSync(join(stage,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 console.log('PASS: staged fabrication/native BOM/CPL poses verified; manifest='+join(stage,'release-manifest.json'));
}catch(error){console.error('FAIL: release fabrication: '+error.message);process.exit(1);}
