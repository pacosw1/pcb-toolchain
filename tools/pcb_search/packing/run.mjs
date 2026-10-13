// Proposal process only. The Python owner supplies the deadline and validates
// complete unit identity, coordinates and original placement constraints.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pack } from 'calculate-packing';

const require = createRequire(import.meta.url);
const pkg = require('calculate-packing/package.json');
if (pkg.version !== '0.0.90') throw new Error('unexpected packing version');
const request = JSON.parse(readFileSync(0, 'utf8'));
const result = pack(request.input);
process.stdout.write(JSON.stringify({
  schema: 'iot-lab.packing-response.v1',
  input_sha256: request.input_sha256,
  backend: {
    name: 'calculate-packing', version: pkg.version, node: process.version,
    entry_sha256: createHash('sha256').update(readFileSync(require.resolve('calculate-packing'))).digest('hex'),
  },
  components: result.components.map(c => ({
    id: c.componentId, x: c.center.x, y: c.center.y,
    rotation: c.ccwRotationDegrees ?? c.ccwRotationOffset,
  })),
}));
