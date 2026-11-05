import test from 'node:test';
import assert from 'node:assert/strict';
import { localThermalProof, thermalServices } from './outcome-thermal.ts';

test('thermal services forward exact capability and receipt paths', () => {
  const calls: unknown[] = [];
  const thermal = thermalServices((operation, request) => { calls.push({ operation, request }); return { status: 'checked' }; });
  const capability = { source: 'sealed' };
  assert.deepEqual(thermal.validateCapability(capability, '/source', '/base', { selectedNets: ['GND'] }), { status: 'checked' });
  assert.deepEqual(thermal.discharge(capability, '/candidate', { fillReceipt: '/fill.json', drcReceipt: '/drc.json' }), { status: 'checked' });
  assert.deepEqual(calls, [
    { operation: 'validate-capability', request: { capability, source: '/source', base: '/base', selected_nets: ['GND'] } },
    { operation: 'discharge', request: { capability, candidate: '/candidate', fill_receipt: '/fill.json', drc_receipt: '/drc.json' } },
  ]);
});

test('native thermal proof fails closed when the validator cannot run', () => {
  const previous = process.env.ROUTE_COVERAGE_BIN;
  process.env.ROUTE_COVERAGE_BIN = '/nonexistent/route-coverage';
  try { assert.throws(() => localThermalProof('discharge', {}), /pinned Linux job runtime|native thermal proof failed/); }
  finally { if (previous === undefined) delete process.env.ROUTE_COVERAGE_BIN; else process.env.ROUTE_COVERAGE_BIN = previous; }
});
