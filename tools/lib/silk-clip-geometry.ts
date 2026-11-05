// Pure sampling of silk strokes against plotted pad-mask openings. Coordinates are board mm, y up.
import {Outline, type Xy} from './copper-graph.ts';
const STEP_MM=0.02, MIN_RUN_MM=0.2;
const dist=(a:Xy,b:Xy)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
function edgeDistance(p:Xy,a:Xy,b:Xy):number {
 const dx=b[0]-a[0],dy=b[1]-a[1],d=dx*dx+dy*dy;
 const t=d===0?0:Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/d));
 return Math.hypot(p[0]-(a[0]+t*dx),p[1]-(a[1]+t*dy));
}
/** A point is blocked by an opening or its conservative radial clearance. */
export function blockedByMask(p:Xy,openings:readonly Outline[],clearance:number):boolean {
 if(!Number.isFinite(clearance)||clearance<0)throw new Error('invalid silk clearance');
 return openings.some(o=>{
  if(p[0]<o.minX-clearance||p[0]>o.maxX+clearance||p[1]<o.minY-clearance||p[1]>o.maxY+clearance)return false;
  if(o.locate(p)!==-1)return true;
  for(let i=0;i<o.points.length;i++){const [a,b]=o.edge(i);if(edgeDistance(p,a,b)<=clearance)return true;}
  return false;
 });
}
/** Preserve the legacy 0.02 mm sampling and 0.2 mm minimum free run for a straight segment. */
export function clipSilkSegment(a:Xy,b:Xy,openings:readonly Outline[],width:number):{changed:boolean;runs:[Xy,Xy][]} {
 if(![...a,...b,width].every(Number.isFinite)||width<0)throw new Error('invalid silk segment');
 // The original clip used PAD_CLR + 0.01 mm and KiCad's 0.005 mm outside polygon tolerance.
 const clearance=0.15+0.01+width/2+0.005;
 const n=Math.max(2,Math.trunc(dist(a,b)/STEP_MM)+1);
 const points=Array.from({length:n},(_,i):Xy=>[a[0]+(b[0]-a[0])*i/(n-1),a[1]+(b[1]-a[1])*i/(n-1)]);
 const runs:[Xy,Xy][]=[];let first=-1,changed=false;
 const finish=(end:number)=>{if(first>=0&&dist(points[first]!,points[end]!)>=MIN_RUN_MM)runs.push([points[first]!,points[end]!]);first=-1;};
 for(let i=0;i<n;i++){if(blockedByMask(points[i]!,openings,clearance)){changed=true;finish(i-1);}else if(first<0)first=i;}
 finish(n-1);
 return {changed,runs:changed?runs:[[a,b]]};
}
