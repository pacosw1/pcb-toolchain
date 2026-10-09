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
  rf_failures: {level: 'soft', target: 0},
};

// A metric of null means "the tool did not run". It never passes (fail closed).
export const CORE_METRICS = ['erc_errors', 'drc_errors', 'drc_parity', 'drc_unconnected'];
export const CHECK_METRICS = {
  erc: ['erc_errors', 'erc_warnings'], drc: ['drc_errors', 'drc_parity', 'drc_unconnected', 'drc_warnings'],
  planes: ['planes_failures'], pairs: ['pairs_failures'], paths: ['paths_low'], viapads: ['viapads'],
  kicad_happy: ['kicad_happy_findings'], port_labels: ['port_label_failures'], rf: ['rf_failures'],
};
export function validateConfig(cfg) {
  const errors = [];
  const stage = cfg.stage ?? 'G4';
  if (!['G3', 'G4', 'G5'].includes(stage)) errors.push(`unknown gate stage ${stage}`);
  const required = stage === 'G3' ? ['erc'] : ['erc', 'drc', 'paths', 'viapads', 'kicad_happy', 'port_labels'];
  for (const key of required) if (!cfg.checks?.[key]) errors.push(`required check disabled or absent: ${key}`);
  for (const [key, value] of Object.entries(cfg.checks ?? {})) {
    if (!(key in CHECK_METRICS)) errors.push(`unknown check: ${key}`);
    if (['planes','pairs','paths','rf'].includes(key) && value && typeof value !== 'string') errors.push(`${key}: expected configuration filename`);
  }
  if (typeof cfg.project !== 'string' || !cfg.project) errors.push('project is required');
  return errors;
}
export function expectedMetrics(cfg) {
  return Object.entries(cfg.checks).filter(([,v]) => v).flatMap(([k]) => CHECK_METRICS[k] ?? []);
}
const validCount = v => Number.isSafeInteger(v) && v >= 0;
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
    if (was === undefined || was === null) continue;
    const line = `${name}: ${was} -> ${now}`;
    if (now < was) res.improved.push(line);
    if (now <= was || m.level === 'info') continue;
    const today = context.today ?? new Date().toISOString().slice(0,10);
    const waiver = waivers.find(w => w.metric === name && w.from === was && validCount(w.to) && now <= w.to &&
      w.reason && w.owner && /^\d{4}-\d{2}-\d{2}$/.test(w.date ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(w.expires ?? '') &&
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
