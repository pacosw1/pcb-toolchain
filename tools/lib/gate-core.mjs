// Pure logic of tools/gate.mjs: the metric table, the ratchet compare and the waivers. No process spawn (tests call it directly).

// Each metric is a count; smaller is better. target 0 means the gate passes only at 0.
// level 'hard': an increase blocks a commit. level 'soft': an increase gives a warning. info: reported only.
export const METRICS = {
  erc_errors: {level: 'hard', target: 0},
  erc_warnings: {level: 'info'},
  drc_errors: {level: 'hard', target: 0},
  drc_parity: {level: 'hard', target: 0},
  drc_unconnected: {level: 'hard', target: 0},
  drc_warnings: {level: 'info'},
  planes_failures: {level: 'soft', target: 0},
  pairs_failures: {level: 'soft', target: 0},
  viapads: {level: 'soft', target: 0},
  paths_low: {level: 'soft', target: 0},
  kicad_happy_findings: {level: 'soft', target: 0},
  port_label_failures: {level: 'soft', target: 0},
  placement_failures: {level: 'soft', target: 0},
  rf_failures: {level: 'soft', target: 0},
};

export function pathFailures(text) {
  const lines=text.split(/\r?\n/);
  const low=lines.filter(l=>l.startsWith('LOW ')).length;
  const missing=lines.filter(l=>l.startsWith('MISSING ')).length;
  const pairs=lines.filter(l=>/^\d+ power-path pairs below the design current$/.test(l));
  const supplies=lines.filter(l=>/^\d+ supply nets not covered$/.test(l));
  if(pairs.length!==1 || supplies.length!==1 || Number(pairs[0].split(' ')[0])!==low || Number(supplies[0].split(' ')[0])!==missing) return null;
  if(low+missing===0 && text.includes('[gate-check-exit:1]')) return null;
  return low+missing;
}

// A metric of null means "the tool did not run". It never passes (fail closed).
export const CORE_METRICS = ['erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'];
export const CHECK_METRICS = {
  erc: ['erc_errors', 'erc_warnings'], drc: ['drc_errors', 'drc_parity', 'drc_unconnected', 'drc_warnings'],
  planes: ['planes_failures'], pairs: ['pairs_failures'], paths: ['paths_low'], viapads: ['viapads'],
  kicad_happy: ['kicad_happy_findings'], port_labels: ['port_label_failures'], rf: ['rf_failures'], placement: ['placement_failures'],
};
// Keep provenance collection and receipt verification in agreement about
// which enabled checks still invoke pcbnew.
export const BOARD_JSON_CHECKS = ['rf', 'viapads', 'paths', 'planes', 'pairs'];
export function gateNeedsPcbnew(checks = {}) {
  const withoutPcbnew = new Set(['erc', 'drc', 'kicad_happy', 'port_labels', ...BOARD_JSON_CHECKS]);
  return Object.entries(checks).some(([name, enabled]) => enabled && !withoutPcbnew.has(name));
}
export function validateConfig(cfg) {
  const errors = [];
  if(!cfg || typeof cfg!=='object' || Array.isArray(cfg)) return ['gate configuration must be an object'];
  if(!cfg.checks || typeof cfg.checks!=='object' || Array.isArray(cfg.checks)) return ['checks must be an object'];
  const stage = cfg.stage ?? 'G4';
  if (!['G3', 'G4', 'G5'].includes(stage)) errors.push(`unknown gate stage ${stage}`);
  const required = stage === 'G3' ? ['erc'] : ['erc', 'drc', 'paths', 'viapads', 'kicad_happy', 'port_labels'];
  for (const key of required) if (!cfg.checks?.[key]) errors.push(`required check disabled or absent: ${key}`);
  for (const [key, value] of Object.entries(cfg.checks ?? {})) {
    if (!(key in CHECK_METRICS)) errors.push(`unknown check: ${key}`);
    if (['planes','pairs','paths','rf','placement'].includes(key) && value && typeof value !== 'string') errors.push(`${key}: expected configuration filename`);
    if(['erc','drc','port_labels'].includes(key) && typeof value!=='boolean') errors.push(`${key}: expected boolean`);
    if(['viapads','kicad_happy'].includes(key) && value && (typeof value!=='object' || Array.isArray(value))) errors.push(`${key}: expected options object`);
  }
  if (typeof cfg.project !== 'string' || !cfg.project) errors.push('project is required');
  return errors;
}
export function expectedMetrics(cfg) {
  return Object.entries(cfg.checks).filter(([,v]) => v).flatMap(([k]) => CHECK_METRICS[k] ?? []);
}
const validCount = v => Number.isSafeInteger(v) && v >= 0;
const validDate = d => typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) &&
  !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0,10)===d;
export function passes(metrics, required = CORE_METRICS) {
  const open = [];
  for (const name of required) if (!(name in metrics)) open.push(`${name}: missing required metric`);
  for (const [name, value] of Object.entries(metrics)) {
    const m = METRICS[name];
    if (!m) open.push(`${name}: unknown metric`);
    if (!validCount(value)) open.push(`${name}: invalid count or tool did not run`);
    else if (m?.target !== undefined && value > m.target) open.push(`${name}: ${value}`);
  }
  return {ok: open.length === 0, open};
}

// waivers: [{metric, to, reason, date}]. A waiver allows `metric` to rise to `to` or less.
// Returns {blocked: [...], warnings: [...], waived: [...], improved: [...]} as text lines.
export function ratchet(before, after, waivers = [], context = {}) {
  const res = {blocked: [], warnings: [], waived: [], improved: []};
  const required = context.required ?? CORE_METRICS;
  for (const name of new Set([...required, ...Object.keys(before ?? {})])) {
    if (!(name in after)) res.blocked.push(`${name}: removed or missing metric`);
  }
  for (const [name, now] of Object.entries(after)) {
    const m = METRICS[name] ?? {level: 'soft'};
    const was = before?.[name];
    if (!validCount(now) || !(name in METRICS)) {
      res.blocked.push(`${name}: invalid count or tool did not run`);
      continue;
    }
    if(was!==undefined && was!==null && !validCount(was)) {
      res.blocked.push(`${name}: invalid baseline count`);
      continue;
    }
    if (was === undefined || was === null) continue;
    const line = `${name}: ${was} -> ${now}`;
    if (now < was) res.improved.push(line);
    if (now <= was || m.level === 'info') continue;
    const today = context.today ?? new Date().toISOString().slice(0,10);
    const waiver = waivers.find(w => w.metric === name && w.from === was && validCount(w.to) && now <= w.to &&
      typeof w.reason==='string' && w.reason.trim() && typeof w.owner==='string' && w.owner.trim() && validDate(w.date) && validDate(w.expires) &&
      w.date <= today && today <= w.expires && context.revision && w.revision === context.revision &&
      context.inputFingerprint && w.inputFingerprint === context.inputFingerprint);
    if (waiver) res.waived.push(`${line} (waiver ${waiver.date}: ${waiver.reason})`);
    else if (m.level === 'hard') res.blocked.push(line);
    else res.warnings.push(line);
  }
  return res;
}

// Stable text for the tracked metrics file: fixed key order, no time, no absolute path.
export function metricsText({board, pcbSha256, schSha256, metrics, provenance}) {
  const ordered = Object.fromEntries(Object.keys(METRICS).filter((k) => k in metrics).map((k) => [k, metrics[k]]));
  return `${JSON.stringify({schema_version: 2, board, pcb_sha256: pcbSha256, sch_sha256: schSha256, ...(provenance ? {provenance} : {}), metrics: ordered}, null, 2)}\n`;
}

// First integer captured by regex in the tool output, else null (the tool did not run).
export function countFrom(out, regex) {
  const m = regex.exec(out);
  const count=m ? Number(m[1]) : null;
  return count===0 && out.includes('[gate-check-exit:1]') ? null : count;
}
