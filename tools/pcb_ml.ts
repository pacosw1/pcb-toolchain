#!/usr/bin/env node
// Host-side advisory ML artifacts. Runs under the owned supervisor: tools/pcb ml.
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { errorText, runMain } from './lib/cli.ts';
import { projectRoot } from './lib/project-root.mjs';
import {
  buildDataset, codeInputs, loadFeaturePacket, makeFeaturePacket, manifestDependencies, walkFiles, type AdapterOptions,
} from './pcb_ml_adapters.ts';
import {
  artifactIdentity, checkClosure, encode, hasPath, ID, isFile, isObject, number, object, readObject, resolve,
  sha256File, text, validateBindings, writeArtifact, type Bindings, type Closure, type Obj,
} from './pcb_ml_json.ts';
import { evaluateModel, predictRows, sourcePaths, trainModel } from './pcb_ml_models.ts';

export const SCHEMA = 'iot-lab.pcb-ml-result.v1';
export const ACTIONS = ['dataset', 'features', 'train', 'evaluate', 'predict', 'engine-train', 'engine-evaluate', 'engine-export', 'engine-dataset', 'engine-public-corpus'] as const;
export type Action = typeof ACTIONS[number];
type SourceFlag = 'manifest' | 'dataset' | 'model' | 'features';
export interface Arguments {
  action: Action; id: string; root: string; output?: string; json: boolean;
  manifest?: string; dataset?: string; model?: string; features?: string; target?: string;
  algorithm?: 'mean' | 'ridge'; regularization?: number; epochs?: number; device?: 'auto' | 'cpu' | 'mps'; precision?: 'float16' | 'float32';
}
/** Interfaces to sibling engine ports, so orchestration does not duplicate their training or observation logic. */
export interface EnginePorts {
  dependencies(root: string, manifest: string): Closure | Promise<Closure>;
  buildDataset(root: string, manifest: string, datasetId: string): Obj | Promise<Obj>;
  ingestPublicCorpus(manifest: string, destination: string): Obj | Promise<Obj>;
  train(root: string, dataset: string, options: { modelId: string; target: string; epochs: number; device: string; output: string }): Obj | Promise<Obj>;
  evaluate(root: string, model: string, dataset: string, options: { output: string }): Obj | Promise<Obj>;
  exportCoreml(root: string, model: string, output: string, precision: string): Obj | Promise<Obj>;
}
export interface Services extends AdapterOptions { engine?: EnginePorts }
const tools = dirname(fileURLToPath(import.meta.url));
const SOURCE_FLAGS: SourceFlag[] = ['manifest', 'dataset', 'model', 'features'];

export function argumentsFor(values: string[]): Arguments {
  const strings = ['manifest', 'dataset', 'model', 'features', 'target', 'algorithm', 'regularization', 'epochs', 'device', 'precision', 'root', 'output'];
  const { values: parsed, positionals } = parseArgs({ args: values, allowPositionals: true,
    options: { ...Object.fromEntries(strings.map(name => [name, { type: 'string' as const }])), json: { type: 'boolean', default: false } } });
  const options = parsed as Record<string, string | boolean | undefined>;
  const [action, id] = positionals;
  if (positionals.length !== 2 || !ACTIONS.includes(action as Action)) throw new Error('expected ML action and ID');
  if (!ID.test(id)) throw new Error('ML ID must be a plain identifier');
  const required: Record<Action, string[]> = { dataset: ['manifest'], features: ['manifest'], train: ['dataset', 'target'], evaluate: ['dataset', 'model'],
    predict: ['model', 'features'], 'engine-train': ['dataset', 'target'], 'engine-evaluate': ['dataset', 'model'],
    'engine-export': ['model'], 'engine-dataset': ['manifest'], 'engine-public-corpus': ['manifest'] };
  const extra: Partial<Record<Action, string[]>> = { train: ['algorithm', 'regularization'], 'engine-train': ['epochs', 'device'], 'engine-export': ['precision'] };
  const allowed = new Set([...required[action as Action], ...(extra[action as Action] ?? [])]);
  const supplied = strings.filter(name => !['root', 'output'].includes(name) && options[name] !== undefined);
  const missing = required[action as Action].filter(name => !supplied.includes(name));
  if (missing.length) throw new Error(action + ' requires ' + missing.sort().map(name => '--' + name).join(', '));
  const rejected = supplied.filter(name => !allowed.has(name));
  if (rejected.length) throw new Error(action + ' does not accept ' + rejected.sort().map(name => '--' + name).join(', '));
  for (const [flag, choices] of [['algorithm', ['mean', 'ridge']], ['device', ['auto', 'cpu', 'mps']], ['precision', ['float16', 'float32']]] as const) {
    if (options[flag] !== undefined && !(choices as readonly unknown[]).includes(options[flag])) throw new Error('unsupported --' + flag);
  }
  if (options.algorithm === 'mean' && options.regularization !== undefined) throw new Error('mean does not accept ridge regularization');
  const result = { ...options, action, id, root: projectRoot(options.root as string | undefined), json: options.json === true } as unknown as Arguments;
  if (options.regularization !== undefined) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(options.regularization as string)) throw new Error('regularization must be a finite decimal number');
    result.regularization = number(Number(options.regularization), 'regularization');
  }
  if (options.epochs !== undefined) {
    if (!/^[+-]?\d+$/.test(options.epochs as string) || !Number.isSafeInteger(Number(options.epochs))) throw new Error('epochs must be an integer');
    result.epochs = Number(options.epochs);
  }
  return result;
}

async function enginePorts(): Promise<EnginePorts> {
  const files = ['pcb_engine/ml.ts', 'pcb_engine/learning.ts'].map(name => resolve(tools, name));
  for (const path of files) if (!isFile(path)) throw new Error('engine ML action requires the sibling TypeScript port: ' + path);
  const [model, learning] = await Promise.all(files.map(path => import(pathToFileURL(path).href))) as [Partial<EnginePorts>, Partial<EnginePorts>];
  const ports = { ...model, dependencies: learning.dependencies, buildDataset: learning.buildDataset, ingestPublicCorpus: learning.ingestPublicCorpus };
  for (const name of ['dependencies', 'buildDataset', 'ingestPublicCorpus', 'train', 'evaluate', 'exportCoreml'] as const)
    if (typeof ports[name] !== 'function') throw new Error('engine ML port is missing ' + name);
  return ports as EnginePorts;
}
function implementation(): Bindings {
  const inputs = { ...sourcePaths(), ...codeInputs() };
  for (const name of ['pcb_ml.ts', 'lib/cli.ts', 'lib/project-root.mjs', 'pcb_engine/ml.ts', 'pcb_engine/learning.ts']) {
    const path = resolve(tools, name); if (isFile(path)) inputs[path] = sha256File(path);
  }
  delete inputs[resolve('/', process.execPath)]; return inputs;
}

export async function dependencies(root: string, values: string[], services: Services = {}): Promise<Closure> {
  const args = argumentsFor(values), found: Closure = {}, visited = new Set<string>();
  const contractFiles = (value: Obj): void => {
    const metadata = value.metadata ?? {};
    if (!isObject(metadata)) throw new Error('ML source metadata must be an object');
    const contract = value.feature_contract ?? metadata.feature_contract;
    if (!isObject(contract)) return;
    const implementations = object(contract.implementation_sha256 ?? {}, 'feature contract implementations');
    for (const [name, digest] of Object.entries(implementations)) {
      if (!name.startsWith('tools/') || name.split('/').includes('..') || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid logical feature implementation binding');
      bind(name, false);
    }
  };
  const bind = (name: string, inventory = true): void => {
    const path = resolve(root, name);
    if (visited.has(path)) return; visited.add(path);
    if (!isFile(path)) { found[path] = null; return; }
    found[path] = sha256File(path);
    if (inventory) {
      const value = readObject(path); contractFiles(value);
      const inputs = object(value.inputs ?? {}, 'ML source inputs');
      for (const [name, digest] of Object.entries(inputs)) {
        if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid ML source input binding');
        bind(name, false);
      }
    }
  };
  if (args.action === 'engine-public-corpus') bind(args.manifest!, false);
  else if (args.action === 'engine-dataset') Object.assign(found, await (services.engine ?? await enginePorts()).dependencies(root, args.manifest!));
  else if (args.action === 'dataset' || args.action === 'features') {
    bind(args.manifest!, false);
    if (isFile(resolve(root, args.manifest!))) for (const [name] of Object.entries(await manifestDependencies(root, args.manifest!, services))) bind(name, false);
  } else {
    if (args.dataset) bind(args.dataset);
    if (args.model) { bind(args.model, false); if (isFile(resolve(root, args.model))) contractFiles(readObject(resolve(root, args.model))); }
    if (args.features) bind(args.features);
  }
  // Validate external dependency keys while keeping explicit absences.
  const existing = Object.fromEntries(Object.entries(found).filter((entry): entry is [string, string] => entry[1] !== null));
  if (Object.keys(existing).length) validateBindings(existing);
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

const ARTIFACT: Record<Action, string> = { dataset: 'dataset.json', features: 'features.json', train: 'model.json', evaluate: 'evaluation.json', predict: 'predictions.json',
  'engine-train': 'model.json', 'engine-evaluate': 'evaluation.json', 'engine-export': 'export.json', 'engine-dataset': 'dataset.json', 'engine-public-corpus': 'public-corpus.json' };
export async function execute(root: string, values: string[], output: string | null, services: Services = {}): Promise<Obj> {
  root = resolve(root, '.'); output = output === null ? null : resolve(process.cwd(), output);
  const inputs: Closure = implementation(), toolInputs = { [resolve('/', process.execPath)]: sha256File(process.execPath) };
  const artifacts: Bindings = {}, report: Obj = { schema: SCHEMA, action: values[0] ?? null, id: values[1] ?? null, status: 'blocked',
    scope: 'advisory_ml_observation', qualified: false, adopt_model: false, inputs: {}, tool_inputs: toolInputs, absent_inputs: [], artifacts };
  const protectedInputs = new Set([...Object.keys(inputs), ...Object.keys(toolInputs)]);
  let artifact: string | null = null, admitted = false;
  try {
    const args = argumentsFor(values);
    if (output === null) throw new Error('--output is required for durable ML artifacts');
    for (const name of SOURCE_FLAGS) if (args[name]) protectedInputs.add(resolve(root, args[name]!));
    for (const [name, digest] of Object.entries(await dependencies(root, values, services))) {
      if (name in inputs && inputs[name] !== digest) throw new Error('ML implementation changed during admission: ' + name);
      inputs[name] = digest; protectedInputs.add(name);
    }
    if (protectedInputs.has(output)) throw new Error('receipt output would overwrite a consumed input');
    const direct = SOURCE_FLAGS.filter(name => args[name]).map(name => resolve(root, args[name]!));
    // Absent optional KiCad sidecars are observed for races; their absence does not make a standalone PCB unreadable.
    const missing = Object.entries(inputs).filter(([name, digest]) => digest === null && (direct.includes(name) || !/\.kicad_(?:pro|dru)$/.test(name))).map(([name]) => name);
    if (missing.length && (args.action !== 'dataset' || missing.some(name => direct.includes(name)))) throw new Error('requested ML source is missing: ' + missing[0]);
    artifact = resolve(dirname(output), ARTIFACT[args.action]);
    if (artifact === output || protectedInputs.has(artifact) || hasPath(artifact)) throw new Error('artifact output would overwrite an input or existing artifact');
    admitted = true; console.error(`ML ${args.action} ${args.id}: started`);
    let payload: Obj;
    if (args.action === 'dataset') { payload = await buildDataset(root, args.manifest!, args.id, services) as unknown as Obj; writeArtifact(artifact, payload, protectedInputs); }
    else if (args.action === 'features') { payload = await makeFeaturePacket(root, args.manifest!, args.id, services); writeArtifact(artifact, payload, protectedInputs); }
    else if (args.action === 'train') payload = trainModel(root, args.dataset!, { modelId: args.id, target: args.target!, algorithm: args.algorithm ?? 'ridge',
      hyperparameters: args.regularization === undefined ? {} : { alpha: args.regularization }, output: artifact });
    else if (args.action === 'evaluate') payload = evaluateModel(root, args.model!, args.dataset!, { output: artifact });
    else if (args.action.startsWith('engine-')) {
      const engine = services.engine ?? await enginePorts();
      if (args.action === 'engine-public-corpus') {
        const directory = resolve(dirname(output), 'public-corpus'); payload = await engine.ingestPublicCorpus(resolve(root, args.manifest!), directory);
        writeArtifact(artifact, payload, protectedInputs); walkFiles(directory).forEach(path => { artifacts[path] = sha256File(path); });
      } else if (args.action === 'engine-dataset') { payload = await engine.buildDataset(root, args.manifest!, args.id); writeArtifact(artifact, payload, protectedInputs); }
      else if (args.action === 'engine-train') payload = await engine.train(root, args.dataset!, { modelId: args.id, target: args.target!, epochs: args.epochs ?? 200, device: args.device ?? 'auto', output: artifact });
      else if (args.action === 'engine-evaluate') payload = await engine.evaluate(root, resolve(root, args.model!), args.dataset!, { output: artifact });
      else {
        const directory = resolve(dirname(output), 'ranker.mlpackage');
        payload = await engine.exportCoreml(root, resolve(root, args.model!), directory, args.precision ?? 'float16');
        writeArtifact(artifact, payload, protectedInputs); walkFiles(directory).forEach(path => { artifacts[path] = sha256File(path); });
        const registry = directory.replace(/\.mlpackage$/, '.registry.json'); artifacts[registry] = sha256File(registry);
      }
    } else {
      const packet = loadFeaturePacket(root, args.features!, services), eligible = packet.rows.filter(row => row.eligibility.features);
      payload = predictRows(root, args.model!, eligible, { featureNames: packet.feature_names, featureContract: packet.feature_contract, task: packet.task });
      const predictions = new Map((payload.rows as Obj[]).map(row => [row.id, row]));
      payload.rows = packet.rows.map(row => predictions.get(row.id) ?? { id: row.id, prediction: null, status: 'unknown', reasons: row.eligibility.reasons });
      payload.prediction_id = args.id; payload.adopt_model = false;
      payload.feature_packet = { path: resolve(root, args.features!), content_sha256: packet.content_sha256 };
      payload.inputs = Object.fromEntries(Object.entries(inputs).filter((entry): entry is [string, string] => entry[1] !== null));
      payload.content_sha256 = artifactIdentity(payload); writeArtifact(artifact, payload, protectedInputs);
    }
    artifacts[artifact] = sha256File(artifact);
    const payloadInputs = object(payload.inputs ?? {}, 'artifact inputs');
    for (const [name, digest] of Object.entries(payloadInputs)) {
      const path = resolve(root, name);
      if (path in inputs && inputs[path] !== digest) throw new Error('artifact reported a changed ML input: ' + name);
      inputs[path] = text(digest, 'artifact input digest'); protectedInputs.add(path);
    }
    checkClosure(root, inputs); checkClosure(root, toolInputs);
    if (missing.length) throw new Error('declared historical ML source is missing; ineligible rows retained: ' + missing[0]);
    if (args.action === 'evaluate' || args.action === 'engine-evaluate') {
      const folds = object(payload.folds, 'evaluation folds');
      const missing = ['validation', 'test'].filter(split => !number(object(object(folds[split]).counts).target_eligible));
      if (missing.length) throw new Error('evaluation has no eligible ' + missing.join('/').toUpperCase() + ' target rows; descriptive metrics retained');
      report.interpretation = 'Computed disjoint-fold observations; sample count does not establish statistical generalization or a model winner.';
    }
    if (args.action === 'predict' && !(payload.rows as Obj[]).some(row => row.status === 'predicted')) throw new Error('no eligible feature rows produced a finite prediction; unknown rows retained');
    report.status = 'passed'; report.cause = args.action + ' artifact produced; advisory only';
  } catch (error) {
    report.status = error instanceof Error ? 'blocked' : 'failed'; report.cause = errorText(error);
  }
  report.inputs = Object.fromEntries(Object.entries(inputs).filter((entry): entry is [string, string] => entry[1] !== null));
  report.absent_inputs = Object.entries(inputs).filter(([, digest]) => digest === null).map(([name]) => name).sort();
  if (admitted && artifact !== null && isFile(artifact) && !lstatSymlink(artifact)) artifacts[artifact] = sha256File(artifact);
  if (output !== null) writeArtifact(output, report, protectedInputs);
  return report;
}
const lstatSymlink = (path: string) => lstatSync(path).isSymbolicLink();

export async function main(values: string[]): Promise<number> {
  try {
    const args = argumentsFor(values), report = await execute(args.root, values, args.output ?? null);
    const summary: Obj = Object.fromEntries(['schema', 'action', 'id', 'status', 'qualified', 'adopt_model', 'cause'].map(key => [key, report[key]]));
    summary.artifact_count = Object.keys(object(report.artifacts)).length;
    if (args.output && isFile(args.output)) summary.report = { path: resolve(process.cwd(), args.output), sha256: sha256File(args.output) };
    console.log(args.json ? encode(summary) : (report.status === 'passed' ? 'PASS: ' : 'STUCK: ') + report.cause);
    return report.status === 'passed' ? 0 : report.status === 'blocked' ? 1 : 2;
  } catch (error) {
    console.log(encode({ schema: SCHEMA, status: 'blocked', cause: errorText(error), qualified: false, adopt_model: false })); return 1;
  }
}
runMain(import.meta.url, main);
