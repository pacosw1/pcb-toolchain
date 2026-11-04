import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourcesSha } from '../lib/iotroute-bin.ts';
import type { CheckInput, Report } from './types.ts';

const CORE = fileURLToPath(new URL('../router/core', import.meta.url));

/** Build this helper alone with two workers; the same source fingerprint reuses it. GNC_NATIVE selects an installed binary. */
export function nativeBinary(): string {
  if (process.env.GNC_NATIVE) return process.env.GNC_NATIVE;
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(CORE, 'target');
  const binary = join(target, 'debug', 'gerber_netcheck');
  const stamp = `${binary}.sha256`;
  const sha = sourcesSha(CORE);
  if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === sha) return binary;
  const build = spawnSync('cargo', ['build', '--locked', '--manifest-path', join(CORE, 'Cargo.toml'), '-j', '2', '--bin', 'gerber_netcheck'],
    { encoding: 'utf8', env: process.env });
  if (build.error || build.status !== 0) throw new Error(`Gerber geometry build failed: ${build.error?.message ?? build.stderr}`);
  if (sourcesSha(CORE) !== sha) throw new Error('Gerber geometry sources changed during the build');
  writeFileSync(stamp, `${sha}\n`);
  return binary;
}

export function checkConnectivity(input: CheckInput, binary = nativeBinary()): Report {
  const run = spawnSync(binary, [], { input: JSON.stringify(input), encoding: 'utf8' });
  if (run.error || (run.status !== 0 && run.status !== 1)) throw new Error(`Gerber geometry failed: ${run.error?.message ?? run.stderr}`);
  const report = JSON.parse(run.stdout) as Report;
  const passed = !Object.keys(report.opens).length && !report.shorts.length && !report.missing.length;
  if (passed !== (run.status === 0)) throw new Error('Gerber geometry returned an inconsistent report');
  return report;
}
