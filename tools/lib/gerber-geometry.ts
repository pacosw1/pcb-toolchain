// Gerber polygon operations execute in the same pinned Linux worker as board-json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemonJob } from './daemon-job.ts';
import { PINNED_IMAGE } from './env.mjs';
import { fileRoot } from './project-root.mjs';
import { geosFiles } from './geos-runtime.ts';
import type { Xy } from './copper-graph.ts';
import type { Outline } from './copper-graph.ts';

export type Poly = {outer: number[][]; holes: number[][][]};
export type Stroke = {points:number[][];width_nm:number};
export type Request = {operation: 'intersection'|'buffer_intersection'; a: Poly[]; b: Poly[]; a_strokes?:Stroke[]; b_strokes?:Stroke[]; offset_nm?: number};
export const strokes = (data:{points:Xy[];width:number}[]):Stroke[] => data.map(s=>({points:s.points.map(([x,y])=>[x,y]),width_nm:s.width}));
export const polygons = (outlines: Outline[]): Poly[] => outlines.map(o => ({outer:o.points.map(([x,y])=>[x,y]),holes:[]}));
export function geometry(req: Request): number {
 const folder=mkdtempSync(join(tmpdir(),'gerber-geometry-'));
 try {
  const input=join(folder,'geometry.json');
  const convert=(rows:Stroke[]|undefined)=>rows?.map(s=>({points:s.points,width:s.width_nm}));
  writeFileSync(input,JSON.stringify({...req,a_strokes:convert(req.a_strokes),b_strokes:convert(req.b_strokes),offset:(req.offset_nm??0)/1e6}));
  const binary=join(process.env.PCB_TOOLCHAIN_ROOT || fileRoot,'bin/iotroute-linux-x86_64');
  const libs=geosFiles();
  let area: number | undefined;
  runDaemonJob({label:'Gerber polygon geometry',inputs:[binary,input,...libs],image:PINNED_IMAGE,timeoutS:300,cpus:1,memGb:2,
   command:['sh','-c',`mkdir -p out && printf '0740bcd8875d89da579e6e26c4dbf6db3433b3c612c036f94bf095f109f0dfb8  in/libgeos-e4f0e0c1.so.3.11.4\\n8e95999d99584eb610f218d73a9d01cfcede1988363986d35891783754fce068  in/libgeos_c-1e72bdae.so.1.17.4\\n' | sha256sum -c >/dev/null && chmod +x in/iotroute-linux-x86_64 && export LD_LIBRARY_PATH=in GERBER_GEOS_LIBRARY=in/libgeos_c-1e72bdae.so.1.17.4 && in/iotroute-linux-x86_64 gerber-geos < in/geometry.json > out/geometry.json`]},out=>{
    const result=JSON.parse(readFileSync(join(out,'geometry.json'),'utf8'));area=result.area_mm2;
   });
  if(typeof area !== 'number' || !Number.isFinite(area) || area < 0) throw new Error('invalid polygon geometry result');
  return area;
 } finally {rmSync(folder,{recursive:true,force:true});}
}
