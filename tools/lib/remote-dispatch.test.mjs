// tools/remote.sh: the job daemon when it answers, SSH otherwise. Stand-ins for curl and the client, no network.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const SCRIPT=new URL('../remote.sh',import.meta.url).pathname;

function project(t,{curl=0,exit=0}={}){
  const root=mkdtempSync(join(tmpdir(),'remote-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'tools/pcb-job'),{recursive:true});mkdirSync(join(root,'bin'));mkdirSync(join(root,'hardware-design/boards/DEMO'),{recursive:true});
  copyFileSync(SCRIPT,join(root,'tools/remote.sh'));
  writeFileSync(join(root,'bin/curl'),`#!/bin/sh\necho "$@" >> "${root}/curl.log"\nexit ${curl}\n`);chmodSync(join(root,'bin/curl'),0o755);
  writeFileSync(join(root,'token'),'tok\n');
  // The stand-in client records its arguments and environment, then writes results as the real one does.
  writeFileSync(join(root,'tools/pcb-job/client.ts'),`import fs from 'node:fs';
const a=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(join(root,'client.json'))},JSON.stringify({a,lab:process.env.IOT_LAB,tc:process.env.PCB_TOOLCHAIN_ROOT}));
const dir=a[a.indexOf('--results')+1];
fs.mkdirSync(dir+'/out/sub',{recursive:true});fs.writeFileSync(dir+'/out/res.json','{}');fs.writeFileSync(dir+'/out/sub/x','x');fs.writeFileSync(dir+'/job.json','{}');
process.exit(${exit});
`);
  return root;
}

function run(root,env={},args=['--','echo','hi']){
  const results=join(root,'results');
  const r=spawnSync('bash',[join(root,'tools/remote.sh'),'hardware-design/boards/DEMO','--results',results,...args],{encoding:'utf8',
    env:{PATH:`${join(root,'bin')}:${process.env.PATH}`,HOME:root,JOBD_URL:'http://d:1',JOBD_TOKEN_FILE:join(root,'token'),...env}});
  return{...r,results};
}
const client=root=>JSON.parse(readFileSync(join(root,'client.json'),'utf8'));
const after=(a,k)=>a[a.indexOf(k)+1];

test('a daemon that answers gets the job, with the remote.sh limits and the command intact',t=>{
  const root=project(t),input=join(root,'in.json');writeFileSync(input,'{}');
  const r=run(root,{REMOTE_CPUS:'30',REMOTE_MEM:'8g',REMOTE_TIMEOUT:'560',REMOTE_IMAGE:'iot-lab-route:10.0-fr241'},['--in',input,'--','bash','tools/x.sh','a b']);
  assert.equal(r.status,0,r.stderr);
  const {a,lab,tc}=client(root);
  assert.deepEqual([a[0],a[1]],['run','hardware-design/boards/DEMO']);
  assert.deepEqual([after(a,'--in'),after(a,'--cpus'),after(a,'--mem'),after(a,'--timeout'),after(a,'--fit'),after(a,'--image')],[input,'30','8','560','budget','iot-lab-route:10.0-fr241']);
  assert.deepEqual(a.slice(a.indexOf('--')+1),['bash','tools/x.sh','a b']);
  assert.deepEqual([lab,tc],[root,root]);
  assert.match(readFileSync(join(root,'curl.log'),'utf8'),/Bearer tok http:\/\/d:1\/status/);
});

test('results land in the folder itself, as on the SSH path',t=>{
  const root=project(t),r=run(root);
  assert.ok(existsSync(join(r.results,'res.json')));
  assert.ok(existsSync(join(r.results,'sub/x')));
  assert.ok(!existsSync(join(r.results,'out')));
  assert.ok(!existsSync(join(r.results,'job.json')));
});

test('the command exit code comes back, and a failed job is not sent over SSH as well',t=>{
  const root=project(t,{exit:7}),r=run(root,{REMOTE_HOST:'nobody@127.0.0.1'});
  assert.equal(r.status,7);
  assert.ok(existsSync(join(r.results,'res.json')));
  assert.doesNotMatch(r.stderr,/remote: job \S+ {2}remote/);
});

for(const [name,setup,env] of [
  ['the daemon does not answer',{curl:7},{}],
  ['REMOTE_NO_DAEMON is set',{},{REMOTE_NO_DAEMON:'1'}],
  ['there is no daemon URL',{},{JOBD_URL:''}],
  ['the token file is missing',{},{JOBD_TOKEN_FILE:'/nonexistent/token'}]
]) test(`no daemon when ${name}: the SSH path, and no client`,t=>{
  const root=project(t,setup),r=run(root,env);
  assert.equal(r.status,2);
  assert.match(r.stderr,/REMOTE_HOST is not set/);
  assert.ok(!existsSync(join(root,'client.json')));
});

test('the project setting names the daemon',t=>{
  const root=project(t);writeFileSync(join(root,'.pcb-toolchain.env'),'REMOTE_HOST=x\nJOBD_URL=http://from-project:2\n');
  assert.equal(run(root,{JOBD_URL:''}).status,0);
  assert.match(readFileSync(join(root,'curl.log'),'utf8'),/from-project:2/);
});

test('memory in MB becomes GB',t=>{
  const root=project(t);run(root,{REMOTE_MEM:'512m'});
  assert.equal(after(client(root).a,'--mem'),'0.5');
});
