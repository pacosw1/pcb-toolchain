#!/usr/bin/env python3
"""Live web view of routing jobs over Tailscale (W12, CIP #829); standard library only, read-only.

  python3 tools/route_live.py --serve [OUTDIR ...] [--port 8787]
      prints the URL http://localhost:8787/ and serves until Ctrl-C.
      Runs: every /tmp/w*/run* directory plus the OUTDIRs given. No launchd: run it in a terminal pane or with
      `nohup python3 tools/route_live.py --serve >/tmp/route_live.log 2>&1 &`.

Pages (GET only; no write endpoint, no secret, no directory listing outside the run roots):
  /                    index of active runs (progress.jsonl written in the last 60 s and no outcome.json) and recent ones
  /run/<id>            one run, updated in place by server-sent events (no reload; meta refresh only when the browser
                       has no EventSource; a run selector switches runs in place with history.pushState; a LIVE/FINISHED
                       banner; the stream sends the finished state once and closes): the route_status line, stage, elapsed, open, best, vias, ETA, the
                       pass trend (inline SVG), the action log tail (tools/run_record.py, derived in memory, nothing
                       written), the latest board frame (OUTDIR/snapshots/latest.png from tools/board_frame.py; a
                       placeholder until the first one)
  /api/runs            JSON {active: [...], recent: [...]}; both pages poll it every 3 s (selector, strip, index rows)
  /run/<id>/frame.png  the latest frame
  /run/<id>/events     text/event-stream: a full event on connect, then one delta event per change (the run dir is polled
                       every 1 s: progress.jsonl, run log size or latest.png mtime), a heartbeat comment every 15 s
The <id> is the run's path under /tmp (w12/run-1) or "x/<basename>" for a command-line OUTDIR; a request for a path
that is not in the current run list is a 404. The server binds the Tailscale address 100.64.0.1 only
(--bind accepts a 100.64.0.0/10 Tailscale address or 127.0.0.1 for tests; 0.0.0.0, :: and public addresses are refused).
Single column, large text: readable on an iPhone.
"""
import argparse
import glob
import html
import ipaddress
import json
import os
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_record  # noqa: E402

TS_ADDR = '100.64.0.1'
TS_HOST = 'localhost'
PORT = 8787
ROOTS = ('/tmp/w*/run*',)
ACTIVE_S = 60
REFRESH_S = 3
POLL_API_MS = 3000
TAIL = 25
LOG_N = 300

CSS = """body{font-family:-apple-system,Helvetica,sans-serif;font-size:20px;margin:12px;max-width:720px;background:#111;color:#eee}
h1{font-size:24px;margin:8px 0}h2{font-size:20px;margin:16px 0 6px;color:#9cf}a{color:#9cf;text-decoration:none}
.status{font-size:22px;font-weight:600;padding:8px;background:#222;border-radius:8px;word-break:break-word}
table{border-collapse:collapse;width:100%}td{padding:6px 4px;border-bottom:1px solid #333;vertical-align:top}
td.k{color:#aaa;width:38%}pre{font-size:14px;white-space:pre-wrap;word-break:break-word;background:#181818;padding:8px;border-radius:8px}
img,svg{width:100%;height:auto;border-radius:8px;background:#000}.dim{color:#888;font-size:16px}
#board{position:relative}#board img{display:block}#board #b{position:absolute;top:0;left:0;opacity:0;transition:opacity .3s}
#dot{display:inline-block;width:14px;height:14px;border-radius:7px;background:#f90;margin-right:6px;vertical-align:middle}
#dot.live{background:#3c6;animation:pulse 1.2s infinite}@keyframes pulse{50%{opacity:.25}}
.banner{font-size:30px;font-weight:700;padding:14px;border-radius:10px;background:#333;color:#ccc;margin-bottom:8px}
.banner.live{background:#143d22;color:#7f9}.banner.fin{background:#2a2a2a;color:#aaa}
.banner #dot{width:20px;height:20px;border-radius:10px;margin-right:10px}.banner #dot:not(.live){background:#777;animation:none}
#sel{width:100%;font-size:18px;padding:10px;background:#222;color:#eee;border:1px solid #444;border-radius:8px;margin:6px 0}
.player{background:#181818;border-radius:10px;padding:10px}.player input[type=range]{width:100%;height:44px}
.player button,.player select{font-size:20px;min-height:48px;padding:0 16px;margin:4px 4px 4px 0;background:#222;color:#eee;border:1px solid #444;border-radius:10px}
.player button.on{background:#143d22;color:#7f9}#hint{color:#fc6;font-size:16px;display:none}
.lf button,#older{font-size:16px;min-height:44px;padding:0 12px;margin:2px;background:#222;color:#eee;border:1px solid #444;border-radius:8px}
.lf button.on{background:#234;color:#9cf}.lf input{font-size:16px;min-height:40px;margin:2px;background:#222;color:#eee;border:1px solid #444;border-radius:8px;padding:0 8px;width:9em}
#logbox{max-height:60vh;overflow:auto;background:#181818;border-radius:8px;padding:4px}
.rec{padding:5px 2px;border-bottom:1px solid #2a2a2a;font-size:15px;word-break:break-word}.rec .t{font-family:Menlo,monospace;color:#aaa;margin-right:6px}
.badge{display:inline-block;font-size:12px;padding:1px 7px;border-radius:9px;color:#111;margin-right:6px;vertical-align:middle}
.rec .why{color:#888;font-size:13px;margin-left:2px}.rec.pass{font-family:Menlo,monospace;font-size:13px;padding:2px}
.dn{color:#4d7;font-weight:700}.up{color:#f55;font-weight:700}.rec summary{color:#9cf;font-size:13px}.rec pre{font-size:12px;margin:2px 0}
.taps{display:none}.strip{display:flex;flex-direction:column;gap:6px}
.chip{display:block;padding:10px;background:#1c1c1c;border-radius:8px;font-size:16px;border:2px solid transparent;color:#eee}.chip.cur{border-color:#9cf}
@media(max-width:600px){#sel{display:none}.taps{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0}
.tap{display:block;min-height:48px;line-height:48px;padding:0 16px;background:#222;border-radius:10px;font-size:20px}.tap.live{color:#7f9}.tap.cur{border:2px solid #9cf;line-height:44px}}"""


def allowed_bind(addr):
    """True for a Tailscale (100.64.0.0/10) or loopback address; never 0.0.0.0, :: or a public address."""
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return ip.is_loopback or ip in ipaddress.ip_network('100.64.0.0/10')


class Runs:
    """The run directories the server may show: the glob roots plus the explicit OUTDIRs."""

    def __init__(self, extra=(), roots=ROOTS):
        self.extra = [os.path.abspath(p) for p in extra]
        self.roots = roots

    def ids(self):
        out = {}
        for pat in self.roots:
            for d in sorted(glob.glob(pat)):
                if os.path.isdir(d) and d.startswith('/tmp/'):
                    out[os.path.relpath(d, '/tmp')] = d
        for d in self.extra:
            if os.path.isdir(d):
                out['x/' + os.path.basename(d)] = d
        return out

    def resolve(self, rid):
        return self.ids().get(rid)


def _rows(path):
    try:
        return [json.loads(l) for l in open(path) if l.strip()]
    except (OSError, ValueError):
        return []


def status(outdir):
    """{'line', 'stage', 'elapsed_s', 'open', 'best', 'vias', 'eta_s', 'state', 'passes': [(pass, open)]}."""
    rows = _rows(os.path.join(outdir, 'progress.jsonl'))
    last = rows[-1] if rows else {}
    f = lambda v: '-' if v is None else v
    line = (f"{last['stage']} {last.get('elapsed_s')}s open={f(last.get('open'))} best={f(last.get('best_open'))} "
            f"vias={f(last.get('vias'))} eta={f(last.get('eta_s'))}") if last else 'no progress yet'
    outcome = None
    try:
        outcome = json.load(open(os.path.join(outdir, 'outcome.json')))
    except (OSError, ValueError):
        pass
    try:
        age = time.time() - os.path.getmtime(os.path.join(outdir, 'progress.jsonl'))
    except OSError:
        age = None
    state = (outcome.get('status', 'ended').upper() if outcome else
             'ACTIVE' if age is not None and age < ACTIVE_S else 'STALE' if age is not None else 'NO PROGRESS')
    return dict(line=line, stage=last.get('stage', '-'), elapsed_s=last.get('elapsed_s'), open=last.get('open'),
                best=last.get('best_open'), vias=last.get('vias'), eta_s=last.get('eta_s'), state=state, age_s=age,
                passes=[(r['pass'], r['open']) for r in rows if r.get('pass') is not None and r.get('open') is not None])


def trend_svg(passes, w=680, h=160):
    """Open connections per pass as a polyline; the last point labelled."""
    if len(passes) < 2:
        return '<svg viewBox="0 0 %d %d"><text x="10" y="30" fill="#888" font-size="18">no passes yet</text></svg>' % (w, h)
    xs = [p[0] for p in passes]
    ys = [p[1] for p in passes]
    x0, x1 = min(xs), max(xs) or 1
    y1 = max(ys) or 1
    pad = 24
    sx = lambda x: pad + (x - x0) / (x1 - x0 or 1) * (w - 2 * pad)
    sy = lambda y: h - pad - y / y1 * (h - 2 * pad)
    pts = ' '.join(f'{sx(x):.1f},{sy(y):.1f}' for x, y in passes)
    lx, ly = sx(xs[-1]), sy(ys[-1])
    return (f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none"><rect width="{w}" height="{h}" fill="#000"/>'
            f'<polyline points="{pts}" fill="none" stroke="#9cf" stroke-width="3"/>'
            f'<circle cx="{lx:.1f}" cy="{ly:.1f}" r="5" fill="#f66"/>'
            f'<text x="{pad}" y="18" fill="#888" font-size="14">open per pass (max {y1})</text>'
            f'<text x="{min(lx, w - 60):.1f}" y="{max(ly - 10, 16):.1f}" fill="#f66" font-size="16">{ys[-1]}</text></svg>')


def log_tail(outdir, n=TAIL):
    recs = run_record.ordered(run_record.view(outdir))
    return [run_record.fmt(r) for r in recs[-n:]]


def latest_frame(outdir):
    p = os.path.join(outdir, 'snapshots', 'latest.png')
    if os.path.isfile(p):
        return p
    frames = sorted(glob.glob(os.path.join(outdir, 'snapshots', '*.png')))
    return frames[-1] if frames else None


PLACEHOLDER = ('<svg viewBox="0 0 600 300"><rect width="600" height="300" fill="#000"/>'
               '<text x="300" y="150" fill="#666" font-size="24" text-anchor="middle">no board frame yet</text></svg>')


def page(title, body, script=''):
    meta = ''
    return (f'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'{meta}<title>{html.escape(title)}</title><style>{CSS}</style></head><body>{body}{script}</body></html>')


HEARTBEAT_S = 15
POLL_S = 1


def log_lines(outdir):
    return [run_record.fmt(r) for r in log_recs(outdir)]


def log_recs(outdir):
    """The structured run records (tools/run_record.py), in order; derived in memory, nothing written."""
    return run_record.ordered(run_record.view(outdir))


def _stat(path):
    try:
        st = os.stat(path)
        return st.st_size, st.st_mtime
    except OSError:
        return None


def change_key(outdir):
    """Cheap fingerprint of what the stream shows: progress.jsonl, the run log sizes, outcome, latest frame mtime."""
    return (_stat(os.path.join(outdir, 'progress.jsonl')), _stat(os.path.join(outdir, 'run.jsonl')),
            _stat(os.path.join(outdir, 'run.log')), _stat(os.path.join(outdir, 'outcome.json')),
            _stat(os.path.join(outdir, 'snapshots', 'latest.png')))


def snapshot_list(rid, d):
    """[{i, elapsed_s, pass, open, stage, url}] for every OUTDIR/snapshots/NNNN.json that has its NNNN.png, by elapsed_s."""
    out = []
    for jp in glob.glob(os.path.join(d, 'snapshots', '[0-9][0-9][0-9][0-9].json')):
        n = os.path.basename(jp)[:4]
        if not os.path.isfile(jp[:-5] + '.png'):
            continue
        try:
            m = json.load(open(jp))
            out.append(dict(i=int(n), elapsed_s=m.get('elapsed_s'), **{'pass': m.get('pass')}, open=m.get('open'),
                            stage=m.get('stage'), url=f'/run/{rid}/snapshots/{n}.png'))
        except (OSError, ValueError, AttributeError):
            pass
    out.sort(key=lambda e: (e['elapsed_s'] if e['elapsed_s'] is not None else 0, e['i']))
    return out


class Stream:
    """Builds the SSE payloads for one client: a full one first, then only the new passes and log lines."""

    def __init__(self, rid, outdir):
        self.rid, self.d = rid, outdir
        self.npass = 0
        self.nlog = 0
        self.key = None
        self.first = True

    def event(self):
        """The next payload, or None when nothing changed."""
        key = (change_key(self.d), is_live(self.d))
        if key == self.key:
            return None
        self.key = key
        s = status(self.d)
        lines = log_recs(self.d)
        full = self.first or len(s['passes']) < self.npass
        passes = s['passes'] if full else s['passes'][self.npass:]
        log_reset = self.first or len(lines) < self.nlog
        new_log = lines[-LOG_N:] if log_reset else lines[self.nlog:]
        log_start = len(lines) - len(new_log) if log_reset else None
        self.npass, self.nlog, self.first = len(s['passes']), len(lines), False
        f = latest_frame(self.d)
        frame = None
        if f:
            mt = os.path.getmtime(f)
            frame = dict(url=f'/run/{self.rid}/frame.png?t={int(mt * 1000)}', mtime=mt)
        fin = s['state'] != 'ACTIVE'
        return dict(status=s['state'], live=not fin, finished=fin, banner=banner_text(s), line=s['line'], stage=s['stage'], elapsed_s=s['elapsed_s'], open=s['open'],
                    best_open=s['best'], vias=s['vias'], eta_s=s['eta_s'], npasses=len(s['passes']),
                    full=full, passes=[list(p) for p in passes], log_reset=log_reset, log_tail=new_log, log_start=log_start, log_total=len(lines), frame=frame)


def is_live(outdir):
    """True while progress.jsonl is fresher than ACTIVE_S and there is no outcome.json."""
    if os.path.exists(os.path.join(outdir, 'outcome.json')):
        return False
    try:
        return time.time() - os.path.getmtime(os.path.join(outdir, 'progress.jsonl')) < ACTIVE_S
    except OSError:
        return False


def finish_label(s):
    """'STUCK 12 open' | 'COMPLETE' | 'TIMEOUT' | other outcome status | 'STALE' (no outcome, no recent progress)."""
    st = s['state']
    if st == 'STUCK':
        return f"STUCK {s['open'] if s['open'] is not None else '?'} open"
    return 'STALE' if st in ('STALE', 'NO PROGRESS') else st


def banner_text(s):
    return 'LIVE' if s['state'] == 'ACTIVE' else 'FINISHED: ' + finish_label(s)


def summary(runs):
    """The /api/runs payload: active runs first (newest progress first), then the recent ones."""
    act, rec = [], []
    for rid, d in runs.ids().items():
        s = status(d)
        try:
            mt = os.path.getmtime(os.path.join(d, 'progress.jsonl'))
        except OSError:
            mt = 0
        live = s['state'] == 'ACTIVE'
        item = dict(id=rid, live=live, state=s['state'], banner=banner_text(s), line=s['line'], stage=s['stage'],
                    elapsed_s=s['elapsed_s'], open=s['open'], best_open=s['best'], mtime=mt)
        (act if live else rec).append(item)
    act.sort(key=lambda i: (-i['mtime'], i['id']))
    rec.sort(key=lambda i: (-i['mtime'], i['id']))
    return dict(active=act, recent=rec)


def _opt_text(i):
    return ('● live  ' if i['live'] else '') + i['id'] + ' — ' + i['line']


def selector_html(sm, current=None, taps=True):
    items = sm['active'] + sm['recent']
    opts = ''.join(f'<option value="{html.escape(i["id"])}"{" selected" if i["id"] == current else ""}>{html.escape(_opt_text(i))}</option>'
                   for i in items)
    out = f'<select id="sel" aria-label="run">{opts}</select>'
    if taps:
        dot = '● '
        out += '<div id="taps" class="taps">' + ''.join(
            f'<a class="tap{" cur" if i["id"] == current else ""}{" live" if i["live"] else ""}" href="/run/{html.escape(i["id"])}" '
            f'data-id="{html.escape(i["id"])}">{dot if i["live"] else ""}{html.escape(i["id"])}</a>' for i in items) + '</div>'
    return out


# shared by both pages: keyed list sync (no flicker, keeps an open dropdown open) and the 3 s poll of /api/runs
COMMON_JS = r"""
var $=function(i){return document.getElementById(i)};
function fmt(v,u){return v==null?'-':v+(u||'')}
function optText(i){return (i.live?'● live  ':'')+i.id+' — '+i.line}
function syncList(el,items,mk,up){
 var ids=items.map(function(i){return i.id}).join('|');
 if(el.getAttribute('data-ids')!==ids){el.textContent='';items.forEach(function(i){el.appendChild(mk(i))});el.setAttribute('data-ids',ids)}
 items.forEach(function(i,k){up(el.children[k],i)})}
function poll(render){
 function once(){fetch('/api/runs',{cache:'no-store'}).then(function(r){return r.json()}).then(render).catch(function(){})}
 once();setInterval(once,__POLL__)}
"""

RUN_JS = r"""<script>
(function(){
__COMMON__
var lastSnapM=null,S=[],follow=true,playing=false,pos=0,seen=0,mk=null,lastFr=null,pt=0,sl=$('scrub'),pb=$('play'),pts=[],W=680,H=160,P=24,cur=null,busy=0,rid=__RID__,es=null,over=false,sel=$('sel');
function svg(last){
 if(pts.length<2){$('trend').innerHTML='<svg viewBox="0 0 '+W+' '+H+'"><text x="10" y="30" fill="#888" font-size="18">no passes yet</text></svg>';return}
 var xs=pts.map(function(p){return p[0]}),ys=pts.map(function(p){return p[1]}),x0=Math.min.apply(0,xs),x1=Math.max.apply(0,xs)||1,y1=Math.max.apply(0,ys)||1;
 var sx=function(x){return P+(x-x0)/((x1-x0)||1)*(W-2*P)},sy=function(y){return H-P-y/y1*(H-2*P)};
 var q=pts.map(function(p){return[sx(p[0]),sy(p[1])]});
 if(last&&q.length>1){var a=q[q.length-2],b=q[q.length-1];q[q.length-1]=[a[0]+(b[0]-a[0])*last,a[1]+(b[1]-a[1])*last]}
 var e=q[q.length-1],v=ys[ys.length-1];
 $('trend').innerHTML='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><rect width="'+W+'" height="'+H+'" fill="#000"/>'+(mk!=null?'<line x1="'+Math.max(P,Math.min(W-P,sx(mk))).toFixed(1)+'" x2="'+Math.max(P,Math.min(W-P,sx(mk))).toFixed(1)+'" y1="0" y2="'+H+'" stroke="#fc6" stroke-width="2"/>':'')+'<polyline points='+q.map(function(c){return c[0].toFixed(1)+','+c[1].toFixed(1)}).join(' ')+'" fill="none" stroke="#9cf" stroke-width="3"/><circle cx="'+e[0].toFixed(1)+'" cy="'+e[1].toFixed(1)+'" r="5" fill="#f66"/><text x="'+P+'" y="18" fill="#888" font-size="14">open per pass (max '+y1+')</text><text x="'+Math.min(e[0],W-60).toFixed(1)+'" y="'+Math.max(e[1]-10,16)+'" fill="#f66" font-size="16">'+v+'</text></svg>'}
function grow(){var t0=performance.now(),id=++busy;(function f(t){if(id!==busy)return;var k=Math.min(1,(t-t0)/300);svg(k);if(k<1)requestAnimationFrame(f)})(t0)}
function frame(fr){
 if(fr)lastFr=fr;if(!follow||!fr||fr.mtime===cur)return;cur=fr.mtime;var a=$('a'),b=$('b');
 b.onload=function(){b.onload=null;if($('ph'))$('ph').style.display='none';a.style.display='block';b.style.opacity=1;
  setTimeout(function(){a.onload=function(){a.onload=null;b.style.transition='none';b.style.opacity=0;void b.offsetWidth;b.style.transition=''};a.src=b.src},320)};
 b.src=fr.url}
var L=[],lstart=0,lastOpen=null,lf='all',lq='',STG={preflight:'#b9d',route:'#5b9',import:'#69d',drc:'#d95',triage:'#d7b',gate:'#dd5',render:'#5dd',fab:'#f77',job:'#aaa'};
function mmss(s){if(s==null)return '--:--.-';var m=Math.floor(s/60),r=s-m*60;return (m<10?'0':'')+m+':'+(r<10?'0':'')+r.toFixed(1)}
function isBound(r){return /( start| end)$|^stage |^exit |^configure$/.test(r.action||'')}
function matches(r){
 if(lf==='decisions'&&!(r.why&&r.action!=='pass'&&!isBound(r)))return false;
 if(lf==='passes'&&r.action!=='pass')return false;
 if(lf==='stages'&&!isBound(r))return false;
 if(lq&&JSON.stringify([r.stage,r.action,r.why,r.result,r.inputs]).toLowerCase().indexOf(lq)<0)return false;return true}
function el(t,c,x){var n=document.createElement(t);if(c)n.className=c;if(x!=null)n.textContent=x;return n}
function rowEl(r){
 var row=el('div','rec'),t=el('span','t',mmss(r.elapsed_s)),b=el('span','badge',r.stage||'-');b.style.background=STG[r.stage]||'#999';
 row.appendChild(t);row.appendChild(b);var res=r.result||{};
 if(r.action==='pass'){
  row.className='rec pass';var o=res.open,dl=lastOpen==null||o==null?null:o-lastOpen;
  row.appendChild(el('span','','pass '+fmt(res.pass)+'  open '));
  var os=el('span',dl==null||dl===0?'':dl<0?'dn':'up',fmt(o)+(dl?' ('+(dl>0?'+':'')+dl+')':''));row.appendChild(os);
  row.appendChild(el('span','','  rip-ups '+fmt(res.ripups)+'  viol '+fmt(res.violations)));
  if(o!=null)lastOpen=o;return row}
 row.appendChild(el('span','',r.action||''));
 if(r.why)row.appendChild(el('div','why',r.why));
 var det={};['inputs','evidence','result'].forEach(function(k){if(r[k]!=null)det[k]=r[k]});
 if(Object.keys(det).length){var dd=el('details'),sm=el('summary','','details');dd.appendChild(sm);dd.appendChild(el('pre','',JSON.stringify(det,null,2)));row.appendChild(dd)}
 return row}
function atBottom(bx){return bx.scrollTop+bx.clientHeight>=bx.scrollHeight-8}
function renderAll(keep){
 var bx=$('logbox'),h=bx.scrollHeight,tp=bx.scrollTop,f=document.createDocumentFragment();lastOpen=null;
 L.forEach(function(r){var n=rowEl(r);if(matches(r))f.appendChild(n)});
 bx.textContent='';bx.appendChild(f);bx.scrollTop=keep?tp+(bx.scrollHeight-h):bx.scrollHeight;
 $('older').style.display=lstart>0?'inline-block':'none'}
function logIn(d){
 if(d.log_reset){L=d.log_tail.slice();lstart=d.log_start||0;renderAll(false);return}
 if(!d.log_tail.length)return;
 var bx=$('logbox'),st=atBottom(bx);
 d.log_tail.forEach(function(r){L.push(r);var n=rowEl(r);if(matches(r))bx.appendChild(n)});
 if(st)bx.scrollTop=bx.scrollHeight}
function older(){var r=rid;fetch('/run/'+encodeURI(r)+'/log.json?before='+lstart,{cache:'no-store'}).then(function(x){return x.json()}).then(function(j){
 if(r!==rid)return;L=j.records.concat(L);lstart=j.start;renderAll(true)}).catch(function(){})}
$('older').addEventListener('click',older);
$('lq').addEventListener('input',function(){lq=this.value.toLowerCase();renderAll(false)});
Array.prototype.forEach.call(document.querySelectorAll('.lf button'),function(b){b.addEventListener('click',function(){
 lf=b.getAttribute('data-f');Array.prototype.forEach.call(document.querySelectorAll('.lf button'),function(x){x.className=x===b?'on':''});renderAll(false)})});
function banner(live,text){$('banner').className='banner '+(live?'live':'fin');$('btxt').textContent=text;$('dot').className=live?'live':''}
function apply(d){
 banner(d.live,d.banner);
 $('line').textContent=d.line;
 var m={state:d.status,stage:d.stage,elapsed:fmt(d.elapsed_s,' s'),open:fmt(d.open),best:fmt(d.best_open),vias:fmt(d.vias),ETA:fmt(d.eta_s,' s'),passes:d.npasses};
 for(var k in m)$('v-'+k).textContent=m[k];
 if(d.full)pts=[];
 if(d.passes.length){pts=pts.concat(d.passes);if(d.full)svg(0);else grow()}
 else if(d.full)svg(0);
 logIn(d);
 frame(d.frame);
 if(d.full||(d.frame&&d.frame.mtime!==lastSnapM)){lastSnapM=d.frame?d.frame.mtime:null;loadSnaps()}
 if(d.finished){over=true;if(es)es.close();$('dott').textContent='finished (stream closed)'}}
function reset(){
 busy++;pts=[];cur=null;over=false;S=[];follow=true;playing=false;seen=0;mk=null;lastFr=null;lastSnapM=null;sl.max=0;sl.value=0;setUI();svg(0);
 var a=$('a'),b=$('b');a.onload=b.onload=null;a.removeAttribute('src');b.removeAttribute('src');a.style.display='none';b.style.opacity=0;
 if($('ph'))$('ph').style.display='block';
 L=[];lstart=0;lastOpen=null;$('logbox').textContent='';$('older').style.display='none';$('line').textContent='connecting';
 ['state','stage','elapsed','open','best','vias','ETA','passes'].forEach(function(k){$('v-'+k).textContent='-'});
 banner(false,'...')}
function setUI(){pb.textContent=playing?'Pause':'Play';pb.className=playing?'on':'';$('golive').className=follow?'on':'';
 if(follow)$('hint').style.display='none'}
function stampOf(e){return 'replay '+e.elapsed_s+' s · stage '+e.stage+' · pass '+fmt(e['pass'])+' · open '+fmt(e.open)+' · frame '+(e.i+1)+'/'+S.length}
function snapAt(t){var k=0;for(var j=0;j<S.length;j++){if(S[j].elapsed_s*10<=t)k=j;else break}return k}
function showSnap(k,img){
 var e=S[k];if(!e)return;$('stamp').textContent=stampOf(e);if(e['pass']!=null)mk=e['pass'];busy++;svg(0);
 if(img){var a=$('a'),b=$('b');b.style.opacity=0;if($('ph'))$('ph').style.display='none';a.style.display='block';cur=null;if(a.getAttribute('src')!==e.url)a.src=e.url}}
function preload(k){for(var j=k+1;j<=k+4&&j<S.length;j++){(new Image()).src=S[j].url}}
function setMax(){sl.max=S.length?Math.round(S[S.length-1].elapsed_s*10):0}
function loadSnaps(){var r=rid;fetch('/run/'+encodeURI(r)+'/snapshots.json',{cache:'no-store'}).then(function(x){return x.json()}).then(function(l){
 if(r!==rid)return;S=l;setMax();
 if(follow){if(S.length){sl.value=sl.max;showSnap(S.length-1,false)}}
 else if(S.length>seen)$('hint').style.display='inline';
 if(follow)seen=S.length}).catch(function(){})}
function unfollow(){if(follow){follow=false;seen=S.length;setUI()}}
function stop(){playing=false;setUI()}
function tick(ts){
 if(!playing)return;var dt=(ts-pt)/1000;pt=ts;var sp=$('speed').value,tot=S.length?S[S.length-1].elapsed_s:0;
 var rate=sp==='60s'?(tot>0?tot/60:1):parseFloat(sp);pos+=dt*rate*10;
 if(pos>=+sl.max){pos=+sl.max;sl.value=pos;var k=snapAt(pos);showSnap(k,true);stop();return}
 sl.value=pos;var k2=snapAt(pos);if(k2!==tick.k){tick.k=k2;showSnap(k2,true);preload(k2)}
 requestAnimationFrame(tick)}
sl.addEventListener('input',function(){unfollow();pos=+sl.value;var k=snapAt(pos);showSnap(k,true);preload(k)});
pb.addEventListener('click',function(){
 if(playing){stop();return}if(!S.length)return;unfollow();if(pos>=+sl.max)pos=0;playing=true;setUI();pt=performance.now();tick.k=-1;requestAnimationFrame(tick)});
$('golive').addEventListener('click',function(){stop();follow=true;seen=S.length;cur=null;setUI();if(S.length){sl.value=sl.max;showSnap(S.length-1,false)}if(lastFr)frame(lastFr)});
function connect(r){
 if(es)es.close();rid=r;reset();
 es=new EventSource('/run/'+encodeURI(r)+'/events');var e=es;
 e.onopen=function(){if(!over)$('dott').textContent='connected'};
 e.onmessage=function(m){if(e===es)apply(JSON.parse(m.data))};
 e.onerror=function(){if(e===es&&!over)$('dott').textContent='reconnecting'}}
function mark(){
 Array.prototype.forEach.call(document.querySelectorAll('.tap,.chip'),function(n){n.classList.toggle('cur',n.getAttribute('data-id')===rid)})}
function show(r){$('rid').textContent=r;document.title=r;if(sel)sel.value=r;connect(r);mark()}
function go(r,push){if(r===rid)return;if(push)history.pushState({r:r},'','/run/'+r);show(r)}
function link(cls,i){var n=document.createElement('a');n.className=cls;n.href='/run/'+i.id;n.setAttribute('data-id',i.id);
 n.addEventListener('click',function(ev){ev.preventDefault();go(i.id,true)});return n}
function render(d){
 var all=d.active.concat(d.recent);
 if(sel){
  syncList(sel,all,function(i){var o=document.createElement('option');o.value=i.id;return o},function(o,i){o.textContent=optText(i)});
  sel.value=rid}
 syncList($('taps'),all,function(i){return link('tap',i)},function(n,i){n.className='tap'+(i.live?' live':'')+(i.id===rid?' cur':'');n.textContent=(i.live?'● ':'')+i.id});
 syncList($('strip'),d.active,function(i){return link('chip',i)},function(n,i){
  n.className='chip'+(i.id===rid?' cur':'');n.textContent=i.id+' | open '+fmt(i.open)+' | best '+fmt(i.best_open)+' | '+i.stage+' | '+fmt(i.elapsed_s,' s')});
 if(!d.active.length)$('strip').textContent='no active runs'}
if(sel)sel.addEventListener('change',function(){go(sel.value,true)});
Array.prototype.forEach.call(document.querySelectorAll('#taps .tap,#strip .chip'),function(n){n.addEventListener('click',function(ev){ev.preventDefault();go(n.getAttribute('data-id'),true)})});
window.addEventListener('popstate',function(){var m=location.pathname.match(/^\/run\/(.+)$/);if(m){var r=decodeURIComponent(m[1]);if(r!==rid)show(r)}});
connect(rid);poll(render);
})();
</script>"""

INDEX_JS = r"""<script>
(function(){
__COMMON__
var sel=$('sel');
if(sel)sel.addEventListener('change',function(){location.href='/run/'+sel.value});
function render(d){
 var all=d.active.concat(d.recent);
 syncList(sel,all,function(i){var o=document.createElement('option');o.value=i.id;return o},function(o,i){o.textContent=optText(i)});
 if(!all.length){$('rows').innerHTML='<tr><td>no runs</td></tr>';$('rows').removeAttribute('data-ids');return}
 syncList($('rows'),all,function(i){
  var tr=document.createElement('tr'),k=document.createElement('td'),a=document.createElement('a'),br=document.createElement('br'),s=document.createElement('span'),v=document.createElement('td');
  k.className='k';a.href='/run/'+i.id;a.textContent=i.id;s.className='dim';k.appendChild(a);k.appendChild(br);k.appendChild(s);tr.appendChild(k);tr.appendChild(v);return tr},
  function(tr,i){tr.children[0].children[2].textContent=i.live?'● LIVE':i.banner;tr.children[1].textContent=i.line})}
poll(render);
})();
</script>"""

NOSSE = ("<script>if(!window.EventSource){var m=document.createElement('meta');m.httpEquiv='refresh';m.content='%d';"
         "document.head.appendChild(m)}</script>" % REFRESH_S)


def _js(tpl, **kw):
    out = tpl.replace('__COMMON__', COMMON_JS).replace('__POLL__', str(POLL_API_MS))
    for k, v in kw.items():
        out = out.replace(f'__{k.upper()}__', str(v))
    return out


def index_html(runs):
    sm = summary(runs)
    items = ''.join(f'<tr><td class="k"><a href="/run/{html.escape(i["id"])}">{html.escape(i["id"])}</a><br>'
                    f'<span class="dim">{"&#9679; LIVE" if i["live"] else html.escape(i["banner"])}</span></td>'
                    f'<td>{html.escape(i["line"])}</td></tr>' for i in sm['active'] + sm['recent']) or '<tr><td>no runs</td></tr>'
    body = (f'<h1>Routing runs</h1>{selector_html(sm, taps=False)}<table><tbody id="rows">{items}</tbody></table>'
            f'<p class="dim">updates in place every {POLL_API_MS // 1000} s</p>')
    return page('routing runs', body, _js(INDEX_JS))


def run_html(rid, d, runs=None):
    s = status(d)
    live = s['state'] == 'ACTIVE'
    kv = (('state', s['state']), ('stage', s['stage']), ('elapsed', f"{s['elapsed_s']} s" if s['elapsed_s'] is not None else '-'),
          ('open', s['open']), ('best', s['best']), ('vias', s['vias']), ('ETA', f"{s['eta_s']} s" if s['eta_s'] is not None else '-'),
          ('passes', len(s['passes'])))
    table = ''.join(f'<tr><td class="k">{k}</td><td id="v-{k}">{html.escape(str("-" if v is None else v))}</td></tr>' for k, v in kv)
    f = latest_frame(d)
    src = f'/run/{html.escape(rid)}/frame.png?t={int(os.path.getmtime(f) * 1000)}' if f else ''
    frame = (f'<div id="board"><div id="ph"{" style=display:none" if f else ""}>{PLACEHOLDER}</div>'
             f'<img id="a" src="{src}" alt="board"{"" if f else " style=display:none"}><img id="b" alt=""></div>')
    tail = html.escape('\n'.join(log_tail(d)) or 'no actions yet')
    sm = summary(runs or Runs([d], roots=()))
    nz = lambda v: '-' if v is None else v
    strip = ''.join(f'<a class="chip{" cur" if i["id"] == rid else ""}" href="/run/{html.escape(i["id"])}" data-id="{html.escape(i["id"])}">'
                    f'{html.escape(i["id"])} | open {nz(i["open"])} | best {nz(i["best_open"])} | {html.escape(str(i["stage"]))}'
                    f' | {nz(i["elapsed_s"]) if i["elapsed_s"] is None else str(i["elapsed_s"]) + " s"}</a>'
                    for i in sm['active']) or 'no active runs'
    body = (f'<div id="banner" class="banner {"live" if live else "fin"}"><span id="dot"{" class=live" if live else ""}></span>'
            f'<span id="btxt">{html.escape(banner_text(s))}</span></div>'
            f'<h1><a href="/">runs</a> / <span id="rid">{html.escape(rid)}</span></h1>{selector_html(sm, rid)}'
            f'<h2>Active runs</h2><div id="strip" class="strip">{strip}</div>'
            f'<div class="status"><span id="line">{html.escape(s["line"])}</span></div>'
            f'<div class="dim"><span id="dott">connecting</span></div>'
            f'<h2>Board</h2>{frame}'
            f'<div class="player"><div id="stamp" class="dim">replay: no snapshots yet</div>'
            f'<input type="range" id="scrub" min="0" max="0" value="0" step="1" aria-label="replay position">'
            f'<button id="play" type="button">Play</button>'
            f'<select id="speed" aria-label="speed"><option value="1">1x</option><option value="4">4x</option><option value="16">16x</option>'
            f'<option value="60s">60 s</option></select><button id="golive" type="button" class="on">LIVE</button>'
            f'<span id="hint">new frames</span></div>'
            f'<h2>Status</h2><table>{table}</table><h2>Pass trend</h2><div id="trend">{trend_svg(s["passes"])}</div>'
            f'<h2>Action log</h2><div class="lf"><button type="button" data-f="all" class="on">all</button><button type="button" data-f="decisions">decisions</button>'
            f'<button type="button" data-f="passes">router passes</button><button type="button" data-f="stages">stage boundaries</button>'
            f'<input id="lq" type="search" placeholder="filter text" aria-label="filter text"></div>'
            f'<button type="button" id="older" style="display:none">load earlier</button><div id="logbox"></div><noscript><pre>{tail}</pre></noscript><p class="dim">{html.escape(d)} · live (server-sent events)</p>')
    script = _js(RUN_JS, tail=TAIL, rid=json.dumps(rid).replace('<', '\\u003c'))
    return page(rid, body, NOSSE + script)


class Handler(BaseHTTPRequestHandler):
    runs = Runs()
    server_version = 'route_live/1'

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body, ctype='text/html; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def _events(self, rid, d):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()
        self.close_connection = True
        if self.command == 'HEAD':
            return
        st = Stream(rid, d)
        last_write = time.time()
        try:
            while True:
                ev = st.event()
                if ev is not None:
                    self.wfile.write(b'data: ' + json.dumps(ev, default=str).encode() + b'\n\n')
                    self.wfile.flush()
                    last_write = time.time()
                    if ev.get('finished'):
                        return        # the finished state is sent once; then the stream closes
                elif time.time() - last_write >= HEARTBEAT_S:
                    self.wfile.write(b': heartbeat\n\n')
                    self.wfile.flush()
                    last_write = time.time()
                time.sleep(POLL_S)
        except (BrokenPipeError, ConnectionError, OSError, ValueError):
            pass

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        m = re.match(r'^/run/(.+?)/(snapshots\.json|log\.json|snapshots/(\d{4})\.png)$', path)
        if m:
            rid = m.group(1)
            d = self.runs.resolve(rid) if '..' not in rid else None
            if not d:
                return self._send(404, b'no such run', 'text/plain')
            if m.group(2) == 'snapshots.json':
                return self._send(200, json.dumps(snapshot_list(rid, d)).encode(), 'application/json')
            if m.group(2) == 'log.json':
                recs = log_recs(d)
                try:
                    before = int(re.search(r'[?&]before=(\d+)', self.path).group(1))
                except (AttributeError, ValueError):
                    before = len(recs)
                before = max(0, min(before, len(recs)))
                start = max(0, before - LOG_N)
                return self._send(200, json.dumps(dict(start=start, total=len(recs), records=recs[start:before]), default=str).encode(),
                                  'application/json')
            f = os.path.join(d, 'snapshots', m.group(3) + '.png')
            if not os.path.isfile(f):
                return self._send(404, b'no such frame', 'text/plain')
            return self._send(200, open(f, 'rb').read(), 'image/png')
        if path == '/api/runs':
            return self._send(200, json.dumps(summary(self.runs)).encode(), 'application/json')
        if path == '/':
            return self._send(200, index_html(self.runs).encode())
        if path.startswith('/run/'):
            rest = path[5:]
            want_frame = rest.endswith('/frame.png')
            want_events = rest.endswith('/events')
            rid = rest[:-len('/frame.png')] if want_frame else rest[:-len('/events')] if want_events else rest
            d = self.runs.resolve(rid) if rid and '..' not in rid else None
            if not d:
                return self._send(404, b'no such run', 'text/plain')
            if want_events:
                return self._events(rid, d)
            if want_frame:
                f = latest_frame(d)
                if not f:
                    return self._send(404, b'no frame yet', 'text/plain')
                return self._send(200, open(f, 'rb').read(), 'image/png')
            return self._send(200, run_html(rid, d, self.runs).encode())
        return self._send(404, b'not found', 'text/plain')

    def do_POST(self):
        self._send(405, b'read-only', 'text/plain')

    do_PUT = do_DELETE = do_PATCH = do_POST


def serve(bind=TS_ADDR, port=PORT, extra=()):
    if not allowed_bind(bind):
        raise SystemExit(f'route_live: refusing to bind {bind}: only the Tailscale address ({TS_ADDR}) or 127.0.0.1')
    Handler.runs = Runs(extra)
    srv = ThreadingHTTPServer((bind, port), Handler)
    host = TS_HOST if bind == TS_ADDR else bind
    print(f'route_live: http://{host}:{srv.server_address[1]}/  (bound to {bind} only; GET only; Ctrl-C stops)', flush=True)
    return srv


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('outdirs', nargs='*', help='extra run directories to show')
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--bind', default=TS_ADDR)
    ap.add_argument('--port', type=int, default=PORT)
    a = ap.parse_args(argv)
    if not a.serve:
        ap.print_help()
        return 2
    srv = serve(a.bind, a.port, a.outdirs)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
