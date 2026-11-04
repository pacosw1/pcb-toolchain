#!/usr/bin/env node
// Builds hardware-design/registry/cad-assets/<LCSC>/MANIFEST.json for every
// C-number used by the POE-ETHERNET candidate BOM. Sources the KiCad symbol,
// footprint and 3D model from the assets the board already uses: the
// project AUTO.kicad_sym / POE.pretty / POE.3dshapes, or the KiCad stock
// symbol/footprint/3D-model libraries under KiCad.app. It copies, it never
// downloads. Re-run it any time the board's parts change.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('..', import.meta.url).pathname;
const rel = (p) => `${root}${p}`;
const boardDir = rel('hardware-design/boards/POE-ETHERNET/cad/POE-ETHERNET/');
const registryDir = rel('hardware-design/registry/cad-assets/');
const KICAD_APP = '/Applications/KiCad/KiCad.app/Contents/SharedSupport';
const KIPRJMOD = boardDir.replace(/\/$/, '');
const KICAD10_3DMODEL_DIR = `${KICAD_APP}/3dmodels`;
const KICAD10_FOOTPRINT_DIR = `${KICAD_APP}/footprints`;
const KICAD10_SYMBOL_DIR = `${KICAD_APP}/symbols`;

const exists = async (p) => stat(p).then(() => true).catch(() => false);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const resolveVars = (p) => p
  .replace('${KIPRJMOD}', KIPRJMOD)
  .replace('${KICAD10_3DMODEL_DIR}', KICAD10_3DMODEL_DIR);

const sch = await readFile(`${boardDir}POE-ETHERNET.kicad_sch`, 'utf8');
const pcb = await readFile(`${boardDir}POE-ETHERNET.kicad_pcb`, 'utf8');
const autoSym = await readFile(`${boardDir}AUTO.kicad_sym`, 'utf8');
const candidateBom = await readFile(rel('hardware-design/boards/POE-ETHERNET/CANDIDATE-BOM.csv'), 'utf8');

const registryLcsc = [...new Set(
  [...candidateBom.matchAll(/evidence\/\d{4}-\d{2}-\d{2}\/(C\d+)\.(?:json|html)/g)].map((m) => m[1]),
)];

// One entry per schematic symbol instance that is in the BOM: reference,
// lib_id, LCSC C-number and the Footprint property (LIBNAME:FPNAME).
const schBlocks = sch.split(/\n\t\(symbol\n/).slice(1);
const instances = schBlocks
  .filter((b) => /\(in_bom yes\)/.test(b))
  .map((b) => ({
    ref: b.match(/\(property "Reference" "([^"]+)"/)?.[1],
    libId: b.match(/lib_id "([^"]+)"/)?.[1],
    lcsc: b.match(/\(property "LCSC" "([^"]+)"/)?.[1],
    footprint: b.match(/\(property "Footprint" "([^"]*)"/)?.[1],
  }))
  .filter((i) => i.lcsc);

// Group by LCSC C-number. Every LCSC must map to exactly one lib_id and one
// footprint; otherwise stop (CLAUDE.md: do not substitute silently).
const byLcsc = new Map();
for (const inst of instances) {
  if (!byLcsc.has(inst.lcsc)) byLcsc.set(inst.lcsc, []);
  byLcsc.get(inst.lcsc).push(inst);
}
for (const [lcsc, list] of byLcsc) {
  const libIds = new Set(list.map((i) => i.libId));
  const footprints = new Set(list.map((i) => i.footprint));
  if (libIds.size > 1) throw new Error(`${lcsc}: multiple symbols used (${[...libIds].join(', ')})`);
  if (footprints.size > 1) throw new Error(`${lcsc}: multiple footprints used (${[...footprints].join(', ')})`);
}

// Extract one top-level (symbol "NAME" ...) block from AUTO.kicad_sym by
// brace-balancing, so nested sub-symbols (NAME_0_1, NAME_1_1, ...) come along.
function extractSymbolBlock(libText, name) {
  const marker = `\t(symbol "${name}"`;
  const start = libText.indexOf(marker);
  if (start === -1) throw new Error(`symbol "${name}" not found in AUTO.kicad_sym`);
  let depth = 0;
  let end = -1;
  for (let i = start; i < libText.length; i++) {
    if (libText[i] === '(') depth++;
    else if (libText[i] === ')') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`unbalanced parens for symbol "${name}"`);
  return libText.slice(start + 1, end); // drop the leading tab
}

// footprint LIBNAME:FPNAME -> absolute source .kicad_mod path.
function footprintSourcePath(footprint) {
  const [lib, name] = footprint.split(':');
  if (lib === 'POE') return `${boardDir}POE.pretty/${name}.kicad_mod`;
  return `${KICAD10_FOOTPRINT_DIR}/${lib}.pretty/${name}.kicad_mod`;
}

// Read the PCB footprint instance for `ref` and return its model path
// (resolved) plus offset/scale/rotate, straight off the board (the PCB
// instance model wins over the footprint library default, per instructions).
function pcbModelFor(ref) {
  const blocks = pcb.split('(footprint "').slice(1);
  for (const b of blocks) {
    const r = b.match(/\(property "Reference" "([^"]+)"/)?.[1];
    if (r !== ref) continue;
    const m = b.match(/\(model "([^"]+)"\s*\(offset\s*\(xyz\s+([^)]+)\)\s*\)\s*\(scale\s*\(xyz\s+([^)]+)\)\s*\)\s*\(rotate\s*\(xyz\s+([^)]+)\)\s*\)/s);
    if (!m) throw new Error(`${ref}: no 3D model found on the PCB footprint instance`);
    return { rawPath: m[1], offset: m[2].trim(), scale: m[3].trim(), rotate: m[4].trim() };
  }
  throw new Error(`${ref}: not found on the PCB`);
}

const results = [];
for (const lcsc of registryLcsc) {
  const list = byLcsc.get(lcsc);
  if (!list) throw new Error(`${lcsc}: no schematic instance with this LCSC C-number`);
  const { libId, footprint } = list[0];
  const references = [...new Set(list.map((i) => i.ref))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const symbolName = libId.split(':').at(-1);

  const dir = `${registryDir}${lcsc}/`;
  await mkdir(dir, { recursive: true });

  // --- symbol ---
  const symbolBlock = extractSymbolBlock(autoSym, symbolName);
  const symbolFileName = `${symbolName}.kicad_sym`;
  const symbolLibText = `(kicad_symbol_lib (version 20241209) (generator poe-generator)\n\t${symbolBlock}\n)\n`;
  await writeFile(`${dir}${symbolFileName}`, symbolLibText);
  const symbolHash = sha256(await readFile(`${dir}${symbolFileName}`));

  // --- footprint ---
  const fpSourcePath = footprintSourcePath(footprint);
  const fpBuf = await readFile(fpSourcePath);
  const fpFileName = `${footprint.split(':').at(-1)}.kicad_mod`;
  await writeFile(`${dir}${fpFileName}`, fpBuf);
  const fpHash = sha256(fpBuf);

  // --- 3D model ---
  const modelInfo = pcbModelFor(list[0].ref);
  const modelSourcePath = resolveVars(modelInfo.rawPath);
  if (!(await exists(modelSourcePath))) throw new Error(`${lcsc}: 3D model not found at ${modelSourcePath}`);
  const modelBuf = await readFile(modelSourcePath);
  const modelFileName = modelSourcePath.split('/').at(-1);
  await writeFile(`${dir}${modelFileName}`, modelBuf);
  const modelHash = sha256(modelBuf);
  const isStockModel = modelInfo.rawPath.startsWith('${KICAD10_3DMODEL_DIR}');

  const manifest = {
    lcsc,
    references,
    lib_id: libId,
    footprint_lib_id: footprint,
    symbol: { file: symbolFileName, sha256: symbolHash, source: `AUTO.kicad_sym#${symbolName}` },
    footprint: { file: fpFileName, sha256: fpHash, source: fpSourcePath },
    model: {
      file: modelFileName,
      sha256: modelHash,
      source: modelSourcePath,
      is_generic_stock_model: isStockModel,
      offset: modelInfo.offset,
      scale: modelInfo.scale,
      rotate: modelInfo.rotate,
    },
    created_utc: new Date().toISOString(),
  };
  await writeFile(`${dir}MANIFEST.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  results.push(manifest);
}

console.log(`Built ${results.length} CAD asset manifests under ${registryDir}`);
for (const m of results) {
  console.log(`  ${m.lcsc} (${m.references.join(',')}): symbol=${m.symbol.file} footprint=${m.footprint.file} model=${m.model.file}${m.model.is_generic_stock_model ? ' [generic stock model]' : ''}`);
}
