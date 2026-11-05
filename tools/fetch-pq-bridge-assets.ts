// Capture supplier CAD through the connected EasyEDA Pro bridge, then convert locally.
//
// Read-only in EasyEDA: metadata, public source fetches and model downloads only. Never creates an EasyEDA project or
// library. Existing captures are reused.
//
//   tools/fetch-pq-bridge-assets.ts C432212 C2671345 ...
//
// easyeda2kicad is third-party Python. It takes the CAD source only from its own API, so the conversion is a short
// program that hands it the source captured here. That program is the only Python this tool runs.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMain, UsageError } from './lib/cli.ts';
import { readJson, sha256File } from './lib/json-file.ts';
import { projectRoot } from './lib/project-root.mjs';
import { jsonDumps, pyRepr, pyStr, utcNow } from './lib/py-compat.mjs';

const USAGE = 'usage: tools/fetch-pq-bridge-assets.ts C432212 C2671345 ...';
const BRIDGE_URL = 'http://127.0.0.1:49620/execute';
const BRIDGE_TIMEOUT_MS = 55_000;
const MODEL_HOST = 'https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y';
const STEP_MAGIC = 'ISO-10303-21;';
const DEFAULT_CONVERTER = '/Library/Developer/CommandLineTools/usr/bin/python3';
const FETCH_AS_BASE64 = 'const a=new Uint8Array(await r.arrayBuffer());let s="";'
  + 'for(let i=0;i<a.length;i+=32768)s+=String.fromCharCode.apply(null,a.subarray(i,i+32768));'
  + 'return {status:r.status,b64:btoa(s)};';

type Json = Record<string, unknown>;

/** Runs JavaScript in the bridge and gives its result. */
export type Bridge = (code: string) => Promise<unknown>;

export interface Capture { assets: string; bridge: Bridge; converter: string }

interface Device {
  uuid?: string;
  supplierId?: string;
  symbolUuid?: string;
  footprintUuid?: string;
  manufacturerId?: unknown;
  otherProperty?: Json;
}
interface Supplier { number?: unknown; id?: unknown }
interface CadSource {
  title?: unknown;
  uuid?: string;
  lcsc?: Supplier;
  szlcsc?: Supplier;
  dataStr?: { head?: { c_para?: Json } };
  packageDetail?: { title?: string; uuid?: string; dataStr?: { shape?: string[] } };
}
interface ModelRecord { file: string; source_url: string; sha256: string; transform: unknown }

const sourceUrl = (code: string) => `https://easyeda.com/api/products/${code}/components?version=6.4.19.5`;
const supplierOf = (source: CadSource): Supplier => source.lcsc || source.szlcsc || {};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const bridgeOverHttp: Bridge = async code => {
  const response = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonDumps({ code }),
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`bridge HTTP ${response.status}`);
  const reply = await response.json() as { success?: boolean; error?: string; result?: unknown };
  if (!reply.success) throw new Error(reply.error ?? 'bridge failure');
  return reply.result ?? null;
};

async function fetchBytes(bridge: Bridge, url: string): Promise<Buffer> {
  const { status, b64 } = await bridge(`const r=await fetch(${JSON.stringify(url)});${FETCH_AS_BASE64}`) as { status: number; b64: string };
  if (status !== 200) throw new Error(`HTTP ${status}: ${url}`);
  return Buffer.from(b64, 'base64');
}

/** No logged-in EasyEDA Pro editor (the eda API): the same JLC/LCSC record from the public source, and the file says so. */
async function publicDevice(code: string, bridge: Bridge, cause: string): Promise<Device & Json> {
  const raw = await fetchBytes(bridge, sourceUrl(code));
  const { result } = JSON.parse(raw.toString('utf8')) as { result: CadSource };
  const parameters = result.dataStr?.head?.c_para ?? {};
  const supplier = supplierOf(result);
  if (pyStr(supplier.number ?? '') !== code) throw new Error(`${code}: public source is for ${pyStr(supplier.number ?? null)}`);
  return {
    uuid: result.uuid ?? '',
    symbolUuid: result.uuid ?? '',
    supplier: 'LCSC',
    supplierId: code,
    manufacturerId: result.title ?? null,
    manufacturer: parameters.Manufacturer ?? '',
    footprintName: result.packageDetail?.title ?? '',
    footprintUuid: result.packageDetail?.uuid ?? '',
    otherProperty: parameters,
    source: `public EasyEDA component API (no editor eda.lib_Device); ${cause.slice(0, 80)}`,
  };
}

async function deviceRecord(folder: string, code: string, bridge: Bridge): Promise<Device> {
  const path = join(folder, 'bridge-device.json');
  if (existsSync(path)) return readJson<Device>(path);
  let device: Device;
  try {
    const devices = await bridge(`return await eda.lib_Device.getByLcscIds([${JSON.stringify(code)}]);`) as Device[];
    const match = devices.find(candidate => candidate.supplierId === code);
    if (!match) throw new Error('');
    device = match;
  } catch (error) {
    device = await publicDevice(code, bridge, errorText(error));
  }
  writeFileSync(path, `${JSON.stringify(device, null, 2)}\n`);
  return device;
}

async function cadSource(folder: string, code: string, bridge: Bridge): Promise<CadSource> {
  const path = join(folder, 'easyeda-bridge-source.json');
  if (!existsSync(path)) {
    const raw = await fetchBytes(bridge, sourceUrl(code));
    const data = JSON.parse(raw.toString('utf8')) as { success?: boolean; result?: unknown };
    if (!data.success || !data.result) throw new Error(`${code}: source has no CAD result`);
    writeFileSync(path, raw);
  }
  return readJson<{ result: CadSource }>(path).result;
}

/** Exact supplier identity stays mandatory; aliases must be reviewed by hand. */
function checkIdentity(source: CadSource, device: Device, code: string): void {
  if ((source.title ?? null) === (device.manufacturerId ?? null)) return;
  const supplier = supplierOf(source);
  if (pyStr(supplier.number ?? supplier.id ?? '') !== code) {
    throw new Error(`${code}: title/identity mismatch: ${pyStr(source.title ?? null)} vs ${pyStr(device.manufacturerId ?? null)}`);
  }
}

function convert(source: string, code: string, output: string, converter: string): void {
  const program = 'import json\nfrom easyeda2kicad.easyeda.easyeda_api import EasyedaApi\n'
    + 'from easyeda2kicad.__main__ import main\n'
    + `source=json.load(open(${pyRepr(source)}))["result"]\n`
    + 'EasyedaApi.get_cad_data_of_component=lambda self,lcsc_id: source\n'
    + `raise SystemExit(main(${pyRepr(['--lcsc_id', code, '--symbol', '--footprint', '--output', output])}))\n`;
  const run = spawnSync(converter, ['-c', program], { encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(run.stderr.slice(-1500));
}

/** The attrs of the first 3D outline of the footprint, if it has one. */
function outline3d(source: CadSource): { title: string; uuid: string } | undefined {
  for (const shape of source.packageDetail?.dataStr?.shape ?? []) {
    if (!shape.startsWith('SVGNODE~')) continue;
    const node = JSON.parse(shape.slice('SVGNODE~'.length)) as { attrs?: { c_etype?: string; title: string; uuid: string } };
    if (node.attrs?.c_etype === 'outline3D') return node.attrs;
  }
  return undefined;
}

async function captureModel(folder: string, code: string, source: CadSource, device: Device, bridge: Bridge) {
  const outline = outline3d(source);
  if (!outline) return { model: null, modelError: null };
  const { title, uuid } = outline;
  if (title.includes('/') || title.includes('\\') || title.includes('..')) throw new Error('Unsafe model title');
  const file = `${code}.3dshapes/${title}.step`;
  const path = join(folder, file);
  const url = `${MODEL_HOST}/${uuid}`;
  if (!existsSync(path)) {
    try {
      const raw = await fetchBytes(bridge, url);
      if (!raw.subarray(0, STEP_MAGIC.length).equals(Buffer.from(STEP_MAGIC))) throw new Error('Model response is not STEP');
      mkdirSync(join(folder, `${code}.3dshapes`), { recursive: true });
      writeFileSync(path, raw);
    } catch (error) {
      return { model: null, modelError: errorText(error) };
    }
  }
  const transform = device.otherProperty?.['3D Model Transform'] ?? null;
  const model: ModelRecord = { file, source_url: url, sha256: sha256File(path), transform };
  return { model, modelError: null };
}

function footprintRecords(folder: string, code: string) {
  const pretty = `${code}.pretty`;
  if (!existsSync(join(folder, pretty))) return [];
  return readdirSync(join(folder, pretty)).filter(name => name.endsWith('.kicad_mod')).sort()
    .map(name => ({ file: `${pretty}/${name}`, sha256: sha256File(join(folder, pretty, name)) }));
}

export async function capture(code: string, { assets, bridge, converter }: Capture) {
  if (!/^C\d+$/.test(code)) throw new Error('Expected exact LCSC C-number');
  const folder = join(assets, code);
  mkdirSync(folder, { recursive: true });
  const device = await deviceRecord(folder, code, bridge);
  const source = await cadSource(folder, code, bridge);
  checkIdentity(source, device, code);
  const sourcePath = join(folder, 'easyeda-bridge-source.json');
  const symbol = `${code}.kicad_sym`;
  if (!existsSync(join(folder, symbol))) convert(sourcePath, code, join(folder, symbol), converter);
  const { model, modelError } = await captureModel(folder, code, source, device, bridge);
  if (device.uuid === undefined) throw new Error(`${code}: device record has no uuid`);
  const footprints = footprintRecords(folder, code);
  const manifest = {
    lcsc: code,
    mpn: device.manufacturerId ?? null,
    state: 'bridge-captured-candidate',
    captured_at_utc: utcNow(),
    source_url: sourceUrl(code),
    source_sha256: sha256File(sourcePath),
    pro_device_uuid: device.uuid,
    pro_symbol_uuid: device.symbolUuid || (device.otherProperty?.Symbol ?? null),
    pro_footprint_uuid: device.footprintUuid ?? null,
    conversion: 'easyeda2kicad 0.8.0, offline source injection; no hand-drawn pin map',
    symbol: { file: symbol, sha256: sha256File(join(folder, symbol)) },
    footprints,
    model,
    model_error: modelError,
    review: 'Pinout, ratings, land geometry, paste, and placement orientation require verification.',
  };
  writeFileSync(join(folder, 'PQ-BRIDGE-MANIFEST.json'), `${jsonDumps(manifest, 2)}\n`);
  return { lcsc: code, mpn: manifest.mpn, symbol, footprints: footprints.length, step: Boolean(model) };
}

async function main(codes: string[]): Promise<number> {
  if (!codes.length) throw new UsageError(USAGE);
  const assets = join(projectRoot(), 'hardware-design/registry/cad-assets');
  const converter = process.env.EASYEDA_CONVERTER_PY ?? DEFAULT_CONVERTER;
  for (const code of codes) {
    try {
      console.log(jsonDumps(await capture(code, { assets, bridge: bridgeOverHttp, converter })));
    } catch (error) {
      console.log(jsonDumps({ lcsc: code, error: errorText(error) }));
      throw error;
    }
  }
  return 0;
}

runMain(import.meta.url, main);
