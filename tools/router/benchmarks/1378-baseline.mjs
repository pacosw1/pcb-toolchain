// One frozen NET-CORE experiment on the Linux Docker host, never a canonical project.
// Prepare ROOT/{input,project,toolchain,bin,happy}; see the accompanying report for provenance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const [mode, supplied] = process.argv.slice(2);
if (!['prepare','route','iotroute','verify'].includes(mode) || !supplied) throw Error('prepare|route|iotroute|verify SCRATCH_ROOT');
const root = fs.realpathSync(supplied);
if (!root.startsWith('/var/tmp/tracemaker-1378')) throw Error('dedicated benchmark scratch root required');
const nativeImage = 'iot-lab-route:10.0-nightly-4fe1ca2060';
const tmImage = 'tracemaker:1378-v0.12.1';
const pcb = '/bench/input/NET-CORE.kicad_pcb';
const bin = '/bench/toolchain/bin/iotroute-linux-x86_64';
const node = '/bench/toolchain/bin/node-linux-x86_64';
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const json = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const save = (p,value) => fs.writeFileSync(path.join(root,p),JSON.stringify(value,null,2)+'\n');
const inputHashes = () => Object.fromEntries(fs.readdirSync(path.join(root,'input')).sort().map(n=>[n,sha(path.join(root,'input',n))]));
const before = inputHashes();
if(before['NET-CORE.kicad_pcb']!=='9109c27c374ca3685cc73cb60e452a66adba81ad71968c1f63db754f7fc5f784') throw Error('not the retained frozen input');
function docker(image,args,label,{cwd='/bench/project',timeout=720_000}={}) {
  const container=`tm1378-${process.pid}-${label.replaceAll('/','-')}`;
  const command=['run','--name',container,'--rm','--user','0:0','--network','none','--cpus','1','--memory','8g',
    '--mount',`type=bind,src=${root},dst=/bench`,
    '--mount',`type=bind,src=${root}/input,dst=/bench/input,readonly`,
    '-w',cwd,'-e','PATH=/bench/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '-e','IOT_LAB=/bench/project','-e','PCB_TOOLCHAIN_ROOT=/bench/toolchain',
    '-e','PCB_JOBS_LOCAL=1','-e','REMOTE_NO_DAEMON=1',
    '-e','KICAD_HAPPY_DIR=/bench/happy','-e',`IOTROUTE_BIN=${bin}`,
    '-e','OMP_NUM_THREADS=1','-e','OPENBLAS_NUM_THREADS=1','-e','RAYON_NUM_THREADS=1',image,...args];
  const log=fs.openSync(path.join(root,label+'.log'),'w'),at=performance.now();
  const result=spawnSync('docker',command,{stdio:['ignore',log,log],timeout});fs.closeSync(log);
  if(result.error)spawnSync('docker',['rm','-f',container],{stdio:'ignore'});
  const record={command:['docker',...command],exit:result.status,signal:result.signal,error:result.error?.message??null,wall_s:(performance.now()-at)/1000};
  save(label+'.process.json',record);return record;
}
if(mode==='prepare') {
  const exportResult=docker(nativeImage,[bin,'board-json',pcb],'input-board');
  if(exportResult.exit!==0)throw Error('native export failed');
  fs.copyFileSync(path.join(root,'input-board.log'),path.join(root,'input-board.json'));
  const result=docker(nativeImage,[bin,'model','/bench/project/hardware-design/boards/NET-CORE','--pcb',pcb,'--out','/bench/model.json','--tools','/bench/toolchain/tools'],'model');
  if(result.exit!==0)throw Error('native model failed');
} else if(mode==='route'||mode==='iotroute') {
  if(mode==='route') {
    if(fs.existsSync(path.join(root,'runs')))throw Error('refusing to replace existing run evidence');
    fs.mkdirSync(path.join(root,'runs'));
    save('input-hashes.json',before);
  } else if(fs.existsSync(path.join(root,'runs/iotroute.process.json'))||fs.existsSync(path.join(root,'runs/iotroute.kicad_pcb.iotroute')))throw Error('refusing to replace native run evidence');
  const board=json('input-board.json');
  if(board.schema!=='iot-lab.board.v1'||board.board_sha256!==before['NET-CORE.kicad_pcb']||
    board.project_sha256!==before['NET-CORE.kicad_pro']||board.rules_sha256!==before['NET-CORE.kicad_dru'])throw Error('stale native export');
  const model=json('model.json');
  const maxPad=Math.max(...board.board.footprints.flatMap(f=>f.pads.map(p=>Math.min(p.size.x,p.size.y))))/1e6+0.001;
  const tm=['/usr/bin/time','-v','-o','/bench/runs/tracemaker.time','timeout','--signal=TERM','--kill-after=10','660',
    '/build/src/app/tracemaker','route',pcb,'-o','/bench/runs/tracemaker.kicad_pcb','--time','600','--threads','1','--variants','1',
    '--no-gpu','--no-kb','--soft-zones','--keep-vias-off-pads','--vias-off-pads-below',String(maxPad),'--via-in-pad',
    '--component-rules','off','--no-tracks-on','In1.Cu,In3.Cu,In4.Cu','--widen-power',
    '--stitch-vias','return','--stitch-distance',String(model.return_rule.radius),
    ...Object.entries(model.nets).filter(([,n])=>n.plane_ref).flatMap(([n])=>['--stitch-return',n+'=GND']),
    '--json','/bench/runs/tracemaker-summary.json'];
  save('policy.json',{cpus:1,memory_gib:8,route_budget_s:600,hard_route_s:660,tm_threads:1,tm_variants:1,
    note:'Sequential runs. Native export/model outside route timing. iotroute run also includes model/write/native checks; verification measured separately. GNU time maximum RSS is the largest process, not aggregate cgroup peak.',nativeImage,tmImage});
  if(mode==='route')docker(tmImage,tm,'runs/tracemaker');
  // The historical caller names a removed backend. Change only its selector on the scratch copy;
  // keep every original electrical field and gate. run reads this plan to apply width restrictions.
  const planPath=path.join(root,'project/hardware-design/boards/NET-CORE/route.json');
  const plan=JSON.parse(fs.readFileSync(planPath,'utf8'));
  if(plan.backend==='fastroute') {
    fs.copyFileSync(planPath,path.join(root,'route-original.json'));const original=sha(planPath);
    plan.backend='iotroute';fs.writeFileSync(planPath,JSON.stringify(plan,null,2)+'\n');
    save('caller-conversion.json',{field:'backend',from:'fastroute',to:'iotroute',original_sha256:original,converted_sha256:sha(planPath)});
  } else if(plan.backend!=='iotroute')throw Error('unexpected historical backend');
  docker(nativeImage,['/bench/time','-v','-o','/bench/runs/iotroute.time','timeout','--signal=TERM','--kill-after=10','660',
    bin,'run','/bench/project/hardware-design/boards/NET-CORE','/bench/runs/iotroute.kicad_pcb','--pcb',pcb,
    '--iters','80','--max-time','600','--tools','/bench/toolchain/tools','--json'],'runs/iotroute');
} else {
  const results=[];
  for(const name of ['tracemaker','iotroute']) {
    const candidate=path.join(root,`runs/${name}.kicad_pcb`);
    if(!fs.existsSync(candidate)){save(`runs/${name}-missing.json`,{missing:true});results.push({name,measured:false,accepted:false,cause:'no routed board'});continue;}
    const dir=path.join(root,`verify-${name}`);fs.mkdirSync(dir);
    const project=path.join(root,'project/hardware-design/boards/NET-CORE/cad/NET-CORE');
    for(const f of fs.readdirSync(path.join(root,'input')))fs.copyFileSync(path.join(root,'input',f),path.join(project,f));
    fs.copyFileSync(candidate,path.join(project,'NET-CORE.kicad_pcb'));
    const target='/bench/project/hardware-design/boards/NET-CORE/cad/NET-CORE/NET-CORE.kicad_pcb';
    docker(nativeImage,['kicad-cli','pcb','drc','--refill-zones','--save-board','--schematic-parity','--severity-all','--format','json','-o',`/bench/verify-${name}/drc.json`,target],`verify-${name}/refill`);
    // KiCad can rewrite project settings while saving; restore the exact electrical sidecars before acceptance.
    for(const ext of ['pro','dru','sch'])fs.copyFileSync(path.join(root,`input/NET-CORE.kicad_${ext}`),path.join(project,`NET-CORE.kicad_${ext}`));
    docker(nativeImage,[bin,'board-json',target],`verify-${name}/board-json`);
    const output=json(`verify-${name}/board-json.log`),input=json('input-board.json');
    const byId=new Map(output.board.copper.map(c=>{const v=Object.values(c)[0];return[v.id,c]}));
    const changed=input.board.copper.filter(c=>{const v=Object.values(c)[0];return JSON.stringify(byId.get(v.id))!==JSON.stringify(c)}).map(c=>Object.values(c)[0].id);
    const byUuid=(a,b)=>a.id.localeCompare(b.id);
    const poses=b=>b.footprints.map(f=>({id:f.id,reference:f.reference,layer:f.layer,position:f.position,orientation:f.orientation,
      pads:f.pads.map(p=>({id:p.id,position:p.position,orientation:p.orientation,size:p.size,net:p.net})).sort(byUuid)})).sort(byUuid);
    const placementSame=JSON.stringify(poses(input.board))===JSON.stringify(poses(output.board));
    const tracks=output.board.copper.flatMap(c=>c.Track?[c.Track]:[]),vias=output.board.copper.filter(c=>c.Via);
    const straightLength=items=>items.filter(t=>!t.mid).reduce((s,t)=>s+Math.hypot(t.end.x-t.start.x,t.end.y-t.start.y)/1e6,0);
    const inputTracks=input.board.copper.flatMap(c=>c.Track?[c.Track]:[]);
    const drc=json(`verify-${name}/drc.json`);
    save(`verify-${name}/metrics.json`,{board_sha256:output.board_sha256,input_copper:input.board.copper.length,changed_input_copper:changed,
      placement_same:placementSame,tracks:tracks.length,vias:vias.length,new_tracks:tracks.length-inputTracks.length,
      new_vias:vias.length-input.board.copper.filter(c=>c.Via).length,
      straight_track_length_mm:straightLength(tracks),new_straight_track_length_mm:straightLength(tracks)-straightLength(inputTracks),arcs:tracks.filter(t=>t.mid).length,
      drc_errors:drc.violations.filter(v=>v.severity==='error').length,unconnected:drc.unconnected_items.length,parity:drc.schematic_parity.length});
    docker(nativeImage,[node,'--experimental-strip-types','--no-warnings','/bench/toolchain/tools/gate.mjs','NET-CORE','--fresh','--evidence-dir',`/bench/verify-${name}/gate`],`verify-${name}/gate-run`);
    const gate=json(`verify-${name}/gate/result.json`),metrics=json(`verify-${name}/metrics.json`);
    const route=json(`runs/${name}.process.json`);
    const measured=Object.values(gate.metrics).every(Number.isFinite)&&gate.changedDuringRun===false;
    const accepted=measured&&route.exit===0&&gate.exit===0&&changed.length===0&&placementSame&&metrics.drc_errors===0&&metrics.unconnected===0&&metrics.parity===0;
    results.push({name,measured,accepted,route_exit:route.exit,metrics,gate_exit:gate.exit,gate_changed:gate.changedDuringRun,gate_metrics:gate.metrics});
    fs.copyFileSync(path.join(project,'NET-CORE.kicad_pcb'),path.join(dir,'NET-CORE.kicad_pcb'));
  }
  save('verification-summary.json',{completed:results.every(r=>r.measured),results});
}
if(JSON.stringify(inputHashes())!==JSON.stringify(before))throw Error('frozen input changed');
