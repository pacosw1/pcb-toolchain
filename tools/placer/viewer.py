#!/usr/bin/env python3
"""Self-contained HTML viewer of a compaction run (run.json from compact_cli.py).

  $PY tools/placer/viewer.py RUN.json OUT.html [--frames-json FRAMES.json]

One frame per anneal epoch (best pose of the epoch) and one per step result (legalized pose + router result).
Left: layout (units colored by block, halos dashed, ratsnest colored by length, region box, board outline).
Right: RUDY congestion (same scale on all frames; cells over capacity in red). Below: cost parts over the
frames with a marker, and the halo scale s + unrouted per step. Click a part: name, refs, block, nets.
No external files. FRAMES.json keeps the per-frame data for a later replay.
"""
import argparse
import base64
import json
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from placer import cost  # noqa: E402

VIEW_PARAMS = {'pin_demand': 0.5}


def _r1(v):
    return round(float(v), 1)


def frame(pr, pose, outline):
    rects = [[[_r1(v) for v in r[:4]] for r in cost.world_rects(u, pose[i])] for i, u in enumerate(pr['units'])]
    segs = []
    for n in pr['nets']:
        pts = []
        for q in n['pins']:
            x, y, r = pose[q[0]]
            a = cost.rot_rect(q[1:5], r)
            pts.append(((a[0] + a[2]) / 2 + x, (a[1] + a[3]) / 2 + y))
        for p in pts[1:]:
            segs.append([_r1(pts[0][0]), _r1(pts[0][1]), _r1(p[0]), _r1(p[1])])
    g = cost.rudy_grid(pr, [tuple(p) for p in pose], dict(VIEW_PARAMS))
    return {'rects': rects, 'segs': segs, 'outline': [[_r1(a), _r1(b)] for a, b in outline], 'heat': g}


def build(run, params=None):
    pr = run['problem']
    frames = []
    for n, st in enumerate(run['steps']):
        k = st['k']
        xs = [p[0] for p in pr['board']['outline']]
        ys = [p[1] for p in pr['board']['outline']]
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        outline = [(cx + (x - cx) * k, cy + (y - cy) * k) for x, y in pr['board']['outline']]
        for h in st['history']:
            f = frame(pr, h['pose'], outline)
            f.update(step=n, label='step %d epoch %d' % (n, h['epoch']), s=st['s'], cost=h['cost'],
                     comp=h['components'], unrouted=None)
            frames.append(f)
        if st['pose'] is None:  # no search result
            continue
        f = frame(pr, st['pose'], outline)
        f.update(step=n, label='step %d result' % n, s=st['s'], cost=st['cost'],
                 comp=(st['history'][-1]['components'] if st['history'] else {}),
                 unrouted=st['unrouted'])
        frames.append(f)
    hmax = max([float(f['heat'].max()) for f in frames] + [1e-9])
    cap = cost.threshold(dict(VIEW_PARAMS))
    grid = cost.Grid(pr['board'], cost.params_with_defaults(dict(VIEW_PARAMS))['rudy_cell'])
    for f in frames:
        g = f['heat']
        f['heat'] = base64.b64encode(np.clip(g / hmax * 254, 0, 254).astype(np.uint8).tobytes()).decode()
        f['over'] = base64.b64encode((g > cap).astype(np.uint8).tobytes()).decode()
    unet = [[] for _ in pr['units']]
    for n in pr['nets']:
        for q in n['pins']:
            unet[q[0]].append(n['name'])
    units = [{'name': u['name'], 'refs': u['refs'], 'block': u['name'] if u.get('box') else '',
              'fixed': u['fixed'], 'halo': _r1(max([r[4] for r in u['rects']] + [0])), 'nets': sorted(set(unet[i]))}
             for i, u in enumerate(pr['units'])]
    data = {'units': units, 'frames': frames, 'grid': {'x0': grid.x0, 'y0': grid.y0, 'c': grid.c, 'nx': grid.nx,
                                                        'ny': grid.ny},
            'region': (pr.get('region') or {}).get('box'),
            'steps': [{'s': t['s'], 'k': t['k'], 'unrouted': t['unrouted'], 'passed': t['passed']} for t in run['steps']],
            'verdict': run.get('verdict', ''), 'hmax': hmax, 'cap': cap}
    return HTML.replace('/*DATA*/null', json.dumps(data, separators=(',', ':'))), data


HTML = r"""<!doctype html><html><head><meta charset="utf-8"><title>Placer Run</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#fff;--fg:#222;--mut:#777;--line:#ccc}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#ddd;--mut:#999;--line:#444}}
body{background:var(--bg);color:var(--fg);font:13px system-ui,sans-serif;margin:12px}
.row{display:flex;gap:10px;flex-wrap:wrap}canvas{border:1px solid var(--line);max-width:100%}
#info{min-height:3em;white-space:pre-wrap;color:var(--mut)}button{font:inherit}
</style></head><body>
<div id="verdict"></div>
<div class="row"><canvas id="lay" width="620" height="360"></canvas><canvas id="heat" width="620" height="360"></canvas></div>
<div><button id="play">Play</button> <input id="sl" type="range" min="0" value="0" style="width:60%"> <span id="lbl"></span></div>
<canvas id="chart" width="1250" height="200"></canvas>
<div id="info">Click a part.</div>
<script>
const D=/*DATA*/null;
const lay=document.getElementById('lay'),heat=document.getElementById('heat'),chart=document.getElementById('chart');
const sl=document.getElementById('sl');sl.max=D.frames.length-1;
document.getElementById('verdict').textContent='Verdict: '+D.verdict;
let bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9;
for(const f of D.frames)for(const [x,y] of f.outline){bx0=Math.min(bx0,x);by0=Math.min(by0,y);bx1=Math.max(bx1,x);by1=Math.max(by1,y);}
const sc=Math.min((lay.width-20)/(bx1-bx0),(lay.height-20)/(by1-by0));
const X=x=>10+(x-bx0)*sc,Y=y=>10+(y-by0)*sc;
function col(s){let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))%360;return 'hsl('+h+',60%,50%)';}
function dec(b){const s=atob(b),a=new Uint8Array(s.length);for(let i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;}
function outline(c,f){c.strokeStyle='#888';c.beginPath();f.outline.forEach(([x,y],i)=>i?c.lineTo(X(x),Y(y)):c.moveTo(X(x),Y(y)));c.closePath();c.stroke();
 if(D.region){const r=D.region;c.strokeStyle='#c0c';c.setLineDash([2,2]);c.strokeRect(X(r[0]),Y(r[1]),(r[2]-r[0])*sc,(r[3]-r[1])*sc);c.setLineDash([]);}}
function draw(i){const f=D.frames[i],c=lay.getContext('2d');c.clearRect(0,0,lay.width,lay.height);
 let L=1;for(const s of f.segs)L=Math.max(L,Math.hypot(s[2]-s[0],s[3]-s[1]));
 for(const s of f.segs){const t=Math.hypot(s[2]-s[0],s[3]-s[1])/L;c.strokeStyle='hsla('+(120-120*t)+',80%,45%,.5)';c.beginPath();c.moveTo(X(s[0]),Y(s[1]));c.lineTo(X(s[2]),Y(s[3]));c.stroke();}
 f.rects.forEach((rs,u)=>{const U=D.units[u];c.fillStyle=U.block?col(U.block):(U.fixed?'#888':'#5a8');c.globalAlpha=.55;
  let a=1e9,b=1e9,e=-1e9,g=-1e9;for(const r of rs){c.fillRect(X(r[0]),Y(r[1]),(r[2]-r[0])*sc,(r[3]-r[1])*sc);a=Math.min(a,r[0]);b=Math.min(b,r[1]);e=Math.max(e,r[2]);g=Math.max(g,r[3]);}
  c.globalAlpha=1;if(!U.fixed&&U.halo>0){const h=U.halo/2;c.strokeStyle='#999';c.setLineDash([3,3]);c.strokeRect(X(a-h),Y(b-h),(e-a+2*h)*sc,(g-b+2*h)*sc);c.setLineDash([]);}});
 outline(c,f);
 const h=heat.getContext('2d');h.clearRect(0,0,heat.width,heat.height);const G=D.grid,v=dec(f.heat),o=dec(f.over);
 for(let j=0;j<G.ny;j++)for(let k=0;k<G.nx;k++){const q=j*G.nx+k;if(!v[q])continue;h.fillStyle=o[q]?'rgba(220,0,0,'+(.3+v[q]/400)+')':'rgba(40,90,220,'+(v[q]/255)+')';
  h.fillRect(X(G.x0+k*G.c),Y(G.y0+j*G.c),G.c*sc+.5,G.c*sc+.5);}
 outline(h,f);
 document.getElementById('lbl').textContent=f.label+'  s='+f.s.toFixed(2)+'  cost='+f.cost.toFixed(0)+(f.unrouted!=null?'  unrouted='+f.unrouted:'');
 drawChart(i);}
const keys=['hpwl','cong','overlap','oob'],kc=['#36c','#c63','#393','#939'];
function drawChart(i){const c=chart.getContext('2d'),W=chart.width,H=chart.height-40,n=D.frames.length;c.clearRect(0,0,W,chart.height);
 keys.forEach((k,j)=>{let m=1e-9;for(const f of D.frames)m=Math.max(m,f.comp[k]||0);c.strokeStyle=kc[j];c.beginPath();
  D.frames.forEach((f,t)=>{const x=10+t*(W-20)/Math.max(n-1,1),y=10+(H-10)*(1-(f.comp[k]||0)/m);t?c.lineTo(x,y):c.moveTo(x,y);});c.stroke();
  c.fillStyle=kc[j];c.fillText(k,10+j*70,chart.height-22);});
 const x=10+i*(W-20)/Math.max(n-1,1);c.strokeStyle='#000';c.beginPath();c.moveTo(x,5);c.lineTo(x,H);c.stroke();
 c.fillStyle=getComputedStyle(document.body).color;c.fillText(D.steps.map((s,k)=>'step '+k+': s='+s.s.toFixed(2)+' k='+s.k.toFixed(2)+' unrouted='+s.unrouted+(s.passed?' PASS':' FAIL')).join('   '),10,chart.height-6);}
sl.oninput=()=>draw(+sl.value);
let timer=null;document.getElementById('play').onclick=e=>{if(timer){clearInterval(timer);timer=null;e.target.textContent='Play';return;}
 e.target.textContent='Pause';timer=setInterval(()=>{sl.value=(+sl.value+1)%D.frames.length;draw(+sl.value);},150);};
lay.onclick=e=>{const b=lay.getBoundingClientRect(),px=(e.clientX-b.left)*lay.width/b.width,py=(e.clientY-b.top)*lay.height/b.height;
 const x=(px-10)/sc+bx0,y=(py-10)/sc+by0,f=D.frames[+sl.value];
 f.rects.forEach((rs,u)=>{for(const r of rs)if(x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3]){const U=D.units[u];
  document.getElementById('info').textContent=U.name+(U.fixed?' (fixed)':'')+'  block: '+(U.block||'-')+'  halo: '+U.halo+' mm\nrefs: '+U.refs.join(' ')+'\nnets: '+U.nets.join(' ');}});};
draw(0);
</script></body></html>"""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('run')
    ap.add_argument('out')
    ap.add_argument('--frames-json')
    a = ap.parse_args(argv)
    html, data = build(json.load(open(a.run)))
    open(a.out, 'w').write(html)
    if a.frames_json:
        json.dump(data, open(a.frames_json, 'w'), separators=(',', ':'))
    print('%s: %d frames, %.1f MB' % (a.out, len(data['frames']), len(html) / 1e6))


if __name__ == '__main__':
    main()
