// Conservative footprint-silk clipping against plotted pad mask polygons. Coordinates are millimetres.
// Work is assembled in memory: unsupported geometry throws before any board can be saved.
import {spawnSync} from 'node:child_process';
import {BoardEdit,itemIds,mmText} from './board-edit.ts';
import {toBoard,toFootprint} from './board-silk.ts';
import {Outline,type Xy} from './copper-graph.ts';
import {childForms} from './footprint-move.ts';
import {iotrouteBin} from './iotroute-bin.ts';
import {kids,parse,type SList} from './sexpr.ts';

const STEP=.02, MINRUN=.2, CLEARANCE=.18; // 0.15 required + 0.01 legacy reserve + 0.02 plot/chord reserve
const child=(f:SList,k:string)=>kids(f,k)[0];
const point=(f:SList,k:string):Xy=>{const p=child(f,k);if(!p||p.length<3)throw new Error(`silk clip: missing ${k} point`);const q:[number,number]=[Number(p[1]),Number(p[2])];if(!q.every(Number.isFinite))throw new Error('silk clip: invalid point');return q;};
const distance=(a:Xy,b:Xy)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const mix=(a:Xy,b:Xy,t:number):Xy=>[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])];
function edgeDistance(p:Xy,a:Xy,b:Xy):number {const d=(b[0]-a[0])**2+(b[1]-a[1])**2;return distance(p,mix(a,b,d?Math.max(0,Math.min(1,((p[0]-a[0])*(b[0]-a[0])+(p[1]-a[1])*(b[1]-a[1]))/d)):0));}
function bad(p:Xy,zones:Outline[],gap:number):boolean{return zones.some(z=>p[0]>=z.minX-gap&&p[0]<=z.maxX+gap&&p[1]>=z.minY-gap&&p[1]<=z.maxY+gap&&(z.locate(p)>=0||z.points.some((a,i)=>edgeDistance(p,a,z.points[(i+1)%z.points.length]!)<=gap)));}
export function freeRuns(points:Xy[],zones:Outline[],gap:number):[number,number][] {
 const out:[number,number][]=[];let start:number|undefined;
 for(let i=0;i<points.length;i++) {
  // Half a sample interval of reserve ensures a short opening between free samples cannot be bridged.
  const unsafe=bad(points[i]!,zones,gap+STEP/2);
  if(!unsafe){if(start===undefined)start=i;}else if(start!==undefined){out.push([start,i-1]);start=undefined;}
 }
 if(start!==undefined)out.push([start,points.length-1]);return out;
}
function samples(a:Xy,b:Xy):Xy[]{const n=Math.max(2,Math.ceil(distance(a,b)/STEP)+1);return Array.from({length:n},(_,i)=>mix(a,b,i/(n-1)));}
function arc(a:Xy,m:Xy,b:Xy):{centre:Xy;radius:number;start:number;sweep:number}{
 const d=2*(a[0]*(m[1]-b[1])+m[0]*(b[1]-a[1])+b[0]*(a[1]-m[1]));if(Math.abs(d)<1e-12)throw new Error('silk clip: degenerate arc');
 const sq=(p:Xy)=>p[0]**2+p[1]**2;
 const c:Xy=[(sq(a)*(m[1]-b[1])+sq(m)*(b[1]-a[1])+sq(b)*(a[1]-m[1]))/d,(sq(a)*(b[0]-m[0])+sq(m)*(a[0]-b[0])+sq(b)*(m[0]-a[0]))/d];
 const angle=(p:Xy)=>Math.atan2(p[1]-c[1],p[0]-c[0]),start=angle(a),mod=(v:number)=>(v+2*Math.PI)%(2*Math.PI),ccw=mod(angle(b)-start);
 return {centre:c,radius:distance(a,c),start,sweep:mod(angle(m)-start)<ccw?ccw:ccw-2*Math.PI};
}
const signedArea=(p:Xy[])=>p.reduce((sum,a,i)=>{const b=p[(i+1)%p.length]!;return sum+a[0]*b[1]-b[0]*a[1];},0)/2;
export type PolygonBoolean=(operation:'offset'|'difference',a:Xy[][],b:Xy[][],offset:number)=>Xy[][];
export const polygonBoolean:PolygonBoolean=(operation,a,b,offset)=>{
 const polys=(p:Xy[][])=>p.map(outer=>({outer:outer.map(q=>q.map(v=>Math.round(v*1e6))),holes:[]}));
 const result=spawnSync(iotrouteBin(),['gerber-geometry'],{input:JSON.stringify({operation,a:polys(a),b:polys(b),offset_nm:Math.round(offset*1e6)}),encoding:'utf8',maxBuffer:64*1024*1024,timeout:60000});
 if(result.error||result.status!==0)throw new Error(`silk clip polygon operation failed: ${result.error?.message??result.stderr}`);
 const rings:unknown=JSON.parse(result.stdout).rings;
 if(!Array.isArray(rings)||rings.some(r=>!Array.isArray(r)||r.length<3||r.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>!Number.isSafeInteger(v)))))throw new Error('silk clip: invalid polygon operation result');
 return (rings as number[][][]).map(r=>r.map(p=>[p[0]!/1e6,p[1]!/1e6] as Xy));
};
export interface ClipResult {text:string;cut:number;pieces:number;polygons:number;gone:number}
export function clipSilk(board:string,masks:Record<'F'|'B',Outline[]>,boolean:PolygonBoolean=polygonBoolean):ClipResult {
 const edit=new BoardEdit(board),id=itemIds(board,'silk-clip'),result:ClipResult={text:board,cut:0,pieces:0,polygons:0,gone:0};
 const root=parse(board),pads:Record<'F'|'B',Xy[]>={F:[],B:[]};
 const pose=(f:SList)=>{const at=child(f,'at');return {at:[Number(at?.[1]??0),Number(at?.[2]??0)] as Xy,angle:Number(at?.[3]??0)};};
 for(const fp of kids(root,'footprint'))for(const pad of kids(fp,'pad'))for(const side of ['F','B'] as const){const layers=child(pad,'layers')??[];if(layers.includes(side+'.Mask')||layers.includes('*.Mask'))pads[side].push(toBoard(point(pad,'at'),pose(fp)));}
 for(const span of childForms(board).filter(s=>s.kind==='footprint')) {
  const raw=board.slice(span.start,span.end),fp=parse(raw),position=pose(fp);
  const global=(p:Xy)=>toBoard(p,position),local=(p:Xy)=>toFootprint(p,position);
  for(const s of childForms(raw).filter(s=>['fp_line','fp_rect','fp_poly','fp_arc','fp_circle','fp_curve'].includes(s.kind))) {
   const text=raw.slice(s.start,s.end),f=parse(text),layer=String(child(f,'layer')?.[1]);if(!['F.SilkS','B.SilkS'].includes(layer))continue;
   const side=layer[0] as 'F'|'B',zones=masks[side];if(!zones.length)continue;
   const uuid=String(child(f,'uuid')?.[1]??'');if(!uuid)throw new Error('silk clip: silk item has no UUID');
   const width=Number(child(child(f,'stroke')??[],'width')?.[1]??child(f,'width')?.[1]??0);if(!Number.isFinite(width)||width<0)throw new Error('silk clip: invalid stroke width');
   if(s.kind==='fp_curve')throw new Error('silk clip: Bezier silk cannot yet be clipped safely');
   const xy=(p:Xy)=>{const q=local(p);return `${mmText(q[0])} ${mmText(q[1])}`;};
   const line=(a:Xy,b:Xy)=>`(fp_line (start ${xy(a)}) (end ${xy(b)}) (stroke (width ${mmText(width)}) (type default)) (layer "${layer}") (uuid "${id()}"))`;
   const arcText=(a:Xy,m:Xy,b:Xy)=>`(fp_arc (start ${xy(a)}) (mid ${xy(m)}) (end ${xy(b)}) (stroke (width ${mmText(width)}) (type default)) (layer "${layer}") (uuid "${id()}"))`;
   let replacement:string[]=[];
   if(s.kind==='fp_poly'&&child(f,'fill')?.[1]==='yes') {
    const pts=kids(child(f,'pts')??[],'xy').map(p=>global([Number(p[1]),Number(p[2])]));
    if(!pts.length||child(f,'pts')!.some(p=>Array.isArray(p)&&p[0]!=='xy'))throw new Error('silk clip: unsupported polygon vertices');
    const grown=boolean('offset',zones.map(z=>[...z.points]),[],CLEARANCE);
    // A hole is a real opening, not another filled polygon. Refuse it until a native hole-preserving writer exists.
    if(grown.some(r=>signedArea(r)<0))throw new Error('silk clip: mask offset has holes that cannot be represented safely');
    const cut=boolean('difference',[pts],grown,0);
    if(cut.some(r=>signedArea(r)<0))throw new Error('silk clip: filled polygon subtraction produced a hole; no board was changed');
    if(Math.abs(cut.reduce((n,r)=>n+signedArea(r),0)-Math.abs(signedArea(pts)))<1e-9)continue;
    replacement=cut.map(r=>`(fp_poly (pts ${r.map(p=>`(xy ${xy(p)})`).join(' ')}) (stroke (width ${mmText(width)}) (type default)) (fill yes) (layer "${layer}") (uuid "${id()}"))`);
    result.polygons++;
   } else if(['fp_line','fp_rect','fp_poly'].includes(s.kind)) {
    let pts:Xy[];
    if(s.kind==='fp_poly'){const form=child(f,'pts');if(!form||form.slice(1).some(p=>!Array.isArray(p)||p[0]!=='xy'))throw new Error('silk clip: unsupported polygon vertices');pts=kids(form,'xy').map(p=>global([Number(p[1]),Number(p[2])]));}
    else {const a=point(f,'start'),b=point(f,'end');pts=(s.kind==='fp_line'?[a,b]:[a,[b[0],a[1]],b,[a[0],b[1]]] as Xy[]).map(global);}
    if(pts.length<2)throw new Error('silk clip: empty silk polygon');
    const edges=pts.slice(0,s.kind==='fp_line'?1:pts.length).map((a,i)=>[a,pts[(i+1)%pts.length]!] as const);let touched=false;
    for(const [a,b] of edges){const samples_=samples(a,b),runs=freeRuns(samples_,zones,CLEARANCE+width/2);if(runs.length!==1||runs[0]![0]!==0||runs[0]![1]!==samples_.length-1)touched=true;for(const [i,j] of runs)if(distance(samples_[i]!,samples_[j]!)>=MINRUN)replacement.push(line(samples_[i]!,samples_[j]!));}
    if(!touched)continue;result.cut++;result.pieces+=replacement.length;
   } else {
    const circle=s.kind==='fp_circle';let c:Xy,r:number,start:number,sweep:number;
    if(circle){c=global(point(f,'center'));r=distance(c,global(point(f,'end')));start=0;sweep=2*Math.PI;}else {const a=arc(global(point(f,'start')),global(point(f,'mid')),global(point(f,'end')));c=a.centre;r=a.radius;start=a.start;sweep=a.sweep;}
    if(!(r>0)||!Number.isFinite(r))throw new Error('silk clip: invalid arc radius');
    const at=(angle:number,centre=c):Xy=>[centre[0]+r*Math.cos(angle),centre[1]+r*Math.sin(angle)];
    if(circle&&r<=.5){const ring=(centre:Xy)=>[centre,...Array.from({length:64},(_,i)=>at(i*Math.PI/32,centre))];if(!ring(c).some(p=>bad(p,zones,CLEARANCE+width/2)))continue;
     const near=pads[side].reduce<Xy|undefined>((best,p)=>!best||distance(p,c)<distance(best,c)?p:best,undefined);if(!near)throw new Error('silk clip: mask has no matching pad centre');const d=distance(c,near);let moved:Xy|undefined;
     for(let k=1;d>0&&k<=24;k++){const q:Xy=[c[0]+(c[0]-near[0])/d*.05*k,c[1]+(c[1]-near[1])/d*.05*k];if(!ring(q).some(p=>bad(p,zones,CLEARANCE+width/2))){moved=q;break;}}
     if(moved){replacement=[text.replace(/\(center [^)]*\)/,`(center ${xy(moved)})`).replace(/\(end [^)]*\)/,`(end ${xy([moved[0]+r,moved[1]])})`)];result.cut++;}
    } else {const n=Math.max(8,Math.ceil(Math.abs(sweep)*r/STEP)),points=Array.from({length:n+1},(_,i)=>at(start+sweep*i/n));const runs=freeRuns(points,zones,CLEARANCE+width/2);if(runs.length===1&&runs[0]![0]===0&&runs[0]![1]===n)continue;
     if(circle&&runs.length>1&&runs[0]![0]===0&&runs.at(-1)![1]===n){const first=runs.shift()!,last=runs.pop()!;runs.push([last[0],first[1]+n]);}
     for(const [i,j] of runs){const a=start+sweep*i/n,b=start+sweep*j/n;if(Math.abs(b-a)*r>=MINRUN)replacement.push(arcText(at(a),at((a+b)/2),at(b)));}result.cut++;result.pieces+=replacement.length;
    }
   }
   if(!replacement.length){edit.remove(uuid);result.gone++;}else {
    replacement[0]=replacement[0]!.replace(/\(uuid "[^"]*"\)/,`(uuid "${uuid}")`);
    edit.replace(uuid,replacement.join('\n'));
   }
  }
 }
 result.text=edit.text();return result;
}
