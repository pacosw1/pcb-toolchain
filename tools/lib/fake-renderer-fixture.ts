// Test helper: stand-ins for kicad-cli and rsvg-convert. Each one writes the file that follows its -o flag. No KiCad, no Docker.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/bin/sh
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done
printf 'fixture image' > "$out"
`;

/** The environment that points board-images.ts at the stand-ins in `folder`. */
export function fakeRenderer(folder: string): NodeJS.ProcessEnv {
  mkdirSync(folder, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, name] of [['KICAD_CLI', 'kicad-cli'], ['RSVG_CONVERT', 'rsvg-convert']] as const) {
    writeFileSync(join(folder, name), SCRIPT);
    chmodSync(join(folder, name), 0o755);
    env[key] = join(folder, name);
  }
  return env;
}
