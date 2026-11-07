// `pcb trial collect`: turn a finished trial folder into one sealed result, schema iot-lab.agent-trial.v1.
// An unknown value is null, never 0. A missing run, a timeout or an agent that did not start is a failed verdict, never an omission.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hashTree } from './agent-trial-prepare.ts';
import { readCase, type AgentCase, type Parser } from './agent-trial-case.ts';
import { settleCrashedTrial, type Processes } from './agent-trial-run.ts';
import { canonicalJson, sha256Text } from './bench-analyze.ts';
import { sealStatus, type SealStatus } from './cad-seal.ts';
import { designExemption } from './design-exemption.ts';
import { atomicJson, readObject, sha256File } from './json-file.ts';
import { summarize } from './pcb-benchmark.ts';
import { jsonDumps } from './py-compat.mjs';
import { verify } from './pcb-evidence.ts';
import type { Gate } from './pcb-next.ts';
import { CHANGE_FILE, SEAL_FILE } from './pcb-source-policy.ts';

export const RESULT_SCHEMA = 'iot-lab.agent-trial.v1';
type Row = Record<string, any>;

export interface AgentUsage {
  tokens_in: number | null; tokens_out: number | null; cost_usd: number | null; turns: number | null; tool_calls: number | null; tool_calls_failed: number | null;
  tokens_known: boolean; stream_complete: boolean; result_subtype: string | null; unparsed_lines: number;
}
export interface CollectServices {
  /** Throws when the gate inputs of the run changed since the run. Production: verifyCurrentInputs of pcb-next.ts. */
  verifyInputs(root: string, board: string, gateDir: string): Promise<unknown>;
  /** The process calls that settle a trial whose runner died. Default: the operating system. */
  processes?: Processes;
}

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const rowsOf = (path: string): string[] => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(line => line.trim()) : [];
/** Values of the Python-shaped readers (bigint, Float, Map) as plain JSON. */
const plain = (value: unknown): unknown => JSON.parse(jsonDumps(value));
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const blocks = (event: Row): Row[] => Array.isArray(event.message?.content) ? event.message.content.filter(isObject) : [];

function claude(events: Row[]): Partial<AgentUsage> {
  const uses = new Set<string>(), failed = new Set<string>();
  let result: Row | null = null;
  for (const event of events) {
    if (event.type === 'result') result = event;
    for (const block of blocks(event)) {
      if (event.type === 'assistant' && block.type === 'tool_use') uses.add(String(block.id ?? `anonymous-${uses.size}`));
      if (event.type === 'user' && block.type === 'tool_result' && block.is_error === true) failed.add(String(block.tool_use_id ?? `anonymous-${failed.size}`));
    }
  }
  const usage = isObject(result?.usage) ? result!.usage : {}, input = num(usage.input_tokens), output = num(usage.output_tokens);
  return {
    tokens_in: input === null ? null : input + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0), tokens_out: output,
    cost_usd: num(result?.total_cost_usd), turns: num(result?.num_turns), tool_calls: uses.size, tool_calls_failed: failed.size,
    stream_complete: result !== null, result_subtype: typeof result?.subtype === 'string' ? result.subtype : null,
  };
}

const CODEX_TOOLS = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search']);

/** `codex exec --json`: a turn.completed event carries usage {input_tokens, cached_input_tokens, output_tokens}; an item.completed event ends a tool item.
 *  Written from the documented event shape; not yet checked against a recorded run. Codex reports no cost. */
function codex(events: Row[]): Partial<AgentUsage> {
  let turns = 0, withUsage = 0, input = 0, output = 0;
  const tools = new Map<string, Row>();
  for (const event of events) {
    if (event.type === 'turn.completed') {
      turns += 1;
      if (isObject(event.usage) && num(event.usage.input_tokens) !== null && num(event.usage.output_tokens) !== null) { withUsage += 1; input += event.usage.input_tokens; output += event.usage.output_tokens; }
    }
    if (event.type === 'item.completed' && isObject(event.item) && CODEX_TOOLS.has(event.item.type)) tools.set(String(event.item.id ?? `anonymous-${tools.size}`), event.item);
  }
  const known = turns > 0 && withUsage === turns, items = [...tools.values()];
  return {
    tokens_in: known ? input : null, tokens_out: known ? output : null, cost_usd: null, turns: turns || null, tool_calls: tools.size,
    tool_calls_failed: items.filter(item => item.status === 'failed' || (item.type === 'command_execution' && typeof item.exit_code === 'number' && item.exit_code !== 0)).length,
    stream_complete: turns > 0 && !events.some(event => event.type === 'turn.failed'),
  };
}

export function parseAgentStream(parser: Parser, text: string): AgentUsage {
  const events: Row[] = [];
  let unparsed = 0;
  for (const line of text.split('\n').filter(entry => entry.trim())) {
    try { const value: unknown = JSON.parse(line); if (isObject(value)) events.push(value); else unparsed += 1; } catch { unparsed += 1; }
  }
  const found = parser === 'claude-stream-json' ? claude(events) : codex(events);
  const usage: AgentUsage = { tokens_in: null, tokens_out: null, cost_usd: null, turns: null, tool_calls: null, tool_calls_failed: null, tokens_known: false, stream_complete: false,
    result_subtype: null, unparsed_lines: unparsed, ...found };
  if (!events.length) Object.assign(usage, { tool_calls: null, tool_calls_failed: null });   // a stream with no event cannot say how many tool calls there were
  usage.tokens_known = usage.tokens_in !== null && usage.tokens_out !== null;
  return usage;
}

function pcbRuns(base: string): Row {
  const folders = existsSync(base) ? readdirSync(base, { withFileTypes: true }).filter(entry => entry.name.startsWith('run-') && entry.isDirectory()).map(entry => join(base, entry.name)).sort() : [];
  const readable: string[] = [], unreadable: { run: string; cause: string }[] = [], byStatus: Record<string, number> = {};
  const totals = { failed_checks: 0, blocked_checks: 0, error_checks: 0, cache_hits: 0, elapsed_s: 0 };
  for (const folder of folders) {
    const run = folder.slice(base.length + 1);
    try {
      const row = (summarize([folder]) as { runs: Row[] }).runs[0]!;
      readable.push(folder);
      byStatus[String(row.status)] = (byStatus[String(row.status)] ?? 0) + 1;
      // summarize returns Python-shaped numbers (bigint or Float); plain() makes them JSON numbers before num().
      totals.elapsed_s += num(plain(row.elapsed_s)) ?? 0;
    } catch (error) {
      unreadable.push({ run, cause: messageOf(error) });
      byStatus.no_receipt = (byStatus.no_receipt ?? 0) + 1;
    }
    for (const line of rowsOf(join(folder, 'events.jsonl'))) {
      let event: Row = {};
      try { event = JSON.parse(line); } catch { /* a torn line counts for nothing */ }
      if (event.type === 'cache.hit') totals.cache_hits += 1;
      if (event.type === 'check.end') {
        if (event.status === 'failed') totals.failed_checks += 1;
        if (event.status === 'blocked') totals.blocked_checks += 1;
        if (event.status === 'error') totals.error_checks += 1;
      }
    }
  }
  return { count: folders.length, by_status: byStatus, ...totals, unreadable, summary: plain(summarize(readable)) };
}

function notesOf(base: string): { intervention: number; rework: number; total: number } {
  const counts = { intervention: 0, rework: 0, total: 0 };
  if (!existsSync(base)) return counts;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.name.startsWith('run-') || !entry.isDirectory()) continue;
    for (const line of rowsOf(join(base, entry.name, 'notes.jsonl'))) {
      let kind: unknown;
      try { kind = JSON.parse(line).kind; } catch { continue; }
      if (kind === 'intervention' || kind === 'rework') { counts[kind] += 1; counts.total += 1; }
    }
  }
  return counts;
}

function sealBlock(project: string, board: string, baselineLines: number): { block: Row; status: SealStatus } {
  const log = rowsOf(join(project, '.gate/cad-seal', `${board}.jsonl`)).slice(baselineLines).flatMap(line => { try { return [JSON.parse(line) as Row]; } catch { return []; } });
  const writes: Record<string, number> = {};
  for (const entry of log) writes[String(entry.tool)] = (writes[String(entry.tool)] ?? 0) + 1;
  const status = sealStatus(project, board);
  return { status, block: { log_lines: log.length, writes_by_tool: writes, accepted_edits: writes['seal-accept'] ?? 0, violations: status.state === 'sealed' ? null : status } };
}

/** Files under hardware-design that differ from the prepared baseline, minus the sealed CAD files whose current content the seal accepts. */
function outsideTools(project: string, board: string, baseline: Record<string, string>, status: SealStatus): Row {
  const now = Object.fromEntries(Object.entries(hashTree(project, 'hardware-design')).filter(([path]) => !path.split('/').includes('.gate'))), sealFile = `hardware-design/boards/${board}/${SEAL_FILE}`, changeFile = `hardware-design/boards/${board}/${CHANGE_FILE}`;
  const sealed = status.state === 'missing' || status.state === 'not_canonical' ? [] : Object.keys(readObject<{ files: Record<string, string> }>(join(project, sealFile)).files);
  const broken = new Set([...status.changed, ...status.added, ...status.removed]);
  const accounted = new Set([...sealed, sealFile, changeFile].filter(path => !broken.has(path) && (path === sealFile || path === changeFile || status.state === 'sealed')));
  const changed = Object.keys(now).filter(path => path in baseline && baseline[path] !== now[path] && !accounted.has(path));
  const added = Object.keys(now).filter(path => !(path in baseline) && !accounted.has(path)), removed = Object.keys(baseline).filter(path => !(path in now) && !accounted.has(path));
  return { count: changed.length + added.length + removed.length, changed, added, removed };
}

interface Verdict { verdict: 'passed' | 'failed'; cause: string | null; detail: string | null; final_run: string | null }
const failure = (cause: string, detail: string | null = null, final_run: string | null = null): Verdict => ({ verdict: 'failed', cause, detail, final_run });

/** The newest sealed check run of the board: a candidate run (edit, route, repair) changes no canonical CAD, so only `check` decides. */
function newestCheck(base: string, board: string): { folder: string | null; seen: number } {
  const found: { time: number; folder: string }[] = [];
  for (const entry of existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []) {
    if (!entry.name.startsWith('run-') || !entry.isDirectory()) continue;
    try {
      const manifest = readObject<Row>(join(base, entry.name, 'run.json'));
      if ((manifest.operation ?? 'check') === 'check' && manifest.board === board) found.push({ time: Date.parse(manifest.created_at) || 0, folder: join(base, entry.name) });
    } catch { /* an unreadable manifest is no run */ }
  }
  const sealed = found.filter(entry => existsSync(join(entry.folder, 'result.json'))).sort((a, b) => b.time - a.time || (a.folder < b.folder ? 1 : -1));
  return { folder: sealed[0]?.folder ?? null, seen: found.length };
}

/** The freshness check where the gate ran: tool versions on the host differ from the ones in the route image. Throws what the check said. */
function prefixed(agentCase: AgentCase): CollectServices {
  return { verifyInputs: async (root, board, gateDir) => {
    const [command, ...args] = [...agentCase.verify_prefix!, 'tools/pcb', 'trial', 'inputs', gateDir, '--board', board];
    const result = spawnSync(command!, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...agentCase.agent.env, IOT_LAB: root } });
    if (result.error || result.status !== 0) throw new Error((result.stderr ?? '').trim().slice(-500) || result.error?.message || `exit ${result.status}`);
  } };
}

async function judge(project: string, board: string, run: Row, services: CollectServices): Promise<Verdict> {
  if (run.aborted) return failure('runner_aborted', String(run.aborted));
  if (run.spawn_error) return failure('agent_not_started', String(run.spawn_error));
  if (run.timed_out === true) return failure('timeout', `the agent reached its deadline (${run.wall_s} s)`);
  if (designExemption(project, board) === null && !existsSync(join(project, 'hardware-design/registry/design-contracts', `${board}.json`))) {
    return failure('design_contract_missing', 'the board has no design contract and no design_contract_exempt reason');
  }
  const { folder, seen } = newestCheck(join(project, '.gate/cli'), board);
  if (!folder) return failure('no_sealed_run', `${seen} check run(s) of ${board}, none sealed`);
  const id = folder.slice(folder.lastIndexOf('/') + 1);
  let receipt: Row;
  try { receipt = plain(verify(folder)) as Row; } catch (error) { return failure('evidence_invalid', messageOf(error), id); }
  const gate = readObject<Gate>(join(folder, 'gate/result.json')), checks = Object.values(gate.checks ?? {});
  if (receipt.status !== 'passed' || gate.exit !== 0 || !checks.length || checks.some(check => check.status !== 'passed')) return failure('gate_failed', `run ${id} ended ${receipt.status}`, id);
  const manifest = readObject<Row>(join(folder, 'run.json'));
  if (manifest.gate_config_sha256 !== sha256File(join(project, 'hardware-design/boards', board, 'gate.json'))) return failure('stale_inputs', 'the board gate.json changed since the run', id);
  try { await services.verifyInputs(project, board, join(folder, 'gate')); } catch (error) { return failure('stale_inputs', messageOf(error), id); }
  return { verdict: 'passed', cause: null, detail: null, final_run: id };
}

export async function collectTrial(dirPath: string, services: CollectServices): Promise<Row> {
  const dir = resolve(dirPath), project = join(dir, 'project');
  for (const name of ['prepare.json', 'case.json']) if (!existsSync(join(dir, name))) throw new Error(`${dir} is not prepared (no ${name})`);
  settleCrashedTrial(dir, services.processes);   // a runner that died leaves an aborted run.json, not a dead end
  if (!existsSync(join(dir, 'run.json'))) throw new Error(`${dir} has no run.json; the agent has not run: tools/pcb trial run ${dir}`);
  const prepare = readObject<Row>(join(dir, 'prepare.json')), run = readObject<Row>(join(dir, 'run.json')), agentCase = readCase(join(dir, 'case.json')).case, board = agentCase.board;
  const stream = join(dir, 'agent.stdout.jsonl');
  const agent = parseAgentStream(agentCase.agent.parser, existsSync(stream) ? readFileSync(stream, 'utf8') : '');
  const seal = sealBlock(project, board, Number(prepare.seal_baseline_lines));
  const base = join(project, '.gate/cli');
  const body = {
    schema: RESULT_SCHEMA, case_id: prepare.case_id, board, lab_commit: prepare.lab_commit, toolchain: prepare.toolchain, case_sha256: prepare.case_sha256,
    wall_s: run.wall_s, exit_code: run.exit_code, signal: run.signal, timed_out: run.timed_out, agent, pcb_runs: pcbRuns(base), seal: seal.block,
    interventions: notesOf(base), outside_tools: outsideTools(project, board, prepare.files, seal.status), design_contract_exempt_applied: prepare.design_contract_exempt_applied === true,
    ...(await judge(project, board, run, agentCase.verify_prefix ? prefixed(agentCase) : services)),
    evidence: { prepare_sha256: sha256File(join(dir, 'prepare.json')), run_sha256: sha256File(join(dir, 'run.json')), agent_stdout_sha256: existsSync(stream) ? sha256File(stream) : null },
  };
  const result = { ...body, result_sha256: sha256Text(canonicalJson(body)) };
  atomicJson(join(dir, 'result.json'), result);
  return result;
}

/** A result is intact when its recorded hash matches its content. */
export function resultIntact(result: Row): boolean {
  const { result_sha256: digest, ...body } = result;
  return digest === sha256Text(canonicalJson(body));
}
