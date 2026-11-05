// Native backend for a single packed job. Only shared preparation is reused;
// every route, checkpoint, native write and gate has its own output directory.
import { appendFileSync, closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { startOwned, type OwnedResult, type OwnedStage } from '../lib/owned-stage.ts';
import { postVerifyCommands } from '../lib/pcb-candidate-run.ts';
import type { Backend, Candidate, Event, Policy, Progress, Slice, Variant } from './sprint-controller.ts';

type Row = Record<string, any>;
const read = (p: string): Row => JSON.parse(readFileSync(p, 'utf8')) as Row;
export const digest = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const within = (root: string, file: string): string => {
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error(`sprint input is outside its workspace: ${file}`);
  return rel;
};
const progressOf = (p: Row): Progress | undefined => {
  const values = [p.pass,p.unrouted,p.conflicts?.nets,p.wire_mm,p.vias];
  if (values.some(v=>typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return undefined;
  return { pass:p.pass, unrouted:p.unrouted, conflicts:p.conflicts.nets, wire_mm:p.wire_mm, vias:p.vias };
};

export interface NativeOptions { root: string; board: string; out: string; bin: string; args: string[]; policy: Policy; maxPasses: number; emit: (event: Event) => void }

export function copyVerificationWorkspace(root: string, workspace: string): void {
  for(const name of ['tools','hardware-design']){
    const source=join(root,name);
    cpSync(source,join(workspace,name),{recursive:true,dereference:true,
      filter:path=>!relative(source,path).split('/').some(p=>['.gate','node_modules','target','__pycache__'].includes(p))});
  }
  for(const name of ['toolchain.lock','AGENTS.md','CLAUDE.md'])if(existsSync(join(root,name)))copyFileSync(join(root,name),join(workspace,name));
}

export function semanticChecks(hooks: unknown, folder: string, candidate: string, node: string, env: NodeJS.ProcessEnv) {
  const commands=postVerifyCommands(hooks,folder,candidate,node,env);
  for(const hook of commands)if(!/^[A-Za-z0-9_.-]+$/.test(hook.stage))throw Error('invalid semantic-check stage name');
  mkdirSync(join(folder,'operation'),{recursive:true});
  return commands;
}

export class NativeBackend implements Backend {
  options: NativeOptions;
  work: string;
  shared: string;
  manifest: string;
  prepared: Row | null = null;
  active = new Set<OwnedStage>();
  cleanupErrors: string[] = [];
  stages: Row[] = [];
  counters = new Map<string, number>();

  constructor(options: NativeOptions) {
    this.options = options;
    this.work = `${options.out}.iotroute`;
    if (existsSync(options.out) || existsSync(this.work)) throw Error('sprint output and work folder must be new');
    this.shared = join(this.work, 'portfolio', 'shared', basename(options.out));
    this.manifest = `${this.shared}.iotroute/prepared.json`;
    mkdirSync(dirname(this.shared), { recursive:true });
  }

  private env(root = this.options.root): NodeJS.ProcessEnv {
    return { ...process.env, IOTROUTE_BIN:this.options.bin, IOT_LAB:root, PCB_JOBS_LOCAL:'1',
      OMP_NUM_THREADS:'1', OPENBLAS_NUM_THREADS:'1', RAYON_NUM_THREADS:'1' };
  }

  private async owned(command: string[], log: string, signal: AbortSignal, cwd = this.options.root,
    env = this.env(cwd), graceful = false): Promise<OwnedResult> {
    if (signal.aborted) throw Error(`sprint stopped before spawn: ${String(signal.reason)}`);
    mkdirSync(dirname(log), {recursive:true});
    const fd = openSync(log, 'w');
    let stage: OwnedStage;
    try { stage = startOwned(command, {cwd, env, stdout:fd, stderr:fd}); } finally { closeSync(fd); }
    this.active.add(stage);
    let escalation: ReturnType<typeof setTimeout> | undefined, stopping=false;
    const stop = () => {
      if(stopping)return;stopping=true;
      if (graceful) {
        void stage.interrupt().catch(e=>this.cleanupErrors.push(String(e)));
        escalation = setTimeout(()=>{ void stage.cancel().catch(e=>this.cleanupErrors.push(String(e))); }, 1500);
      } else void stage.cancel().catch(e=>this.cleanupErrors.push(String(e)));
    };
    signal.addEventListener('abort', stop, {once:true});
    if (signal.aborted) stop();
    const start = performance.now();
    try {
      const result = await stage.settled;
      this.stages.push({command,log,wall_s:(performance.now()-start)/1000,...result});
      if (!result.cleanup.complete) { this.cleanupErrors.push(log); throw Error(`cleanup incomplete: ${log}`); }
      return result;
    } catch (error) {
      this.stages.push({command,log,error:String(error)});
      if(!(error as {cleanup?:{complete?:boolean}})?.cleanup?.complete)this.cleanupErrors.push(`unconfirmed stage: ${log}`);
      throw error;
    }
    finally { if (escalation) clearTimeout(escalation); signal.removeEventListener('abort',stop); this.active.delete(stage); }
  }

  async prepare(signal: AbortSignal): Promise<void> {
    const {bin,board,args} = this.options;
    const result = await this.owned([bin,'sprint-prepare',board,this.shared,...args], join(this.work,'portfolio','prepare.log'), signal);
    if (result.returncode !== 0) throw Error(`shared preparation failed (${result.returncode}); see prepare.log`);
    this.prepared = read(this.manifest);
    if (this.prepared.schema !== 'iot-lab.route-prepared.v1' || this.prepared.binary_sha256 !== digest(bin)) throw Error('invalid prepared/binary binding');
    for (const key of ['model','route_in','src','folder']) if (typeof this.prepared[key] !== 'string') throw Error(`missing prepared ${key}`);
    within(this.options.root,this.prepared.src);
    const cfg=read(join(this.prepared.folder,'gate.json'));
    if(resolve(this.prepared.src)!==resolve(this.prepared.folder,`${cfg.project}.kicad_pcb`))throw Error('sprints require the configured board project in the isolated snapshot');
  }

  private directory(v: Variant): string {
    if (!/^v\d{2}$/.test(v.id)) throw Error('invalid variant id');
    const dir = join(this.work,'portfolio',v.id); mkdirSync(dir,{recursive:true}); return dir;
  }

  private saved(file: string): { pass: number } | null {
    try {
      const raw = readFileSync(file,'utf8'), envelope = JSON.parse(raw) as Row;
      if (envelope.terminal || envelope.payload?.schema !== 'iot-lab.route-resume.v1') return null;
      // Rust hashes the raw payload bytes, not JavaScript's reserialized floating-point values.
      const marker = '"payload":', at = raw.indexOf(marker);
      if (at < 0) return null;
      const start = at+marker.length;
      let depth=0, quote=false, escape=false, end=start;
      for (;end<raw.length;end++) { const c=raw[end]; if (quote) { if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')quote=false; }
        else if(c==='"')quote=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){depth--;if(depth===0){end++;break;}} }
      if (createHash('sha256').update(raw.slice(start,end)).digest('hex') !== envelope.sha256) return null;
      const pass=envelope.payload.pass;
      return Number.isSafeInteger(pass)&&pass>0&&pass<=this.options.maxPasses ? {pass} : null;
    } catch { return null; }
  }

  async slice(v: Variant, signal: AbortSignal, onProgress: (p: Progress)=>void): Promise<Slice> {
    const p=this.prepared!; const dir=this.directory(v), state=join(dir,'state.json'), progress=join(dir,'progress.json');
    const n=(this.counters.get(v.id)??0)+1; this.counters.set(v.id,n);
    const output=join(dir,`slice-${n}.json`);
    const args=[this.options.bin,p.model,output,'--iters',String(this.options.maxPasses),'--seed',String(v.seed),'--via-cost',String(v.via_cost),
      '--resume-save',state,'--yield-after-passes',String(this.options.policy.slice_passes),'--checkpoint',progress];
    if(p.args.congestion)args.push('--congestion',join(dir,'congestion.json'),'--cong-free','1');
    if(v.checkpoint)args.push('--resume',state);
    let last=''; const poll=()=>{try {const text=readFileSync(progress,'utf8');if(text!==last){last=text;const q=progressOf(JSON.parse(text));if(q)onProgress(q);}}catch{}};
    const timer=setInterval(poll,250); let result: OwnedResult | null=null;
    try { result=await this.owned(args,join(dir,`slice-${n}.log`),signal,undefined,undefined,true); }
    finally {clearInterval(timer);poll();}
    const cpu_s=result.childCpuS;
    if(result.returncode===3){
      const receipt=read(output), saved=this.saved(state);
      if(receipt.schema!=='iot-lab.route-yield.v1'||receipt.status!=='yielded'||receipt.finalized!==false||receipt.checkpoint?.sha256!==digest(state)||saved?.pass!==receipt.pass)
        throw Error('invalid yield receipt or state digest');
      return {kind:'yielded',pass:receipt.pass,cpu_s,checkpoint:state,...(existsSync(progress)?{progress:progressOf(read(progress))}: {})};
    }
    if(result.returncode===0){
      const route=read(output);
      if(route.schema!=='iot-lab.route-result.v0'||!Array.isArray(route.failed))throw Error('not a finalized route result');
      return {kind:'complete',pass:route.passes,cpu_s,route:output,...(existsSync(progress)?{progress:progressOf(read(progress))}: {})};
    }
    const saved=this.saved(state);
    if(signal.aborted&&saved&&saved.pass>v.pass)return {kind:'yielded',pass:saved.pass,cpu_s,checkpoint:state};
    throw Error(`variant ${v.id} exited ${result.returncode}`);
  }

  async verify(v: Variant, signal: AbortSignal): Promise<Candidate|null> {
    const p=this.prepared!, dir=this.directory(v); let route=v.route;
    if(!route){
      const state=join(dir,'state.json'), saved=this.saved(state); if(!saved)return null;
      route=join(dir,'final.json');
      const args=[this.options.bin,p.model,route,'--iters',String(saved.pass),'--seed',String(v.seed),'--via-cost',String(v.via_cost),'--resume',state];
      if(p.args.congestion)args.push('--congestion',join(dir,'congestion.json'),'--cong-free','1');
      const result=await this.owned(args,join(dir,'finalize.log'),signal);
      if(result.returncode!==0)return null;
    }
    const raw=read(route); if(raw.schema!=='iot-lab.route-result.v0'||!Array.isArray(raw.failed)||raw.failed.length)return null;
    const board=join(dir,'finished',basename(this.options.out));mkdirSync(dirname(board),{recursive:true});
    const written=await this.owned([this.options.bin,'sprint-finish',this.manifest,route,board,String(v.seed)],join(dir,'native.log'),signal);
    if(written.returncode!==0)return null;
    const record=read(`${board}.iotroute/result.json`);
    if(record.status!=='PASS'||record.drc_errors!==0||record.unconnected!==0||record.parity!==0||record.board_sha256!==digest(board))return null;
    const workspace=join(dir,'workspace');mkdirSync(workspace);
    try{
      copyVerificationWorkspace(this.options.root,workspace);
      const candidate=join(workspace,within(this.options.root,p.src));copyFileSync(board,candidate);
      const gate=join(dir,'gate'), env=this.env(workspace), boardId=basename(p.folder);
      const check=await this.owned([process.execPath,join(workspace,'tools/gate.mjs'),boardId,'--fresh','--evidence-dir',gate],join(dir,'gate.log'),signal,workspace,env);
      if(check.returncode!==0||!existsSync(join(gate,'result.json')))return null;
      const gateResult=read(join(gate,'result.json'));if(gateResult.exit!==0||gateResult.changedDuringRun)return null;
      const cfg=read(join(p.folder,'gate.json'));
      for(const hook of semanticChecks(cfg.post_verify,dir,candidate,process.execPath,env)){
        if((await this.owned(hook.command,join(dir,`${hook.stage}.log`),signal,workspace,hook.env)).returncode!==0)return null;
      }
      if(digest(candidate)!==record.board_sha256)throw Error('verification changed candidate bytes');
      const receipt=join(dir,'verified.json');
      writeFileSync(receipt,JSON.stringify({schema:'iot-lab.sprint-verified.v1',board,board_sha256:record.board_sha256,gate:join(gate,'result.json'),gate_sha256:digest(join(gate,'result.json')),native:`${board}.iotroute/result.json`,native_sha256:digest(`${board}.iotroute/result.json`)}));
      return {variant:v.id,board,board_sha256:record.board_sha256,wire_mm:record.track_length_mm,vias:record.vias,receipt};
    }finally{rmSync(workspace,{recursive:true,force:true});}
  }

  async settle(): Promise<void> {
    for(const stage of this.active){try{await stage.cancel();await stage.settled;}catch(e){this.cleanupErrors.push(String(e));}}
    writeFileSync(join(this.work,'portfolio','owned-stages.json'),JSON.stringify(this.stages,null,2));
    if(this.cleanupErrors.length)throw Error(this.cleanupErrors.join('; '));
  }
}
