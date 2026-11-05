// Gerber polygon operations execute in the same pinned Linux worker as board-json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaemonJob } from './daemon-job.ts';
import { PINNED_IMAGE } from './env.mjs';
import { fileRoot } from './project-root.mjs';
import type { Xy } from './copper-graph.ts';
import type { Outline } from './copper-graph.ts';

export type Poly = {outer: number[][]; holes: number[][][]};
export type Stroke = {points:number[][];width_nm:number};
export type Request = {operation: 'intersection'|'buffer_intersection'; a: Poly[]; b: Poly[]; a_strokes?:Stroke[]; b_strokes?:Stroke[]; offset_nm?: number};
export const strokes = (data:{points:Xy[];width:number}[]):Stroke[] => data.map(s=>({points:s.points.map(([x,y])=>[Math.round(x*1e6),Math.round(y*1e6)]),width_nm:Math.round(s.width*1e6)}));
export const polygons = (outlines: Outline[]): Poly[] => outlines.map(o => ({outer:o.points.map(([x,y])=>[Math.round(x*1e6),Math.round(y*1e6)]),holes:[]}));
export function geometry(req: Request): number {
 const folder=mkdtempSync(join(tmpdir(),'gerber-geometry-'));
 try {
  const input=join(folder,'geometry.json');writeFileSync(input,JSON.stringify(req));
  const binary=join(process.env.PCB_TOOLCHAIN_ROOT || fileRoot,'bin/iotroute-linux-x86_64');
  let area: number | undefined;
  runDaemonJob({label:'Gerber polygon geometry',inputs:[binary,input],image:PINNED_IMAGE,timeoutS:300,cpus:1,memGb:2,
   command:['sh','-c','mkdir -p out && chmod +x in/iotroute-linux-x86_64 && in/iotroute-linux-x86_64 gerber-geometry < in/geometry.json > out/geometry.json']},out=>{
    const result=JSON.parse(readFileSync(join(out,'geometry.json'),'utf8'));area=result.signed_area_nm2;
   });
  if(typeof area !== 'number' || !Number.isFinite(area) || area < 0) throw new Error('invalid polygon geometry result');
  return area / 1e12;
 } finally {rmSync(folder,{recursive:true,force:true});}
}
