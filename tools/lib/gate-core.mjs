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
export function passes(metrics) {
  const open = [];
  for (const [name, value] of Object.entries(metrics)) {
    const m = METRICS[name];
    if (value === null) open.push(`${name}: tool did not run`);
    else if (m?.target !== undefined && value > m.target) open.push(`${name}: ${value}`);
  }
  return {ok: open.length === 0, open};
}

// waivers: [{metric, to, reason, date}]. A waiver allows `metric` to rise to `to` or less.
// Returns {blocked: [...], warnings: [...], waived: [...], improved: [...]} as text lines.
export function ratchet(before, after, waivers = []) {
  const res = {blocked: [], warnings: [], waived: [], improved: []};
  for (const [name, now] of Object.entries(after)) {
    const m = METRICS[name] ?? {level: 'soft'};
    const was = before?.[name];
    if (now === null) {
      res.blocked.push(`${name}: tool did not run`);
      continue;
    }
    if (was === undefined || was === null) continue;
    const line = `${name}: ${was} -> ${now}`;
    if (now < was) res.improved.push(line);
    if (now <= was || m.level === 'info') continue;
    const waiver = waivers.find((w) => w.metric === name && now <= w.to && w.reason && w.date);
    if (waiver) res.waived.push(`${line} (waiver ${waiver.date}: ${waiver.reason})`);
    else if (m.level === 'hard') res.blocked.push(line);
    else res.warnings.push(line);
  }
  return res;
}

// Stable text for the tracked metrics file: fixed key order, no time, no absolute path.
export function metricsText({board, pcbSha256, schSha256, metrics}) {
  const ordered = Object.fromEntries(Object.keys(METRICS).filter((k) => k in metrics).map((k) => [k, metrics[k]]));
  return `${JSON.stringify({schema_version: 1, board, pcb_sha256: pcbSha256, sch_sha256: schSha256, metrics: ordered}, null, 2)}\n`;
}

// First integer captured by regex in the tool output, else null (the tool did not run).
export function countFrom(out, regex) {
  const m = regex.exec(out);
  return m ? Number(m[1]) : null;
}
