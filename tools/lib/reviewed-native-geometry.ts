/** Reconstruct the supported quarter-turn subset of reviewed native geometry.
 * Unsupported shapes/rotations fail closed and this is not review authorization. */
import {parseNative, children, single, properties} from './kicad-population.mjs';
import type {Tree} from './kicad-population.mjs';

type Point = [number,number];
function numbers(node:Tree|undefined, name:string, count:number): number[] {
  if (!node || node.length < count+1) throw new Error(`native ${name} missing`);
  return node.slice(1,count+1).map(value=>{
    if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value))) throw new Error(`invalid native ${name}`);
    return Number(value);
  });
}
function quarter(angle:number): number {
  const value=((angle%360)+360)%360;
  if (value%90 !== 0) throw new Error('non-quarter native rotation unsupported');
  return value/90;
}
function point(local:Point,q:number,origin:Point):Point {
  const [x,y]=local;
  const rotated:Point[]=[[x,y],[y,-x],[-x,-y],[-y,x]];
  return [rotated[q][0]+origin[0],rotated[q][1]+origin[1]];
}
function bounds(points:Point[]): [number,number,number,number] | null {
  if (!points.length) return null;
  return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
}
export function reconstructGeometry(text:string) {
  const board=parseNative(text);
  if (board[0] !== 'kicad_pcb') throw new Error('native PCB root missing');
  const edges:Point[]=[];
  for (const type of ['gr_line','gr_rect']) for (const item of children(board,type)) {
    if (single(item,'layer')?.[1] === 'Edge.Cuts') {
      edges.push(numbers(single(item,'start'),'edge start',2) as Point,numbers(single(item,'end'),'edge end',2) as Point);
    }
  }
  const refs:Record<string,unknown>={};
  for (const fp of children(board,'footprint')) {
    const ref=properties(fp).Reference;
    if (!ref || Object.hasOwn(refs,ref)) throw new Error('missing or duplicate footprint reference');
    const at=single(fp,'at');
    if (!at || (at.length !== 3 && at.length !== 4)) throw new Error('native footprint pose missing');
    const [x,y]=numbers(at,'footprint position',2), angle=at.length===4 ? numbers(at,'footprint pose',3)[2] : 0;
    const q=quarter(angle), origin:Point=[x,y], pads:Record<string,unknown[]>={}, courtyard:Point[]=[];
    let unsupported=false;
    for (const item of fp.slice(2)) {
      if (!Array.isArray(item)) continue;
      if (item[0] === 'pad') {
        const number=item[1],kind=item[2],shape=item[3];
        if (typeof number !== 'string' || typeof kind !== 'string' || typeof shape !== 'string') throw new Error('malformed native pad');
        const padAt=single(item,'at');
        if (padAt && (padAt.length !== 3 && padAt.length !== 4)) throw new Error('unsupported pad position');
        const [px,py]=padAt ? numbers(padAt,'pad position',2) : [0,0];
        const padAngle=padAt?.length===4 ? numbers(padAt,'pad pose',3)[2] : angle;
        const pq=quarter(padAngle), size=numbers(single(item,'size'),'pad size',2);
        if (size.some(v=>v<=0)) throw new Error('invalid native pad size');
        const layers=single(item,'layers')?.slice(1) ?? [];
        if (layers.some(v=>typeof v !== 'string')) throw new Error('invalid pad layers');
        if (!Object.hasOwn(pads,number)) Object.defineProperty(pads,number,{value:[],enumerable:true});
        pads[number].push({center:point([px,py],q,origin),shape,size:pq%2 ? [size[1],size[0]] : size,axis_aligned:true,layers,kind});
      } else if (['F.CrtYd','B.CrtYd'].includes(String(single(item,'layer')?.[1]))) {
        if (!['fp_line','fp_rect'].includes(String(item[0]))) {unsupported=true; continue;}
        courtyard.push(point(numbers(single(item,'start'),'courtyard start',2) as Point,q,origin),
          point(numbers(single(item,'end'),'courtyard end',2) as Point,q,origin));
      }
    }
    const lock=single(fp,'locked');
    const locked=fp.some(value=>value==='locked') || (!!lock && lock[1] !== 'no');
    Object.defineProperty(refs,ref,{enumerable:true,value:{origin,quarter:q,pads,courtyard:unsupported?null:bounds(courtyard),locked}});
  }
  return {refs,bounds:bounds(edges)};
}
