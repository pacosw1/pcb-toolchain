import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
const base=process.argv[2],label=process.argv[3],mode=process.argv[4],cpus=Number(process.argv[5]),seconds=Number(process.argv[6]),board=process.argv[7]??"ENV-SENSE";
if(!["ENV-SENSE","FIELD-24V-BUS","ESP32-CORE"].includes(board))throw Error("board outside the three-board benchmark");
if(!/^\/var\/tmp\/router-benchmark-1318\.[A-Za-z0-9]+$/.test(base)||!/^[a-z0-9-]+$/.test(label)||!['single','sprint'].includes(mode)||![1,2].includes(cpus)||![120,240].includes(seconds))throw Error('bad experiment arguments');
const tc=base+'/toolchain',project=base+'/project';
const settings=Object.fromEntries(fs.readFileSync('/etc/pcb-job-daemon.env','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')]}));
const out=base+'/evidence/'+label;fs.mkdirSync(out,{recursive:true});
const {happyTar}=await import(tc+'/tools/lib/happy-tar.mjs');const happy=happyTar(base+'/happy','a6bba1a');
const env={...process.env,JOBD_URL:`http://${settings.JOBD_BIND||'127.0.0.1'}:${settings.JOBD_PORT||8793}`,JOBD_TOKEN_FILE:settings.JOBD_TOKEN_FILE,PCB_TOOLCHAIN_ROOT:tc,IOT_LAB:project,KICAD_HAPPY_DIR:base+'/happy',PCB_LIVE:'0'};
const script=`set -eu
mkdir .happy bin
tar -xzf in/kicad-happy-a6bba1a.tar.gz -C .happy
ln -s ../in/node-linux-x86_64 bin/node
ln -s ../in/iotroute-linux-x86_64 bin/iotroute-linux-x86_64
export KICAD_HAPPY_DIR=$PWD/.happy KICAD_CLI=kicad-cli PATH="$PWD/bin:$PATH" PCB_TOOLCHAIN_ROOT=$PWD IOTROUTE_BIN=$PWD/in/iotroute-linux-x86_64 PCB_JOBS_LOCAL=1 REMOTE_NO_DAEMON=1 NODE_OPTIONS="--experimental-strip-types --no-warnings"
exec in/node-linux-x86_64 --experimental-strip-types --no-warnings tools/router/benchmarks/1318-job.ts "$@"`;
const args=['--no-warnings','--experimental-strip-types',tc+'/apps/job-daemon/src/client.ts','run',`hardware-design/boards/${board}`,...['iotroute-linux-x86_64','node-linux-x86_64'].flatMap(n=>['--in',tc+'/bin/'+n]),'--in',happy,'--snapshot','board','--retries','0','--timeout',String(seconds),'--cpus',String(cpus),'--mem','4','--queue-wait','300','--results',out+'/results','--name','benchmark1318-'+label,'--image','iot-lab-route:10.0-nightly-4fe1ca2060','--','bash','-c',script,'_',mode,String(seconds),board];
const start=performance.now(),fd=fs.openSync(out+'/client.log','w');const child=spawn(tc+'/bin/node-linux-x86_64',args,{cwd:project,env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)});
const record={label,board,mode,cpus,seconds,mem_gb:4,code,client_elapsed_s:(performance.now()-start)/1000,args};fs.writeFileSync(out+'/submission.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));process.exitCode=code??2;
