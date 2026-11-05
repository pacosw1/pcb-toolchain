// Revalidate native thermal receipts with the owned route-coverage binary.
// Board reads are supported in the pinned Linux job runtime, never by launching
// a local macOS board job. Failure remains an unverified observation.
import { spawnSync } from 'node:child_process';
import { isDict, type Dict } from './py-values.ts';
import type { ThermalServices } from './outcome-controls.ts';

type Execute = (operation: string, request: Dict) => Dict;

export function localThermalProof(operation: string, request: Dict): Dict {
  if (process.platform !== 'linux') throw new Error('native thermal proof requires the pinned Linux job runtime');
  const binary = process.env.ROUTE_COVERAGE_BIN || 'route-coverage';
  const result = spawnSync(binary, [operation], { input: JSON.stringify(request), encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw new Error(`native thermal proof failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`native thermal proof failed: ${(result.stderr || `exit ${result.status}`).trim()}`);
  let output: unknown;
  try { output = JSON.parse(result.stdout); } catch { throw new Error('native thermal proof returned invalid JSON'); }
  if (!isDict(output)) throw new Error('native thermal proof returned a non-object');
  return output;
}

export function thermalServices(execute: Execute = localThermalProof): ThermalServices {
  return {
    validateCapability: (capability, source, base, options) => execute('validate-capability', {
      capability, source, base, selected_nets: options.selectedNets,
    }),
    discharge: (capability, candidate, receipts) => execute('discharge', {
      capability, candidate, fill_receipt: receipts.fillReceipt, drc_receipt: receipts.drcReceipt,
    }),
  };
}
