// An agent trial case: one frozen board, one prompt, one agent command and one budget. Validated strictly; a bad case is a clear error.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const CASE_SCHEMA = 'iot-lab.agent-case.v1';
export const PARSERS = ['claude-stream-json', 'codex-jsonl'] as const;
export type Parser = typeof PARSERS[number];
export interface PinnedFile { path: string; sha256: string }
export interface AgentCase {
  schema: typeof CASE_SCHEMA; case_id: string; board: string; lab: { commit: string }; inputs: PinnedFile[]; prompt: PinnedFile;
  agent: { argv: string[]; parser: Parser; env?: Record<string, string> }; budget: { timeout_s: number; max_turns?: number }; design_contract_exempt: boolean;
  setup?: { argv: string[]; env?: Record<string, string> }; verify_prefix?: string[];
}

const PLACEHOLDER = /\{([a-z_]+)\}/g;
const KNOWN = new Set(['prompt_file', 'root', 'board', 'max_turns', 'timeout_s']);
const RESERVED_ENV = new Set(['IOT_LAB', 'PCB_RUNS_DIR']);
const FIELDS = new Set(['schema', 'case_id', 'board', 'lab', 'inputs', 'prompt', 'agent', 'budget', 'design_contract_exempt', 'setup', 'verify_prefix']);
const SETUP_KNOWN = new Set(['root', 'board']);
const SHA = /^[0-9a-f]{64}$/;

const fail = (message: string): never => { throw new Error(`agent case: ${message}`); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const relativePath = (path: unknown): boolean => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.split('/').includes('..') && !path.includes('\\');

function pinned(value: unknown, name: string): PinnedFile {
  if (!isObject(value) || !relativePath(value.path)) return fail(`${name} needs a relative path`);
  if (typeof value.sha256 !== 'string' || !SHA.test(value.sha256)) return fail(`${name} needs a SHA-256 for ${String(value.path)}`);
  return { path: value.path as string, sha256: value.sha256 };
}

export function validateCase(value: unknown): AgentCase {
  if (!isObject(value) || value.schema !== CASE_SCHEMA) return fail(`schema must be ${CASE_SCHEMA}`);
  for (const key of Object.keys(value)) if (!FIELDS.has(key)) fail(`unknown field ${key}`);
  if (typeof value.case_id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value.case_id)) fail('case_id must be letters, digits, . _ -');
  if (typeof value.board !== 'string' || !/^[A-Z0-9][A-Z0-9-]*$/.test(value.board)) fail('board must be a board ID such as ENV-SENSE');
  const board = value.board as string;
  if (!isObject(value.lab) || typeof value.lab.commit !== 'string' || !/^[0-9a-f]{7,64}$/.test(value.lab.commit)) fail('lab.commit must be a hex commit id');
  if (!Array.isArray(value.inputs) || !value.inputs.length) fail('inputs must list the pinned board files');
  const inputs = (value.inputs as unknown[]).map((entry, index) => pinned(entry, `inputs[${index}]`));
  const seen = new Set<string>();
  for (const input of inputs) { if (seen.has(input.path)) fail(`input ${input.path} listed twice`); seen.add(input.path); }
  if (!inputs.some(input => input.path.startsWith('hardware-design/boards/') && input.path.endsWith('.kicad_pcb'))) fail(`inputs must include the .kicad_pcb of ${board}`);
  const prompt = pinned(value.prompt, 'prompt');
  const agent = value.agent;
  if (!isObject(agent) || !Array.isArray(agent.argv) || !agent.argv.length || agent.argv.some(part => typeof part !== 'string')) return fail('agent.argv must be a nonempty string array');
  if (!PARSERS.includes(agent.parser as Parser)) fail(`agent.parser must be one of ${PARSERS.join(', ')}`);
  if (agent.env !== undefined) {
    if (!isObject(agent.env) || Object.values(agent.env).some(entry => typeof entry !== 'string')) fail('agent.env must map names to strings');
    for (const name of Object.keys(agent.env as object)) if (RESERVED_ENV.has(name)) fail(`agent.env cannot set ${name}; the trial sets it`);
  }
  const budget = value.budget;
  if (!isObject(budget) || typeof budget.timeout_s !== 'number' || !Number.isFinite(budget.timeout_s) || budget.timeout_s <= 0) return fail('budget.timeout_s must be a positive number');
  if (budget.max_turns !== undefined && (!Number.isInteger(budget.max_turns) || (budget.max_turns as number) <= 0)) fail('budget.max_turns must be a positive integer');
  for (const part of agent.argv as string[]) for (const [, name] of part.matchAll(PLACEHOLDER)) {
    if (!KNOWN.has(name!)) fail(`unknown placeholder {${name}} in agent.argv`);
    if (name === 'max_turns' && budget.max_turns === undefined) fail('agent.argv uses {max_turns} but budget.max_turns is not set');
  }
  if (value.design_contract_exempt !== undefined && typeof value.design_contract_exempt !== 'boolean') fail('design_contract_exempt must be true or false');
  const prefix = value.verify_prefix;
  if (prefix !== undefined && (!Array.isArray(prefix) || !prefix.length || prefix.some(part => typeof part !== 'string'))) fail('verify_prefix must be a nonempty string array');
  const setup = value.setup;
  if (setup !== undefined) {
    if (!isObject(setup) || !Array.isArray(setup.argv) || !setup.argv.length || setup.argv.some(part => typeof part !== 'string')) return fail('setup.argv must be a nonempty string array');
    if (setup.env !== undefined) {
      if (!isObject(setup.env) || Object.values(setup.env).some(entry => typeof entry !== 'string')) fail('setup.env must map names to strings');
      for (const name of Object.keys(setup.env as object)) if (RESERVED_ENV.has(name)) fail(`setup.env cannot set ${name}; the trial sets it`);
    }
    for (const part of setup.argv as string[]) for (const [, name] of part.matchAll(PLACEHOLDER)) if (!SETUP_KNOWN.has(name!)) fail(`unknown placeholder {${name}} in setup.argv`);
  }
  return {
    schema: CASE_SCHEMA, case_id: value.case_id as string, board, lab: { commit: (value.lab as { commit: string }).commit }, inputs, prompt,
    agent: { argv: agent.argv as string[], parser: agent.parser as Parser, ...(agent.env ? { env: agent.env as Record<string, string> } : {}) },
    budget: { timeout_s: budget.timeout_s, ...(budget.max_turns !== undefined ? { max_turns: budget.max_turns as number } : {}) },
    design_contract_exempt: value.design_contract_exempt === true,
    ...(setup ? { setup: setup as unknown as NonNullable<AgentCase['setup']> } : {}), ...(prefix ? { verify_prefix: prefix as string[] } : {}),
  };
}

/** The case and the SHA-256 of its file bytes. */
export function readCase(path: string): { case: AgentCase; sha256: string } {
  const text = readFileSync(path);
  let value: unknown;
  try { value = JSON.parse(text.toString('utf8')); } catch { return fail(`${path} is not valid JSON`); }
  return { case: validateCase(value), sha256: createHash('sha256').update(text).digest('hex') };
}

/** The agent command with its placeholders filled. */
export function fillArgv(agentCase: AgentCase, values: { prompt_file: string; root: string }): string[] {
  const all: Record<string, string> = { ...values, board: agentCase.board, timeout_s: String(agentCase.budget.timeout_s), max_turns: String(agentCase.budget.max_turns ?? '') };
  return agentCase.agent.argv.map(part => part.replace(PLACEHOLDER, (whole, name: string) => all[name] ?? whole));
}
