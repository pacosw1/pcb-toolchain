// The iot-lab.route.v1 schema of <board>/route.json, for checks that run without iotroute (tools/pcb project-check).
// tools/router/core/src/plan/load.rs stays the authority at route time. Only one rule differs: load.rs knows the copper
// layers of the board, this file only reads JSON and so checks the layer name form.
const SCHEMA = 'iot-lab.route.v1';
const COPPER = /^(?:F|B|In\d+)\.Cu$/;
const TOP_KEYS = ['schema', 'about', 'backend', 'layers', 'budget', 'stages', 'pours', 'widths', 'features', 'reuse'];
const BUDGET_KEYS = ['passes', 'time_s', 'threads'];
const STAGE_KEYS = ['name', 'only_nets', 'skip_nets', 'layers', 'plane_nets', 'route_planes', 'neck_um', 'unlock_nets', 'via_skip', 'remove_zones', 'keepouts', 'require', 'passes', 'time_s', 'threads'];
const STAGE_NAMES = ['only_nets', 'skip_nets', 'plane_nets', 'unlock_nets', 'via_skip', 'remove_zones'];
const KEEPOUT_KEYS = ['name', 'inside', 'outside', 'layers'];
const POUR_KEYS = ['name', 'net', 'layer', 'shape', 'grow_mm', 'priority', 'connection', 'minus', 'clearance_mm', 'thermal_gap_mm', 'spoke_mm'];
const WIDTH_KEYS = ['name', 'box', 'layers', 'width_mm'];
// Keep backend admission aligned with route_run/iotroute.rs::check_plan.
const IOTROUTE_FEATURES = new Set(['rule_compiler', 'via_off_small_pads', 'via_halo']);

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);

/** Every problem of a route.json value; empty when it is valid. `features` names the known route features. */
export function routePlanErrors(plan: unknown, features: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const fail = (message: string): void => { errors.push(message); };
  const keys = (value: unknown, allowed: string[], place: string): value is Raw => {
    if (!isObject(value)) { fail(`${place} must be an object`); return false; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${place}: unknown key ${key}`);
    return true;
  };
  const count = (raw: Raw, key: string, place: string): void => {
    if (key in raw && !(Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0)) fail(`${place}.${key} must be an integer >= 0`);
  };
  const names = (value: unknown, place: string): string[] => {
    if (Array.isArray(value) && value.every(name => typeof name === 'string' && name)) return value as string[];
    fail(`${place} must be a list of non-empty strings`);
    return [];
  };
  const layers = (value: unknown, place: string): void => {
    const list = names(value, place);
    for (const name of list) if (!COPPER.test(name)) fail(`${place}: ${name} is not a copper layer name`);
    if (Array.isArray(value) && !value.length) fail(`${place} must name at least one layer`);
  };
  const rect = (value: unknown, place: string): void => {
    if (!Array.isArray(value) || value.length !== 4 || value.some(number => typeof number !== 'number')) { fail(`${place} must be [x0, y0, x1, y1] in mm`); return; }
    if (!(value[0] < value[2] && value[1] < value[3])) fail(`${place} needs x0 < x1 and y0 < y1`);
  };
  const mm = (raw: Raw, key: string, place: string): void => {
    if (!(typeof raw[key] === 'number' && raw[key] > 0)) fail(`${place}.${key} must be a number > 0 (mm)`);
  };
  const required = (raw: Raw, key: string, place: string): void => {
    if (typeof raw[key] !== 'string' || !raw[key]) fail(`${place}.${key} is required`);
  };
  const list = (raw: Raw, key: string, place: string): unknown[] => {
    if (!(key in raw)) return [];
    if (Array.isArray(raw[key])) return raw[key];
    fail(`${place} must be a list`);
    return [];
  };
  const keepout = (raw: unknown, place: string): void => {
    if (!keys(raw, KEEPOUT_KEYS, place)) return;
    required(raw, 'name', place);
    if (('inside' in raw) === ('outside' in raw)) fail(`${place} needs exactly one of inside or outside`);
    else rect(raw.inside ?? raw.outside, `${place}.${'inside' in raw ? 'inside' : 'outside'}`);
    if ('layers' in raw) layers(raw.layers, `${place}.layers`);
  };
  const stage = (raw: Raw, place: string): void => {
    if ('only_nets' in raw && 'skip_nets' in raw) fail(`${place}: only_nets and skip_nets cannot both be set`);
    if ('layers' in raw) layers(raw.layers, `${place}.layers`);
    for (const key of STAGE_NAMES) if (key in raw) names(raw[key], `${place}.${key}`);
    for (const key of [...BUDGET_KEYS, 'neck_um']) count(raw, key, place);
    if ('route_planes' in raw && typeof raw.route_planes !== 'boolean') fail(`${place}.route_planes must be true or false`);
    if ('require' in raw && keys(raw.require, ['open', 'vias'], `${place}.require`)) {
      count(raw.require, 'open', `${place}.require`);
      if (raw.require.vias !== null) count(raw.require, 'vias', `${place}.require`);
    }
    list(raw, 'keepouts', `${place}.keepouts`).forEach((item, index) => keepout(item, `${place}.keepouts[${index}]`));
  };
  const pour = (raw: unknown, place: string): void => {
    if (!keys(raw, POUR_KEYS, place)) return;
    for (const key of ['name', 'net', 'layer']) required(raw, key, place);
    if (typeof raw.layer === 'string' && raw.layer && !COPPER.test(raw.layer)) fail(`${place}: ${raw.layer} is not a copper layer name`);
    if (raw.shape !== 'board' && raw.shape !== 'around') fail(`${place}.shape must be board or around`);
    if (raw.shape === 'around' && !(typeof raw.grow_mm === 'number' && raw.grow_mm > 0)) fail(`${place}.grow_mm must be > 0 for an around pour`);
    if ('connection' in raw && raw.connection !== 'full' && raw.connection !== 'thermal') fail(`${place}.connection must be full or thermal`);
    count(raw, 'priority', place);
    list(raw, 'minus', `${place}.minus`).forEach((box, index) => rect(box, `${place}.minus[${index}]`));
    for (const key of ['clearance_mm', 'thermal_gap_mm', 'spoke_mm']) if (key in raw) mm(raw, key, place);
  };
  const width = (raw: unknown, place: string): void => {
    if (!keys(raw, WIDTH_KEYS, place)) return;
    required(raw, 'name', place);
    rect(raw.box, `${place}.box`);
    if ('layers' in raw) layers(raw.layers, `${place}.layers`);
    mm(raw, 'width_mm', place);
  };

  if (!keys(plan, TOP_KEYS, 'route.json')) return errors;
  if (plan.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  if (plan.backend === 'fastroute') fail('backend fastroute was removed: this board needs the iotroute backend');
  else if (plan.backend !== 'tracemaker' && plan.backend !== 'iotroute') fail('backend must be tracemaker or iotroute');
  layers(plan.layers, 'layers');
  if ('budget' in plan && keys(plan.budget, BUDGET_KEYS, 'budget')) for (const key of BUDGET_KEYS) count(plan.budget, key, 'budget');
  if (!Array.isArray(plan.stages) || !plan.stages.length) fail('stages must be a non-empty list');
  else {
    const seen = new Set<unknown>();
    plan.stages.forEach((raw: unknown, index: number) => {
      const place = `stages[${index}]`;
      if (!keys(raw, STAGE_KEYS, place)) return;
      required(raw, 'name', place);
      if (raw.name && seen.has(raw.name)) fail(`duplicate stage name ${String(raw.name)}`);
      seen.add(raw.name);
      stage(raw, place);
      if (plan.backend === 'iotroute') {
        const threads = raw.threads ?? (isObject(plan.budget) ? plan.budget.threads : 0) ?? 0;
        for (const [set, option] of [
          [typeof threads === 'number' && threads > 0, 'threads'],
          [Array.isArray(raw.unlock_nets) && raw.unlock_nets.length > 0, 'unlock_nets'],
          [Array.isArray(raw.via_skip) && raw.via_skip.length > 0, 'via_skip'],
        ] as const) if (set) fail(`stage ${String(raw.name)}: ${option} has no iotroute meaning`);
      }
    });
  }
  list(plan, 'pours', 'pours').forEach((raw, index) => pour(raw, `pours[${index}]`));
  list(plan, 'widths', 'widths').forEach((raw, index) => width(raw, `widths[${index}]`));
  if ('features' in plan) {
    if (!isObject(plan.features)) fail('features must be an object');
    else for (const [key, value] of Object.entries(plan.features)) {
      if (!features.has(key)) fail(`unknown feature ${key}`);
      else if (typeof value !== 'boolean') fail(`features.${key} must be true or false`);
      if (plan.backend === 'iotroute' && typeof value === 'boolean') {
        if (!IOTROUTE_FEATURES.has(key)) fail(`feature ${key} has no iotroute meaning`);
        else if (!value) fail(`feature ${key} cannot be off: iotroute always does this`);
      }
    }
  }
  if ('reuse' in plan && keys(plan.reuse, ['from', 'nets'], 'reuse')) {
    if (typeof plan.reuse.from !== 'string' || !plan.reuse.from.startsWith('/')) fail('reuse: from must be an absolute path');
    if ('nets' in plan.reuse && !(Array.isArray(plan.reuse.nets) && plan.reuse.nets.every(net => typeof net === 'string'))) fail('reuse: nets must be a list of names');
  }
  return errors;
}
