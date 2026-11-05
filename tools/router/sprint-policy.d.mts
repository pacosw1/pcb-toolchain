export interface SprintPolicy {
  seeds: number[]; via_costs: number[]; parallelism: number; slice_passes: number;
  deadline_s: number; verify_reserve_s: number; mem_gb: number;
}
export function sprintPolicy(value: unknown): SprintPolicy;
export function sprintVariants(policy: SprintPolicy): { id: string; seed: number; via_cost: number }[];
