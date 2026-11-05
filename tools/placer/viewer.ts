// Self-contained playback of recorded compaction poses. No CAD tool is run and no result is qualified.
// node --experimental-strip-types --no-warnings tools/placer/viewer.ts RUN.json OUT.html [--frames-json FILE] [--seconds N]
// This viewer does not render RUDY heat, PNG frames, GIF, MP4 or routed-board images.
import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFlags, runMain, UsageError } from '../lib/cli.ts';
import { round } from '../lib/py-numbers.ts';

type XY = [number, number];
type Rect = [number, number, number, number];
type Pose = [number, number, number][];
type Obj = Record<string, unknown>;
interface Unit { name: string; refs: string[]; block: string; fixed: boolean; halo: number; rects: number[][] }
interface ViewUnit extends Omit<Unit, 'rects'> { nets: string[] }
interface Net { name: string; pins: number[][] }
interface Frame { step: number; label: string; s: number; cost: number; components: Record<string, number>; unrouted: number | null; outline: XY[]; rects: Rect[][]; segments: [number, number, number, number][] }
export interface Playback { schema: 'iot-lab.placer-playback.v1'; source_sha256: string; source_scope: string; units: ViewUnit[]; frames: Frame[]; steps: { s: number; k: number; unrouted: number | null; passed: boolean }[]; region: Rect | null; verdict: string; unavailable: string[] }

const record = (value: unknown, where: string): Obj => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
  return value as Obj;
};
const array = (value: unknown, where: string): unknown[] => { if (!Array.isArray(value)) throw new Error(`${where} must be an array`); return value; };
const finite = (value: unknown, where: string): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${where} must be finite`); return value; };
const text = (value: unknown, where: string): string => { if (typeof value !== 'string') throw new Error(`${where} must be a string`); return value; };
const rounded = (n: number): number => { if (!Number.isFinite(n)) throw new Error('computed placement geometry is not finite'); return round(n, 1); };
const numeric = (value: unknown, size: number, where: string): number[] => {
  const row = array(value, where); if (row.length < size) throw new Error(`${where} needs ${size} numbers`);
  return row.map((part, i) => finite(part, `${where}[${i}]`));
};

/** Python viewer's exact quarter-turn rectangle transform, in millimetres. */
function rotatedRect(rect: readonly number[], turns: number): Rect {
  const [x0, y0, x1, y1] = rect as Rect;
  switch ((turns % 4 + 4) % 4) {
    case 0: return [x0, y0, x1, y1];
    case 1: return [y0, -x1, y1, -x0];
    case 2: return [-x1, -y1, -x0, -y0];
    default: return [-y1, x0, -y0, x1];
  }
}

function pose(value: unknown, count: number, where: string): Pose {
  const rows = array(value, where); if (rows.length !== count) throw new Error(`${where} does not match the unit count`);
  return rows.map((row, i) => {
    const values = numeric(row, 3, `${where}[${i}]`);
    if (values.length !== 3 || !Number.isInteger(values[2])) throw new Error(`${where}[${i}] must be x, y and quarter turns`);
    return values as [number, number, number];
  });
}

function frameGeometry(units: Unit[], nets: Net[], pose: Pose, outline: XY[], scale: number) {
  const xs = outline.map(p => p[0]), ys = outline.map(p => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const scaled: XY[] = outline.map(([x, y]) => [rounded(cx + (x - cx) * scale), rounded(cy + (y - cy) * scale)]);
  const rects = units.map((unit, i) => unit.rects.map(rect => {
    const [x, y, turn] = pose[i]!, [x0, y0, x1, y1] = rotatedRect(rect, turn);
    return [rounded(x0 + x), rounded(y0 + y), rounded(x1 + x), rounded(y1 + y)] as Rect;
  }));
  const segments: Frame['segments'] = [];
  for (const net of nets) {
    const points = net.pins.map(pin => {
      const [x, y, turn] = pose[pin[0]!]!, [x0, y0, x1, y1] = rotatedRect(pin.slice(1, 5), turn);
      return [rounded(x + (x0 + x1) / 2), rounded(y + (y0 + y1) / 2)] as XY;
    });
    for (const point of points.slice(1)) segments.push([points[0]![0], points[0]![1], point[0], point[1]]);
  }
  return { outline: scaled, rects, segments };
}

/** Construct playback frames from recorded epochs and terminal step poses only. */
export function playback(value: unknown, sourceSha256: string): Playback {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) throw new Error('source SHA-256 required');
  const run = record(value, 'run'), problem = record(run.problem, 'problem'), board = record(problem.board, 'problem.board');
  const outline = array(board.outline, 'board.outline').map((row, i) => {
    const p = numeric(row, 2, `board.outline[${i}]`); if (p.length !== 2) throw new Error('outline points must have two coordinates'); return p as XY;
  });
  if (outline.length < 3 || new Set(outline.map(p => p.join(','))).size < 3) throw new Error('board outline needs at least three distinct points');
  const area = outline.reduce((sum, p, i) => { const q = outline[(i + 1) % outline.length]!; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
  if (!Number.isFinite(area) || area === 0) throw new Error('board outline has no finite area');
  const units: Unit[] = array(problem.units, 'problem.units').map((value, i) => {
    const unit = record(value, `unit ${i}`), name = text(unit.name, `unit ${i}.name`);
    const refs = unit.refs === undefined ? [] : array(unit.refs, `unit ${i}.refs`).map((ref, j) => text(ref, `unit ${i}.refs[${j}]`));
    if (typeof unit.fixed !== 'boolean') throw new Error(`unit ${i}.fixed must be boolean`);
    const rects = array(unit.rects, `unit ${i}.rects`).map((rect, j) => {
      const r = numeric(rect, 5, `unit ${i}.rects[${j}]`);
      if (r.length !== 5 || r[0]! > r[2]! || r[1]! > r[3]! || r[4]! < 0) throw new Error(`unit ${i}.rects[${j}] is invalid`);
      return r;
    });
    const grouped = Array.isArray(unit.box) ? unit.box.length > 0 : Boolean(unit.box);
    return { name, refs, block: grouped ? name : '', fixed: unit.fixed, halo: rounded(Math.max(0, ...rects.map(r => r[4]!))), rects };
  });
  const nets: Net[] = array(problem.nets, 'problem.nets').map((value, i) => {
    const net = record(value, `net ${i}`);
    return { name: text(net.name, `net ${i}.name`), pins: array(net.pins, `net ${i}.pins`).map((value, j) => {
      const p = numeric(value, 5, `net ${i}.pins[${j}]`);
      if (!Number.isInteger(p[0]) || p[0]! < 0 || p[0]! >= units.length || p[1]! > p[3]! || p[2]! > p[4]!) throw new Error(`net ${i} pin has an invalid unit index or bounds`);
      return p;
    }) };
  });
  const frames: Frame[] = [], steps: Playback['steps'] = [];
  for (const [i, value] of array(run.steps, 'run.steps').entries()) {
    const step = record(value, `step ${i}`), s = finite(step.s, `step ${i}.s`), k = finite(step.k, `step ${i}.k`);
    if (k <= 0 || typeof step.passed !== 'boolean') throw new Error(`step ${i} has invalid scale or pass status`);
    const unrouted = step.unrouted === null ? null : finite(step.unrouted, `step ${i}.unrouted`);
    if (unrouted !== null && (!Number.isInteger(unrouted) || unrouted < 0)) throw new Error(`step ${i}.unrouted is invalid`);
    steps.push({ s, k, unrouted, passed: step.passed });
    const history = array(step.history, `step ${i}.history`);
    const add = (label: string, positions: unknown, score: unknown, components: unknown, open: number | null) => {
      const terms = record(components, `${label}.components`), clean: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const [key, number] of Object.entries(terms)) clean[key] = finite(number, `${label}.components.${key}`);
      frames.push({ step: i, label, s, cost: finite(score, `${label}.cost`), components: clean, unrouted: open, ...frameGeometry(units, nets, pose(positions, units.length, label), outline, k) });
    };
    for (const [j, item] of history.entries()) {
      const epoch = record(item, `step ${i}.history[${j}]`), number = finite(epoch.epoch, `step ${i}.history[${j}].epoch`);
      if (!Number.isInteger(number) || number < 0) throw new Error('epoch must be a nonnegative integer');
      add(`step ${i} epoch ${number}`, epoch.pose, epoch.cost, epoch.components, null);
    }
    if (step.pose !== null) add(`step ${i} result`, step.pose, step.cost, history.length ? record(history.at(-1), 'last epoch').components : {}, unrouted);
  }
  if (!frames.length) throw new Error('run contains no recorded placement frames');
  const netNames = units.map(() => new Set<string>());
  for (const net of nets) for (const pin of net.pins) netNames[pin[0]!]!.add(net.name);
  const region = problem.region ? record(problem.region, 'problem.region').box : null;
  let regionBox: Rect | null = null;
  if (region !== null && region !== undefined) { const r = numeric(region, 4, 'problem.region.box'); if (r.length !== 4 || r[0]! > r[2]! || r[1]! > r[3]!) throw new Error('region box is invalid'); regionBox = r as Rect; }
  return { schema: 'iot-lab.placer-playback.v1', source_sha256: sourceSha256, source_scope: 'recorded optimizer observations; not native DRC, qualification or fabrication evidence',
    units: units.map(({ rects: _rects, ...unit }, i) => ({ ...unit, nets: [...netNames[i]!].sort() })), frames, steps, region: regionBox,
    verdict: run.verdict === undefined ? '' : text(run.verdict, 'run.verdict'), unavailable: ['RUDY heat', 'PNG frames', 'GIF', 'MP4', 'routed-board renders'] };
}

const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recorded placement playback</title>
<style>body{font:15px system-ui;margin:1.2rem;max-width:1100px;background:#f7f8fa;color:#17212b}h1{font-size:1.35rem}canvas{background:white;border:1px solid #bac4ce;max-width:100%;height:auto}button,input{font:inherit}input[type=range]{width:min(65vw,640px)}.muted{color:#445563}pre{white-space:pre-wrap}#info{min-height:3em}</style></head><body>
<h1>Recorded placement playback</h1><p class="muted">Recorded optimizer poses and approximate rectangles; ratsnest lines are not tracks. This view is not a DRC or qualification result. RUDY heat, PNG, GIF, MP4 and routed-board renders are not included.</p>
<p><button id="play" type="button">Play</button> <input id="frame" type="range" min="0" value="0" aria-label="Recorded frame"> <span id="position"></span></p>
<canvas id="layout" width="1000" height="640" role="img" aria-label="Recorded board outline, component rectangles and ratsnest"></canvas>
<p id="details"></p><p id="info" class="muted">Select a rectangle to inspect its unit.</p><p id="verdict"></p><p id="source" class="muted"></p>
<script type="application/json" id="payload">`;
const SCRIPT = String.raw`</script><script>
'use strict';const D=JSON.parse(document.getElementById('payload').textContent), c=document.getElementById('layout'),g=c.getContext('2d'), slider=document.getElementById('frame'),button=document.getElementById('play');
slider.max=String(D.frames.length-1);document.getElementById('verdict').textContent='Recorded verdict: '+(D.verdict||'not recorded');document.getElementById('source').textContent='Source SHA-256: '+D.source_sha256+' · '+D.source_scope;
const all=D.frames.flatMap(f=>f.outline),minX=Math.min(...all.map(p=>p[0]))-1,minY=Math.min(...all.map(p=>p[1]))-1,maxX=Math.max(...all.map(p=>p[0]))+1,maxY=Math.max(...all.map(p=>p[1]))+1;
const scale=Math.min((c.width-40)/(maxX-minX),(c.height-40)/(maxY-minY)),X=x=>20+(x-minX)*scale,Y=y=>20+(y-minY)*scale;
function colour(s){let h=0;for(const x of s)h=(h*31+x.codePointAt(0))%360;return 'hsl('+h+' 55% 55%)';}
function draw(i){const f=D.frames[i];g.clearRect(0,0,c.width,c.height);g.strokeStyle='#263746';g.lineWidth=2;g.beginPath();f.outline.forEach((p,j)=>j?g.lineTo(X(p[0]),Y(p[1])):g.moveTo(X(p[0]),Y(p[1])));g.closePath();g.stroke();
 if(D.region){const r=D.region;g.strokeStyle='#a1259b';g.setLineDash([5,4]);g.strokeRect(X(r[0]),Y(r[1]),(r[2]-r[0])*scale,(r[3]-r[1])*scale);g.setLineDash([]);}
 g.strokeStyle='#c77c42';g.lineWidth=1;for(const s of f.segments){g.beginPath();g.moveTo(X(s[0]),Y(s[1]));g.lineTo(X(s[2]),Y(s[3]));g.stroke();}
 f.rects.forEach((rects,i)=>{const u=D.units[i];g.fillStyle=u.block?colour(u.block):u.fixed?'#929aa2':'#58a887';for(const r of rects){g.globalAlpha=.65;g.fillRect(X(r[0]),Y(r[1]),(r[2]-r[0])*scale,(r[3]-r[1])*scale);g.globalAlpha=1;}});
 document.getElementById('position').textContent=(i+1)+' / '+D.frames.length;const terms=Object.entries(f.components).map(([k,v])=>k+'='+v).join(' · '),s=D.steps[f.step];document.getElementById('details').textContent=f.label+' · scale '+f.s+' · cost '+f.cost+(f.unrouted===null?'':' · unrouted '+f.unrouted)+(s.passed?' · recorded PASS':' · recorded FAIL')+(terms?' · '+terms:'');}
let timer=null;function stop(){if(timer!==null){clearInterval(timer);timer=null;}button.textContent='Play';}slider.addEventListener('input',()=>{stop();draw(Number(slider.value));});button.addEventListener('click',()=>{if(timer!==null){stop();return;}button.textContent='Pause';timer=setInterval(()=>{const n=Number(slider.value)+1;if(n>=D.frames.length){stop();return;}slider.value=String(n);draw(n);},Math.max(16,Math.round(D.duration_s*1000/Math.max(1,D.frames.length-1))));});
c.addEventListener('click',e=>{const box=c.getBoundingClientRect(),x=((e.clientX-box.left)*c.width/box.width-20)/scale+minX,y=((e.clientY-box.top)*c.height/box.height-20)/scale+minY,f=D.frames[Number(slider.value)];for(let i=f.rects.length-1;i>=0;i--)if(f.rects[i].some(r=>x>=r[0]&&x<=r[2]&&y>=r[1]&&y<=r[3])){const u=D.units[i];document.getElementById('info').textContent=u.name+(u.fixed?' (fixed)':'')+' · refs: '+u.refs.join(', ')+' · nets: '+u.nets.join(', ')+' · halo '+u.halo+' mm';return;}});draw(0);
</script></body></html>`;

export function html(data: Playback, durationSeconds: number): string {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('playback duration must be finite and positive');
  const payload = JSON.stringify({ ...data, duration_s: durationSeconds }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return PAGE + payload + SCRIPT;
}

const USAGE = 'usage: viewer.ts RUN.json OUT.html [--frames-json FILE] [--seconds N]';
function main(argv: string[]): number {
  const parsed = parseFlags(argv, { 'frames-json': { type: 'string' }, seconds: { type: 'string' } }, USAGE);
  const [input, output] = parsed.positionals;
  if (!input || !output || parsed.positionals.length !== 2) throw new UsageError(USAGE);
  const duration = parsed.values.seconds === undefined ? 15 : Number(parsed.values.seconds);
  const source = readFileSync(input), data = playback(JSON.parse(source.toString('utf8')), createHash('sha256').update(source).digest('hex'));
  const page = html(data, duration), frames = parsed.values['frames-json'];
  if (frames && resolve(frames) === resolve(output)) throw new Error('HTML and frames JSON must use different output paths');
  const created: string[] = [];
  try {
    for (const [path, bytes] of [[output, page], ...(frames ? [[frames, JSON.stringify({ ...data, duration_s: duration }) + '\n']] : [])] as [string, string][]) {
      const fd = openSync(path, 'wx', 0o644); created.push(path);
      try { writeFileSync(fd, bytes); } finally { closeSync(fd); }
    }
  } catch (error) { for (const path of created) rmSync(path, { force: true }); throw error; }
  console.log(`${output}: ${data.frames.length} recorded frames; HTML playback only (no RUDY heat, PNG, GIF, MP4 or routed renders)`);
  return 0;
}

runMain(import.meta.url, main);
