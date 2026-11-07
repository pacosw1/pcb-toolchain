import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { candidateFields } from './pcb-candidate-admission.ts';

const SETTINGS = ['ROUTE_FEATURES', 'ROUTE_FEATURES_FILE', 'ROUTE_BOARD'];

function scratch(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'candidate-admission-'));
  const saved = SETTINGS.map(name => [name, process.env[name]] as const);
  for (const name of SETTINGS) delete process.env[name];
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  return root;
}

test('a candidate run refuses the route settings of the environment, because no run record keeps them', t => {
  const root = scratch(t);
  assert.deepEqual(candidateFields(root, 'build', 'X', {}), {}, 'no setting, no problem');
  for (const name of SETTINGS) {
    process.env[name] = 'x';
    for (const operation of ['build', 'route', 'repair']) {
      assert.throws(() => candidateFields(root, operation, 'X', { router: 'iotroute' }), new RegExp(`${name}.*no run record keeps them.*route_features`), `${operation} ${name}`);
    }
    process.env[name] = '';
    assert.doesNotThrow(() => candidateFields(root, 'build', 'X', {}), `an empty ${name} is unset`);
    delete process.env[name];
  }
  process.env.ROUTE_FEATURES = 'via_halo=0'; process.env.ROUTE_BOARD = 'X';
  assert.throws(() => candidateFields(root, 'build', 'X', {}), /ROUTE_FEATURES, ROUTE_BOARD are set/, 'every setting is named');
  assert.doesNotThrow(() => candidateFields(root, 'release', 'X', {}), 'a release is no candidate run');
});
