#!/usr/bin/env node
// Capture JLC/EasyEDA CAD for C-numbers with easyeda2kicad (fallback when the EasyEDA Pro bridge of
// tools/fetch-pq-bridge-assets.py is not running). Same output layout as the bridge captures:
//
//   registry/cad-assets/<C>/<C>.kicad_sym, <C>.pretty/*.kicad_mod, <C>.3dshapes/*, PQ-BRIDGE-MANIFEST.json
//   blocks/iot-lab.pretty/<C>.kicad_mod -> symlink to the captured footprint
//
// Read only on the EasyEDA side (public component API through easyeda2kicad). Existing captures are kept.
// Usage: node tools/fetch-e2k-assets.mjs C142526 C84681 ...
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, relative} from 'node:path';
import {PyError, SystemExit, cli, jsonDumps, osError, print, processText, readText, run, sorted, tail, utcNow} from './lib/py-compat.mjs';
import {projectRoot} from './lib/project-root.mjs';

const ROOT = projectRoot();
const ASSETS = join(ROOT, 'hardware-design/registry/cad-assets');
const PRETTY = join(ROOT, 'hardware-design/blocks/iot-lab.pretty');
const E2K = process.env.EASYEDA2KICAD ?? join(homedir(), '.local/bin/easyeda2kicad');

function sha(path) {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch (error) { throw osError(error, path); }
}
// Path.glob: hidden names included, a missing folder is empty.
function names(folder) {
  try { return sorted(readdirSync(folder)); } catch { return []; }
}
function group1(pattern, text) {
  const match = pattern.exec(text);
  if (!match) throw new PyError('AttributeError', "'NoneType' object has no attribute 'group'");
  return match[1];
}

function capture(code) {
  if (!/^C\p{Nd}+$/u.test(code)) throw new SystemExit(1, `${code}: not an LCSC C-number`);
  const folder = join(ASSETS, code), sym = join(folder, `${code}.kicad_sym`);
  if (existsSync(sym)) print(`${code}: kept (already captured)`);
  else {
    try { mkdirSync(folder, {recursive: true}); } catch (error) { throw osError(error, folder); }
    const p = run(E2K, ['--full', `--lcsc_id=${code}`, '--output', join(folder, code)]);
    if (p.status !== 0 || !existsSync(sym)) throw new SystemExit(1, `${code}: easyeda2kicad failed: ${tail(processText(p.stdout) + processText(p.stderr), 400)}`);
  }
  const prettyDir = join(folder, `${code}.pretty`), fps = names(prettyDir).filter(name => name.endsWith('.kicad_mod'));
  if (fps.length !== 1) throw new SystemExit(1, `${code}: expected one footprint, found ${fps.length}`);
  const text = readText(sym), name = group1(/\(symbol "([^"]+)"/, text), mpn = /\(property "Value" "([^"]*)"/.exec(text);
  const footprint = join(prettyDir, fps[0]), models = join(folder, `${code}.3dshapes`);
  const manifest = new Map([
    ['lcsc', code], ['mpn', mpn ? mpn[1] : name], ['state', 'e2k-captured-candidate'],
    ['captured_at_utc', utcNow()],
    ['conversion', 'easyeda2kicad (uv tool, --full); no hand-drawn pin map'],
    ['symbol', new Map([['file', `${code}.kicad_sym`], ['sha256', sha(sym)]])],
    ['footprints', [new Map([['file', `${code}.pretty/${fps[0]}`], ['sha256', sha(footprint)]])]],
    ['models', names(models).map(model => `${code}.3dshapes/${model}`)],
    ['review', 'Pinout, ratings, land geometry, paste and orientation require verification against the datasheet.'],
  ]);
  const manifestPath = join(folder, 'PQ-BRIDGE-MANIFEST.json');
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, jsonDumps(manifest, 2) + '\n');
  const link = join(PRETTY, `${code}.kicad_mod`);
  if (!existsSync(link)) {
    try { symlinkSync(relative(PRETTY, footprint), link); } catch (error) { throw osError(error); }
  }
  print(`${code}: ${manifest.get('mpn')} symbol "${name}" footprint ${fps[0]}`);
}

cli(() => { for (const code of process.argv.slice(2)) capture(code); });
