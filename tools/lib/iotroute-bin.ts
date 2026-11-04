// Finds the iotroute binary: IOTROUTE_BIN, else the per-source-sha cache and cargo build of tools/router/run.py.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('../router/core', import.meta.url));

/** The files that define the binary, in the order of run.py core_sources: a folder's files, then its sorted folders. */
function sourcesBelow(folder: string): string[] {
  const entries = readdirSync(folder, { withFileTypes: true });
  const names = (wanted: boolean) => entries.filter(entry => entry.isDirectory() === wanted).map(entry => entry.name).sort();
  return [...names(false).map(name => join(folder, name)), ...names(true).flatMap(name => sourcesBelow(join(folder, name)))];
}

export function coreSources(core: string = CORE): string[] {
  const manifests = ['Cargo.toml', 'Cargo.lock'].map(name => join(core, name)).filter(path => existsSync(path));
  const source = join(core, 'src');
  const files = [...manifests, ...(existsSync(source) ? sourcesBelow(source) : [])];
  if (files.length === 0) throw new Error(`no router core sources in ${core}`);
  return files;
}

/** The sources_sha of run.py, so both find the same cache folder. */
export function sourcesSha(core: string = CORE): string {
  const hash = createHash('sha256');
  for (const file of coreSources(core)) {
    hash.update(relative(core, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

const cacheBase = (): string => process.env.IOTROUTE_CACHE ?? join(homedir(), 'Library/Caches/iot-lab/iotroute');

function build(core: string, folder: string, sha: string, exe: string, stamp: string): void {
  mkdirSync(folder, { recursive: true });
  const cargo = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(core, 'Cargo.toml')], {
    env: { ...process.env, CARGO_TARGET_DIR: folder }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cargo.error) throw new Error(`cargo build could not start: ${cargo.error.message}`);
  if (cargo.status !== 0 || !existsSync(exe)) throw new Error(`cargo build failed (exit ${cargo.status}):\n${cargo.stderr}`);
  if (sourcesSha(core) !== sha) throw new Error('router core sources changed during the build');
  writeFileSync(stamp, `${sha}\n`);
}

function explicitBin(path: string): string {
  try {
    if (statSync(path).isFile()) {
      accessSync(path, constants.X_OK);
      return path;
    }
  } catch {
    // reported below, with the variable that named the path
  }
  throw new Error(`IOTROUTE_BIN is not an executable file: ${path}`);
}

function cacheEntry(core: string) {
  const sha = sourcesSha(core);
  const folder = join(cacheBase(), sha);
  const exe = join(folder, 'release', 'iotroute');
  const stamp = join(folder, 'sources.sha256');
  const cached = existsSync(exe) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === sha;
  return { sha, folder, exe, stamp, cached };
}

/** The binary for the exact current sources. A cache miss builds it, which can take a minute. */
export function iotrouteBin(core: string = CORE): string {
  const explicit = process.env.IOTROUTE_BIN;
  if (explicit) return explicitBin(explicit);
  const { sha, folder, exe, stamp, cached } = cacheEntry(core);
  if (!cached) build(core, folder, sha, exe, stamp);
  return exe;
}

/**
 * For a test's `skip`: why this host cannot get the binary, else false. Only a host with no way to build one skips;
 * a wrong IOTROUTE_BIN or a failed build still fails the test. CI job tools-iotroute runs these tests with a real binary.
 */
export function iotrouteMissing(core: string = CORE): string | false {
  if (process.env.IOTROUTE_BIN || cacheEntry(core).cached) return false;
  return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).error ? 'needs iotroute: no IOTROUTE_BIN, no cached build, no cargo' : false;
}
