/** Partial reviewed-source preflight over a caller-staged snapshot. It never
 * authorizes placement or writing and never modifies the snapshot. */
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readPopulation} from '../lib/kicad-population.mjs';
import {compareNativeManifest, reconstructSnapshot} from '../lib/reviewed-population.ts';

function inside(root: string, file: string): string {
  const path = realpathSync(file);
  const rel = relative(root,path);
  if (!rel || rel === '..' || rel.startsWith('..'+sep) || isAbsolute(rel)) throw new Error('file outside staged snapshot');
  return path;
}
/** Rust's status 3 means partial checks passed; it is never an approval. */
export function preflightSnapshot(snapshotArg: string, project: string, modelArg: string, rustBin: string,
  inspector?: {path:string; sha256:string}): number {
  const snapshot = realpathSync(snapshotArg);
  const modelPath = inside(snapshot,modelArg);
  const model = JSON.parse(readFileSync(modelPath,'utf8'));
  const contract = model.engineering;
  if (!contract || typeof contract.root !== 'string' || !isAbsolute(contract.root) || resolve(contract.root) !== contract.root ||
      !contract.inputs || typeof contract.inputs !== 'object' || Array.isArray(contract.inputs)) throw new Error('invalid reviewed source identity');
  const manifestName = contract.manifest;
  if (typeof manifestName !== 'string') throw new Error('manifest identity missing');
  const manifestRelative = isAbsolute(manifestName) ? relative(contract.root,manifestName) : manifestName;
  if (!manifestRelative || manifestRelative.split(/[\\/]/).some((part:string)=>!part || part === '.' || part === '..') ||
      manifestRelative === '..' || manifestRelative.startsWith('..'+sep) || isAbsolute(manifestRelative)) throw new Error('manifest outside original root');
  const manifest = JSON.parse(readFileSync(inside(snapshot,resolve(snapshot,manifestRelative)),'utf8'));
  const observed = readPopulation(snapshot,project);
  const expected: Record<string,string> = {};
  for (const key of Object.keys(observed.sources)) {
    const names = [key,join(contract.root,key)].filter(name=>Object.hasOwn(contract.inputs,name));
    if (names.length !== 1 || typeof contract.inputs[names[0]] !== 'string') throw new Error('missing or ambiguous snapshot source identity');
    expected[key] = contract.inputs[names[0]];
  }
  const native = reconstructSnapshot(snapshot,project,expected);
  compareNativeManifest(manifest,native);
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return '{' + Object.keys(object).sort().map(k=>JSON.stringify(k)+':'+canonical(object[k])).join(',') + '}';
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('unsupported canonical value');
    return encoded;
  }
  if (canonical(contract.geometry) !== canonical(native.geometry)) throw new Error('reviewed geometry differs from native snapshot');
  const scratch = mkdtempSync(join(tmpdir(),'iotplace-reviewed-preflight-'));
  try {
    const nativeFile=join(scratch,'population.json');
    writeFileSync(nativeFile,JSON.stringify(native));
    const args=['review-preflight',modelPath,'--snapshot-root',snapshot,'--native-population',nativeFile];
    if (inspector) args.push('--pdfinfo',inspector.path,'--pdfinfo-sha256',inspector.sha256);
    const run=spawnSync(rustBin,args,{stdio:'inherit'});
    if (run.error) throw run.error;
    if (run.status !== 3) throw new Error('native preflight rejected or did not report incomplete verification');
    return 3;
  } finally {rmSync(scratch,{recursive:true,force:true});}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [snapshot,project,model,bin,pdfinfo,pdfinfoHash] = process.argv.slice(2);
  try {
    if (!snapshot || !project || !model || !bin) throw new Error('usage: reviewed-preflight SNAPSHOT PROJECT MODEL IOTPLACE');
    if (!!pdfinfo !== !!pdfinfoHash) throw new Error('PDF inspector path and hash must be supplied together');
    process.exitCode=preflightSnapshot(snapshot,project,model,bin,pdfinfo ? {path:pdfinfo,sha256:pdfinfoHash} : undefined);
  } catch (error) {console.error(`reviewed preflight: ${error instanceof Error ? error.message : String(error)}`); process.exitCode=1;}
}
