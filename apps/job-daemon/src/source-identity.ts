import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Hash the source loaded at startup. The release packager uses the same v1 encoding. */
export function sourceIdentity(directory: string): string {
  const names = fs.readdirSync(directory).sort();
  const hash = createHash('sha256');
  hash.update('pcb-job-daemon-source-v1\0');
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !fs.lstatSync(path.join(directory, name)).isFile()) {
      throw new Error(`unsupported daemon source entry: ${name}`);
    }
    const data = fs.readFileSync(path.join(directory, name));
    hash.update(`${name}\0${data.length}\0`); hash.update(data);
  }
  return hash.digest('hex');
}
