#!/usr/bin/env node
// Compare placer runs without and with soft clusters (README "Automatic clusters"). Only reads the result files.
//
//   node tools/placer/bench_clusters.mjs [--json OUT.json] NAME OFF_PROB.json ON_PROB.json OFF_RES.json,... ON_RES.json,...
//
// The two result lists are paired by position: the same seed and the same time budget. Repeat NAME ... for more boards.
// A row of the table is the mean over the seeds; better and worse count the (cap, seed) pairs.
//
// Numbers that compare fairly. HPWL = the real nets only, and cost = the search cost less the cluster ties, so the pull
// that the on run pays for is not in its score. Cap distance = from the cap's power pad to the nearest pad of its net on
// an IC, by pad centres: it does not use the proposal, so a cap counts the same in both runs.
import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const GROUND = /GND|VSS|(^|[_/])0V$/i;  // clusters.mjs GROUND
const IC_PADS = 3;                      // clusters.mjs IC_PADS
export const NOISE_MM = 0.5;            // a change below the D-040 passive spacing is not a better or worse place

const rot = (x, y, r) => [[x, y], [y, -x], [-x, -y], [-y, x]][((r % 4) + 4) % 4];

function rotRect([x0, y0, x1, y1], r) {
  const [a, b] = rot(x0, y0, r), [c, d] = rot(x1, y1, r);
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

// Half perimeter of the real nets; ties = the cluster ties and other cohesion nets, at their weights.
export function wire(pr, pose) {
  let hpwl = 0, ties = 0;
  for (const n of pr.nets) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [u, ...box] of n.pins) {
      const [a, b, c, d] = rotRect(box, pose[u][2]);
      x0 = Math.min(x0, a + pose[u][0]); y0 = Math.min(y0, b + pose[u][1]);
      x1 = Math.max(x1, c + pose[u][0]); y1 = Math.max(y1, d + pose[u][1]);
    }
    const len = n.weight * (x1 - x0 + y1 - y0);
    if (n.cohesion) ties += len; else hpwl += len;
  }
  return {hpwl, ties};
}

// {cap: mm}. Every 2-pad C with one pad on ground and the other on a net with an IC pin.
export function capDistances(pr, pose) {
  const pads = new Map();  // ref -> [{num, net, x, y}]
  pr.units.forEach((u, i) => {
    (u.cu_pads || []).forEach(([ref, , num], k) => {
      const [x0, y0, x1, y1, code] = u.cu[k];
      const [a, b] = rot((x0 + x1) / 2, (y0 + y1) / 2, pose[i][2]);
      if (!pads.has(ref)) pads.set(ref, []);
      pads.get(ref).push({num, net: pr.cu_nets[String(code)]?.[0] ?? '', x: a + pose[i][0], y: b + pose[i][1]});
    });
  });
  const pins = new Map();  // net -> IC pads
  for (const [ref, list] of pads) {
    if (!/^U\d/.test(ref) || list.length <= IC_PADS) continue;
    for (const p of list) if (p.net) (pins.get(p.net) || pins.set(p.net, []).get(p.net)).push(p);
  }
  const out = {};
  for (const [ref, list] of pads) {
    if (!/^C\d/.test(ref) || list.length !== 2) continue;
    const power = list.filter(p => p.net && !GROUND.test(p.net));
    if (power.length !== 1 || list.every(p => !GROUND.test(p.net)) || !pins.has(power[0].net)) continue;
    out[ref] = Math.min(...pins.get(power[0].net).map(p => Math.hypot(p.x - power[0].x, p.y - power[0].y)));
  }
  return out;
}

const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN;
}

// One candidate: the best of the run (legal first: anneal.final_key).
export function measure(pr, res) {
  const c = res.candidates[0];
  const {hpwl, ties} = wire(pr, c.pose);
  return {cost: c.cost - ties, hpwl, cong: c.components.cong, spacing: c.components.spacing, illegal: c.illegal.length,
    timeout: Boolean(c.timeout), wall: res.wall_s, moves: res.moves_per_s_per_worker, time: timeSplit(res.profile),
    caps: capDistances(pr, c.pose)};
}

// Where a run's wall time goes, from anneal's profile. Setup holds gather(); barrier = the epoch wall time beyond the
// slowest worker's search: pool start-up, passing poses, and the wait at the end of each epoch.
export function timeSplit(p) {
  const search = p.epochs.reduce((a, e) => a + Math.max(...e.worker_search_seconds), 0);
  const map = p.epochs.reduce((a, e) => a + e.map_seconds, 0);
  return {setup: p.setup_seconds + p.pool_create_seconds, search, barrier: map - search, legalize: p.finish_map_seconds};
}

export function compare(name, off, on) {
  const pairs = off.flatMap((o, k) => Object.keys(o.caps).map(cap => on[k].caps[cap] - o.caps[cap]));
  const side = (rows) => ({
    cost: mean(rows.map(r => r.cost)), hpwl: mean(rows.map(r => r.hpwl)), cong: mean(rows.map(r => r.cong)),
    spacing: mean(rows.map(r => r.spacing)), illegal: rows.map(r => r.illegal), timeouts: rows.filter(r => r.timeout).length,
    wall: mean(rows.map(r => r.wall)), time: Object.fromEntries(['setup', 'search', 'barrier', 'legalize'].map(k => [k, mean(rows.map(r => r.time[k]))])),
    capMedian: median(rows.flatMap(r => Object.values(r.caps))),
    capWithin3: mean(rows.map(r => Object.values(r.caps).filter(d => d <= 3).length)),
    costs: rows.map(r => Math.round(r.cost)), hpwls: rows.map(r => Math.round(r.hpwl)), congs: rows.map(r => Math.round(r.cong)),
  });
  return {name, caps: Object.keys(off[0].caps).length, off: side(off), on: side(on),
    better: pairs.filter(d => d <= -NOISE_MM).length, worse: pairs.filter(d => d >= NOISE_MM).length,
    same: pairs.filter(d => Math.abs(d) < NOISE_MM).length};
}

export function table(rows) {
  const f = v => v.toFixed(0), g = v => v.toFixed(1);
  const out = ['| Board | Mode | Cost | HPWL mm | RUDY overflow | Illegal units per seed | Setup / search / barrier / legalize s | Cap median mm | Caps within 3 mm | Caps better / worse / same |',
    '|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    for (const m of ['off', 'on']) {
      const s = r[m];
      out.push(`| ${r.name} | ${m} | ${f(s.cost)} | ${f(s.hpwl)} | ${f(s.cong)} | ${s.illegal.join(' ')} | ${f(s.time.setup)} / ${f(s.time.search)} / ${f(s.time.barrier)} / ${f(s.time.legalize)} | ${g(s.capMedian)} | ` +
        `${g(s.capWithin3)} of ${r.caps} | ${m === 'on' ? `${r.better} / ${r.worse} / ${r.same}` : '-'} |`);
    }
  }
  return out.join('\n');
}

function main(argv) {
  const args = [...argv];
  let json = null;
  if (args[0] === '--json') { json = args[1]; args.splice(0, 2); }
  if (!args.length || args.length % 5) {
    console.error('usage: bench_clusters.mjs [--json OUT] NAME OFF_PROB ON_PROB OFF_RES,... ON_RES,... [NAME ...]');
    return 2;
  }
  const read = f => JSON.parse(readFileSync(f, 'utf8'));
  const rows = [];
  for (let i = 0; i < args.length; i += 5) {
    const [name, offProb, onProb, offRes, onRes] = args.slice(i, i + 5);
    const [po, pn] = [read(offProb), read(onProb)];
    const take = (pr, list) => list.split(',').map(f => measure(pr, read(f)));
    rows.push(compare(name, take(po, offRes), take(pn, onRes)));
  }
  if (json) writeFileSync(json, JSON.stringify(rows, null, 1) + '\n');
  console.log(table(rows));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
