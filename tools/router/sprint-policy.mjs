// Experimental portfolio knobs, not electrical rules. Keep the search model unchanged.
const fields = new Set(['seeds', 'via_costs', 'parallelism', 'slice_passes', 'deadline_s', 'verify_reserve_s', 'mem_gb']);
const number = (value, name, min, max, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    throw Error(`sprints.${name} must be ${integer ? 'an integer' : 'a number'} in ${min}..${max}`);
  return value;
};
const list = (value, name, min, max, integer) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw Error(`sprints.${name} needs 1..16 values`);
  const out = value.map(v => number(v, name, min, max, integer));
  if (new Set(out).size !== out.length) throw Error(`sprints.${name} must be distinct`);
  return out;
};

export function sprintPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('sprints must be an object');
  for (const key of Object.keys(value)) if (!fields.has(key)) throw Error(`unknown sprints field: ${key}`);
  const seeds = list(value.seeds ?? [0, 1, 2, 3], 'seeds', 0, 0xffffffff, true);
  const via_costs = list(value.via_costs ?? [3], 'via_costs', 0, 100, false);
  const count = seeds.length * via_costs.length;
  if (count > 16) throw Error('sprints permits at most 16 seed/cost variants');
  const parallelism = number(value.parallelism ?? Math.min(2, count), 'parallelism', 1, Math.min(16, count), true);
  const slice_passes = number(value.slice_passes ?? 2, 'slice_passes', 1, 100, true);
  const deadline_s = number(value.deadline_s ?? 120, 'deadline_s', 30, 3600, true);
  const verify_reserve_s = number(value.verify_reserve_s ?? Math.min(30, deadline_s / 2), 'verify_reserve_s', 10, deadline_s - 10);
  const mem_gb = number(value.mem_gb ?? Math.max(4, parallelism * 2), 'mem_gb', 2, 32, true);
  if (parallelism * 2 > mem_gb) throw Error('sprints requires at least 2 GiB reserved per concurrent variant');
  return { seeds, via_costs, parallelism, slice_passes, deadline_s, verify_reserve_s, mem_gb };
}

export function sprintVariants(policy) {
  return policy.seeds.flatMap(seed => policy.via_costs.map(via_cost => ({ seed, via_cost })))
    .map((v, index) => ({ id: `v${String(index).padStart(2, '0')}`, ...v }));
}
