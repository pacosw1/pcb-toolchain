// Bounded Hetzner-only diagnostic; daemon success means the assertions ran,
// never that a partial board passed electrical acceptance.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const [mode]=process.argv.slice(2),bin=path.resolve('in/iotroute-linux-x86_64');
const source=path.resolve('hardware-design/boards/ENV-SENSE/cad/ENV-SENSE/ENV-SENSE.kicad_pcb');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function run(name,previous){
 const out=path.resolve('out',name,'ENV-SENSE.kicad_pcb');fs.mkdirSync(path.dirname(out),{recursive:true});
 const args=['run','ENV-SENSE',out,'--pcb',source,'--lock-from',source,'--return-exempt','--iters','6','--max-time','20','--layer','F.Cu','--json'];
 if(previous)args.push('--reuse',previous,'--reuse-fallback','none');
 const fd=fs.openSync(out+'.log','w'),start=performance.now();
 const r=spawnSync(bin,args,{stdio:['ignore',fd,fd],timeout:160000,killSignal:'SIGKILL'});fs.closeSync(fd);
 if(![0,1].includes(r.status))throw Error(name+' failed to execute: '+r.status+' '+r.error?.message);
 const result=read(out+'.iotroute/result.json'),route=read(out+'.iotroute/route.json');
 return{out,exit:r.status,seconds:(performance.now()-start)/1000,result,ground_tracks:route.tracks.filter(t=>t.net==='GND').length};
}
let first;
if(mode==='single')first=run('gnd-first');
else if(mode==='sprint'){
 const unpack=spawnSync('tar',['-xzf','in/gnd-baseline.tar.gz','-C','out'],{encoding:'utf8'});
 if(unpack.status!==0)throw Error('unpack baseline: '+unpack.stderr);
 const out=path.resolve('out/gnd-first/ENV-SENSE.kicad_pcb'),result=read(out+'.iotroute/result.json');
 first={out,result};
}else throw Error('single=before, sprint=after');
const second=run('gnd-reuse',first.out);
const summary={schema:'pcb.gnd-reuse-diagnostic.v1',mode,diagnostic_complete:true,boards_accepted:false,
 first:{drc:first.result.drc_errors,opens:first.result.unconnected,parity:first.result.parity,tracks:first.result.tracks,sha:first.result.board_sha256},
 second:{drc:second.result.drc_errors,opens:second.result.unconnected,parity:second.result.parity,tracks:second.result.tracks,ground_tracks:second.ground_tracks,sha:second.result.board_sha256,reuse:second.result.reuse}};
fs.writeFileSync('out/gnd-summary.json',JSON.stringify(summary,null,2));
if(mode==='sprint'&&(second.result.unconnected>first.result.unconnected||second.result.drc_errors>first.result.drc_errors||second.result.parity>first.result.parity))throw Error('reuse lost the incumbent');
console.log(JSON.stringify(summary));
