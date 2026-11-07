// Test helper: a stand-in for kicad-cli. It writes a small SVG to the file that follows its -o flag. No KiCad, no Docker.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = `#!/bin/sh
while [ $# -gt 0 ]; do if [ "$1" = -o ]; then out=$2; fi; shift; done
printf '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10"/></svg>\\n' > "$out"
`;

/** The environment that points board-images.ts at the stand-in in `folder`. */
export function fakeRenderer(folder: string): NodeJS.ProcessEnv {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'kicad-cli'), SCRIPT);
  chmodSync(join(folder, 'kicad-cli'), 0o755);
  return { KICAD_CLI: join(folder, 'kicad-cli') };
}
