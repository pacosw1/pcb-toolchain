// Pack original fabrication bytes deterministically; never replace an archive.
//   tools/pack-fab.ts DIRECTORY DESTINATION.zip
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMain } from './lib/cli.ts';
import { zipArchive } from './lib/zip-write.ts';

/** Paths under `directory`, as lists of folder names, of every file. A symbolic link anywhere is refused. */
function filesUnder(directory: string, parents: string[] = []): string[][] {
  return readdirSync(join(directory, ...parents)).flatMap(name => {
    const parts = [...parents, name];
    const entry = lstatSync(join(directory, ...parts));
    if (entry.isSymbolicLink()) throw new Error('fabrication input is empty or contains symbolic links');
    if (entry.isDirectory()) return filesUnder(directory, parts);
    return entry.isFile() ? [parts] : [];
  });
}

/** Folder by folder, as Python sorts Path objects: "a/b" comes before "a-b". */
function byPathParts(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

export function pack(directory: string, destination: string): void {
  const files = filesUnder(directory).sort(byPathParts);
  if (!files.length) throw new Error('fabrication input is empty or contains symbolic links');
  const entries = files.map(parts => ({ name: parts.join('/'), data: readFileSync(join(directory, ...parts)) }));
  writeFileSync(destination, zipArchive(entries), { flag: 'wx' });
}

function main([directory, destination]: string[]): number {
  try {
    if (directory === undefined || destination === undefined) throw new Error('usage: tools/pack-fab.ts DIRECTORY DESTINATION.zip');
    pack(directory, destination);
    console.log('PASS: deterministic fabrication ZIP; original bytes preserved');
    return 0;
  } catch (error) {
    console.error(`FAIL: fabrication packaging: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

runMain(import.meta.url, main);
