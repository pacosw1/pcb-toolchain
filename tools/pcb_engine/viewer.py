"""Local engine observation client. Mutations use the same CLI admission API."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import secrets
import threading
from urllib.parse import parse_qs, urlparse


def child(form, key, default=()):
    return next((x[1:] for x in form if isinstance(x, list) and x and x[0] == key), default)


def geometry(path):
    """Display geometry only; this projection does not perform clearance checks."""
    from placer.dru import _tree, _tokens
    board = _tree(_tokens(Path(path).read_text()))[0]
    segments, pads, vias, edges = [], [], [], []
    for form in board[1:]:
        if not isinstance(form, list) or not form:
            continue
        kind = form[0]
        if kind == 'segment':
            segments.append(dict(a=list(map(float, child(form, 'start'))),
                b=list(map(float, child(form, 'end'))),
                width=float(child(form, 'width')[0]), layer=child(form, 'layer')[0]))
        elif kind == 'via':
            vias.append(dict(at=list(map(float, child(form, 'at')[:2])),
                             size=float(child(form, 'size')[0])))
        elif kind == 'gr_line' and child(form, 'layer') == ['Edge.Cuts']:
            edges.append(dict(a=list(map(float, child(form, 'start'))), b=list(map(float, child(form, 'end')))))
        elif kind == 'footprint':
            at = list(map(float, child(form, 'at', (0, 0))))
            angle = math.radians(at[2] if len(at) > 2 else 0)
            ref = next((x[2] for x in form if isinstance(x, list) and x[:2] == ['property', 'Reference']), '')
            for p in form:
                if not isinstance(p, list) or p[:1] != ['pad']:
                    continue
                pos = list(map(float, child(p, 'at', (0, 0))))
                # KiCad PCB coordinate system has downward-positive Y.
                px = at[0] + math.cos(angle) * pos[0] + math.sin(angle) * pos[1]
                py = at[1] - math.sin(angle) * pos[0] + math.cos(angle) * pos[1]
                size = list(map(float, child(p, 'size', (0.5, 0.5))))
                pads.append(dict(at=[px, py], size=size, ref=ref, number=p[1], type=p[2],
                                 shape=p[3], angle=pos[2] if len(pos) > 2 else (at[2] if len(at) > 2 else 0),
                                 layers=child(p, 'layers')))
    points = [p['at'] for p in pads] + [p['a'] for p in edges] + [p['b'] for p in edges]
    points += [p['a'] for p in segments] + [p['b'] for p in segments]
    bounds = ([min(p[0] for p in points)-2, min(p[1] for p in points)-2,
               max(p[0] for p in points)+2, max(p[1] for p in points)+2] if points else [0, 0, 100, 100])
    return dict(segments=segments, pads=pads, vias=vias, edges=edges, bounds=bounds,
                layers=sorted({s['layer'] for s in segments}),
                note='Routing preview; zones and curved outlines are omitted. Native checks remain authoritative.')


class Observation:
    def __init__(self, folder):
        self.folder = Path(folder).resolve()
        self.cache = None
        self.lock = threading.Lock()

    def snapshot(self, candidate_id=None):
        import pcb_cli
        from pcb_workflow import board_config
        folder = self.folder
        manifest = pcb_cli.read_json(folder / 'run.json')
        state_file = folder / 'operation/engine/state.json'
        state = pcb_cli.read_json(state_file) if state_file.is_file() else {}
        selected = next((row for row in state.get('attempts', [])
                         if row.get('candidate_id') == candidate_id), None)
        if candidate_id and selected is None:
            raise ValueError('unknown candidate ID')
        events_file = folder / 'operation/engine/events.jsonl'
        events = []
        if events_file.is_file():
            # Bounded tail, including during a partially written journal line.
            with events_file.open('rb') as f:
                f.seek(max(0, events_file.stat().st_size - 131072))
                for line in f.read().decode(errors='replace').splitlines():
                    try:
                        events.append(json.loads(line))
                    except ValueError:
                        pass
        candidate = folder / 'workspace'
        board = None
        if candidate.is_dir():
            try:
                board = board_config(candidate, manifest['board'])[2].with_suffix('.kicad_pcb')
            except (ValueError, OSError):
                pass
        if selected:
            selected_path = Path(selected['path']).resolve()
            if not selected_path.is_relative_to(folder / 'operation/engine'):
                raise ValueError('candidate preview escaped engine evidence')
            board = selected_path
        rendered = None
        if board and board.is_file() and board.resolve().is_relative_to(folder):
            stat = board.stat()
            key = (str(board), stat.st_mtime_ns, stat.st_size)
            with self.lock:
                if self.cache is None or self.cache[0] != key:
                    try:
                        self.cache = (key, geometry(board))
                    except (ValueError, IndexError, TypeError, OSError):
                        pass  # Preserve the last complete preview during writes.
                if self.cache:
                    rendered = self.cache[1]
        overlays = []
        preview_candidate = selected or state.get('best_candidate')
        if preview_candidate:
            for name in preview_candidate.get('evidence', {}):
                report = Path(name).resolve()
                if report.name != 'drc.json' or not report.is_relative_to(folder):
                    continue
                try:
                    findings = pcb_cli.read_json(report)
                    for row in findings.get('unconnected_items', []) + [
                            v for v in findings.get('violations', []) if v.get('severity') == 'error']:
                        points = [item['pos'] for item in row.get('items', []) if isinstance(item.get('pos'), dict)]
                        if points:
                            overlays.append(dict(type=row.get('type'), description=row.get('description'),
                                                 points=[[p['x'], p['y']] for p in points]))
                except (ValueError, OSError, KeyError):
                    pass
        return dict(run=pcb_cli.status(folder), engine=state, events=events[-100:],
                    geometry=rendered, overlays=overlays, selected_candidate=preview_candidate)


PAGE = r"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PCB engine</title><style>
:root{color-scheme:dark;font:15px system-ui;background:#101619;color:#e4eeee}
body{margin:0}header{padding:18px 24px;border-bottom:1px solid #344247;display:flex;gap:16px;align-items:center}
h1{font-size:20px;margin:0}button,select{font:inherit;background:#233137;color:inherit;border:1px solid #557078;border-radius:5px;padding:7px}
button:focus-visible,select:focus-visible{outline:3px solid #a8dce5}main{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:16px;padding:18px}
#board{background:#192327;width:100%;height:65vh;border:1px solid #344247}section{min-width:0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,monospace;background:#192327;padding:12px;max-height:35vh;overflow:auto}
.metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.metric{background:#1c2b30;padding:12px;border-radius:6px}.metric strong{font-size:25px;display:block}.activity{border-bottom:1px solid #344247;padding:9px 0;font-size:13px;overflow-wrap:anywhere}
.muted{color:#aebec4;font-size:13px}#error{color:#ffbcb0}#status{margin-left:auto}
@media(max-width:800px){main{grid-template-columns:1fr}header{flex-wrap:wrap}#board{height:48vh}}
</style><header><h1>PCB engine</h1><span id="name"></span><strong id="status">Connecting</strong>
<button id="cancel">Cancel run</button><button id="continue">Continue candidate</button></header>
<main><section><label>Candidate <select id="candidate"><option value="">Current</option></select></label>
<label>Layer <select id="layer"><option value="">All copper</option></select></label>
<button id="fit">Fit</button><p id="note" class="muted"></p>
<svg id="board" role="img" aria-label="Current PCB candidate; detailed findings appear alongside"></svg>
<p class="muted">Scroll to zoom. Drag to pan. Preview geometry is not a validation result.</p><div id="error" role="alert"></div>
</section><section><h2 id="phase">Search state</h2><div id="metrics" class="metrics"></div><p id="verdict"></p>
<h2>Recent activity</h2><div id="events"></div><details><summary>Evidence details</summary><pre id="state"></pre></details></section></main>
<script>
const token=location.hash.slice(1), $=id=>document.getElementById(id);let data,box,drag;
const ns='http://www.w3.org/2000/svg';function el(tag,attrs){let x=document.createElementNS(ns,tag);for(let k in attrs)x.setAttribute(k,attrs[k]);return x}
function fit(){if(!data?.geometry)return;let b=data.geometry.bounds;box=[b[0],b[1],b[2]-b[0],b[3]-b[1]];draw()}
function draw(){if(!data?.geometry)return;let g=data.geometry,s=$('board');s.replaceChildren();s.setAttribute('viewBox',box.join(' '));
for(let e of g.edges)s.append(el('line',{x1:e.a[0],y1:e.a[1],x2:e.b[0],y2:e.b[1],stroke:'#ddd','stroke-width':.15}));
for(let e of g.segments){if($('layer').value&&e.layer!==$('layer').value)continue;s.append(el('line',{x1:e.a[0],y1:e.a[1],x2:e.b[0],y2:e.b[1],stroke:e.layer==='F.Cu'?'#eb8074':e.layer==='B.Cu'?'#71a9eb':'#ab93df','stroke-width':e.width,'stroke-linecap':'round'}))}
for(let p of g.pads){let q=el('rect',{x:p.at[0]-p.size[0]/2,y:p.at[1]-p.size[1]/2,width:p.size[0],height:p.size[1],rx:p.shape==='circle'?Math.min(...p.size)/2:0,fill:p.type==='np_thru_hole'?'#101619':'#d9c681',stroke:p.type==='np_thru_hole'?'#aebec4':'none','stroke-width':.12,transform:`rotate(${-p.angle} ${p.at.join(' ')})`});let t=el('title',{});t.textContent=p.ref+'.'+p.number;q.append(t);s.append(q)}
for(let v of g.vias)s.append(el('circle',{cx:v.at[0],cy:v.at[1],r:v.size/2,fill:'#182326',stroke:'#b3c6bd','stroke-width':.12}));
for(let f of data.overlays||[]){for(let p of f.points){let c=el('circle',{cx:p[0],cy:p[1],r:.45,fill:'none',stroke:'#ffb85d','stroke-width':.13});let t=el('title',{});t.textContent=f.description||f.type;c.append(t);s.append(c)}if(f.points.length===2)s.append(el('line',{x1:f.points[0][0],y1:f.points[0][1],x2:f.points[1][0],y2:f.points[1][1],stroke:'#ffb85d','stroke-width':.12,'stroke-dasharray':'.4 .3'}))}}
let polling=false;async function poll(){if(polling)return;polling=true;try{let r=await fetch('/state?candidate='+encodeURIComponent($('candidate').value),{headers:{'X-PCB-Token':token}});if(!r.ok)throw Error(await r.text());data=await r.json();
$('name').textContent=data.run.board||data.run.run_id;$('status').textContent='Run '+data.run.status;
$('phase').textContent='Search: '+(data.engine.phase||data.run.status);$('state').textContent=JSON.stringify(data.engine,null,2);
let c=data.selected_candidate,m=c?.metrics||{};$('metrics').replaceChildren();for(let [label,key] of [['Open connections','drc_unconnected'],['DRC errors','drc_errors'],['Vias','via_count'],['Track length (mm)','track_length_mm']]){let card=document.createElement('div');card.className='metric';let number=document.createElement('strong');number.textContent=m[key]==null?'Unknown':Number.isInteger(m[key])?m[key]:m[key].toFixed(1);card.append(number,document.createTextNode(label));$('metrics').append(card)}
$('verdict').textContent=c?.gate_passed?'Configured checks passed; adoption is separate.':'Candidate has not passed all configured checks.';
let history=$('candidate'),chosen=history.value;history.replaceChildren(new Option('Current',''));for(let a of data.engine.attempts||[])history.add(new Option((a.strategy?.kind||'candidate')+' / '+a.candidate_id,a.candidate_id));history.value=chosen;
$('events').replaceChildren();for(let e of data.events.filter(e=>e.type!=='engine.transaction').slice(-10).reverse()){let line=document.createElement('div');line.className='activity';line.textContent=new Date(e.time*1000).toLocaleTimeString()+'  '+(e.cause||e.reason||e.phase||(e.candidate_id?'Checked '+e.candidate_id:e.operation?e.operation+' on '+(e.actual_backend||e.backend||'recorded device'):e.type.replace('engine.','')));$('events').append(line)}
let done=['passed','failed','error','cancelled','timeout'].includes(data.run.status);$('cancel').disabled=done;$('continue').disabled=!['passed','failed'].includes(data.run.status);
if(data.geometry){let select=$('layer'),old=select.value;select.replaceChildren(new Option('All copper',''));for(let l of data.geometry.layers)select.add(new Option(l,l));select.value=old;$('note').textContent=data.geometry.note;if(!box)fit();else draw()}
$('error').textContent='';}catch(e){$('error').textContent=e.message}finally{polling=false}}
async function action(name){try{let r=await fetch('/'+name,{method:'POST',headers:{'X-PCB-Token':token,'Content-Type':'application/json'},body:'{}'});let result=await r.json();if(!r.ok)throw Error(result.error);if(name==='continue')$('error').textContent='Continuation submitted: '+result.run_id;}catch(e){$('error').textContent=e.message}}
$('cancel').onclick=()=>action('cancel');$('continue').onclick=()=>action('continue');$('fit').onclick=fit;$('layer').onchange=draw;$('candidate').onchange=poll;
$('board').addEventListener('wheel',e=>{if(!box)return;e.preventDefault();let f=e.deltaY>0?1.15:1/1.15;box=[box[0]+box[2]*(1-f)/2,box[1]+box[3]*(1-f)/2,box[2]*f,box[3]*f];draw()},{passive:false});
$('board').onpointerdown=e=>{if(!box)return;drag=[e.clientX,e.clientY,...box];e.currentTarget.setPointerCapture(e.pointerId)};
$('board').onpointermove=e=>{if(!drag)return;let r=e.currentTarget.getBoundingClientRect();box=[drag[2]-(e.clientX-drag[0])*drag[4]/r.width,drag[3]-(e.clientY-drag[1])*drag[5]/r.height,drag[4],drag[5]];draw()};
$('board').onpointerup=()=>drag=null;poll();setInterval(poll,1200);
</script></html>"""


def make_server(folder, port=0):
    if type(port) is not int or not 0 <= port <= 65535:
        raise ValueError('invalid localhost port')
    observation = Observation(folder)
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, value, html=False):
            body = (value if html else json.dumps(value)).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'text/html; charset=utf-8' if html else 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self):
            expected = f'127.0.0.1:{self.server.server_port}'
            return (self.headers.get('Host') == expected
                    and self.headers.get('Origin', 'http://' + expected) == 'http://' + expected
                    and secrets.compare_digest(self.headers.get('X-PCB-Token', ''), token))

        def do_GET(self):
            if self.path == '/':
                self.send(200, PAGE, html=True)
            elif urlparse(self.path).path == '/state' and self.authorized():
                try:
                    selected = parse_qs(urlparse(self.path).query).get('candidate', [None])[0]
                    self.send(200, observation.snapshot(selected))
                except (OSError, ValueError, KeyError) as e:
                    self.send(409, {'error': str(e)})
            else:
                self.send(403, {'error': 'Unknown route or invalid local session token'})

        def do_POST(self):
            import pcb_cli
            if not self.authorized():
                return self.send(403, {'error': 'Invalid local session token or origin'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 <= size <= 4096 or json.loads(self.rfile.read(size) or '{}') != {}:
                    raise ValueError('Control requests do not accept overrides')
                if self.path == '/cancel':
                    result = pcb_cli.request_cancel(observation.folder)
                elif self.path == '/continue':
                    result = pcb_cli.continue_engine(observation.folder)
                else:
                    return self.send(404, {'error': 'Unknown control'})
                self.send(200, result)
            except (ValueError, OSError, KeyError, TypeError) as e:
                self.send(409, {'error': str(e)})

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server, f'http://127.0.0.1:{server.server_port}/#{token}'


def serve(folder, port=0):
    server, url = make_server(folder, port)
    print(url, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
