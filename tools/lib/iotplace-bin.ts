// Finds the native placer search: $IOTPLACE_BIN, bin/iotplace-<target> of the toolchain, else the build in this checkout
// (the host only). A search never falls back to Python on its own.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFile } from './py-path.ts';

const BUILD = fileURLToPath(new URL('../placer/core/target/release/iotplace', import.meta.url));

export const hostTarget = (): string => (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x86_64');

export function iotplaceBin(target: string = hostTarget(), env: NodeJS.ProcessEnv = process.env): string {
  const host = target === hostTarget();
  const paths = [host ? env.IOTPLACE_BIN : undefined, join(env.PCB_TOOLCHAIN_ROOT ?? '', 'bin', `iotplace-${target}`), host ? BUILD : undefined];
  const found = paths.find(path => path && isFile(path));
  if (found === undefined) throw new Error(`no iotplace for ${target}: cargo build --release in tools/placer/core, or set PCB_TOOLCHAIN_ROOT`);
  return found;
}
