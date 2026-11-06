// Claude agent host (phase 4): Claude Agent SDK in the main process, with the engine's commands as MCP tools.
// One conversation per window; each user turn resumes the same session. The agent can look at boards, BOMs,
// datasheets, run the gate, make build/route candidates (phase 5) and steer the viewer. It has no adopt tool and no
// file-writing tools: replacing a board file stays a user click in the Runs section.
// Tools: the pcb MCP tools, WebSearch, and Read/Grep/Glob inside the open project only (agentPolicy.ts). The project
// root comes from main (the engine's project.open result), never from the renderer's context.
import { z } from 'zod'
import { checkToolUse } from './agentPolicy.ts'
import { toolPath } from './config.ts'
import type { AgentContext, AgentEvent, BoardParts, Findings, ProjectInfo, RunSummary } from '../preload/types'
import type { EngineSupervisor } from './engine'

// Agent route limits: bound one agent request (the CLI deadline is timeout_s + 600 s of verification).
export const ROUTE_LIMITS = { iters: 1000, timeout_s: 3600 }
const VERIFY_S = 600 // runs.ts: default CLI deadline = router timeout_s + 600 s for the fresh gate
const GATE_WAIT_MS = 60 * 60_000
const BUILD_WAIT_MS = 2 * 60 * 60_000

type Notify = { method: string; params: Record<string, unknown> }

/** Resolve with the final run.state of run `id`; reject on timeout or when the engine restarts (the run is then
 * interrupted). The listeners are always removed. */
export function waitRunEnd(engine: EngineSupervisor, id: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const generation = engine.generation
    let done = false
    const finish = (settle: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      engine.off('notify', onNotify)
      engine.off('status', onStatus)
      settle()
    }
    const onNotify = (n: Notify): void => {
      if (n.method === 'run.state' && n.params.id === id && n.params.state !== 'running') finish(() => resolve(n.params))
    }
    const onStatus = (s: { state: string }): void => {
      if (s.state !== 'ready' || engine.generation !== generation) {
        finish(() => reject(new Error(`the engine restarted while run ${id} was running; the run is interrupted`)))
      }
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`run ${id} did not end within ${Math.round(timeoutMs / 1000)} s`))),
      timeoutMs
    )
    engine.on('notify', onNotify)
    engine.on('status', onStatus)
    // The run may have ended before the listener was attached: ask once.
    engine
      .call('run.get', { id, after: 1_000_000_000 })
      .then((r) => {
        const s = (r as { summary?: Record<string, unknown> }).summary
        if (s && s.id === id && s.state !== 'running') finish(() => resolve(s))
      })
      .catch(() => undefined)
  })
}

const PROMPT_APPEND = `
You are the PCB design agent inside PCB Studio, a desktop app for building PCBs (KiCad 10, JLCPCB parts).
The user sees a live board view, a parts/BOM table, datasheets and gate runs next to this chat.
Use the pcb tools to answer from real data: never guess part numbers, counts or gate results.
- pcb.board_parts / pcb.bom read the board; pcb.run_gate runs the real board gate and waits for the verdict;
  pcb.findings lists DRC findings of a run; pcb.show_on_board moves the user's board view to a part or point.
- pcb.build / pcb.route make an isolated candidate board (tools/pcb build, or iotroute with an explicit routing policy),
  gate it fresh and return the verdict, the candidate path and its gate metrics. They never change the board file.
- You cannot adopt a candidate or edit CAD files. Adopting replaces the board file; only the user does it, with the
  Adopt button in the Runs section. Tell the user which run to review and why; never claim it is adopted.
- After you name a part or a finding, call pcb.show_on_board so the user sees it.
- Quote gate counts from the tool output. Keep answers short.
- Only when the user explicitly requests the experimental routing loop, use start_loop, then wait_loop and decide_loop
  until a terminal state. The existing benchmark no-go still stands; do not promise a speedup. Decisions require reasons.
  Use the returned revision. A search result is not a verified candidate. Stop at blocked/proposal/repeated-cause boundaries;
  placement and pin changes need separate explicit reviewed actions. Never expand layers/nets, relax rules, or adopt CAD.
User messages start with a [context] line: open project, board, gate and the user's board selection.`

export class AgentHost {
  private sessionId: string | null = null
  private abort: AbortController | null = null
  private sdk: typeof import('@anthropic-ai/claude-agent-sdk') | null = null
  private engine: EngineSupervisor
  private emit: (e: AgentEvent) => void
  private projectRoot: () => string | null

  constructor(
    engine: EngineSupervisor,
    emit: (e: AgentEvent) => void,
    projectRoot: () => string | null
  ) { this.engine = engine; this.emit = emit; this.projectRoot = projectRoot }

  get busy(): boolean {
    return this.abort !== null
  }

  reset(): void {
    this.cancel()
    this.sessionId = null
  }

  cancel(): void {
    this.abort?.abort()
    this.abort = null
  }

  private async load(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
    this.sdk ??= await import('@anthropic-ai/claude-agent-sdk')
    return this.sdk
  }

  private tools(sdk: typeof import('@anthropic-ai/claude-agent-sdk'), ctx: AgentContext): ReturnType<typeof sdk.createSdkMcpServer> {
    const { tool, createSdkMcpServer } = sdk
    const json = (v: unknown): { content: { type: 'text'; text: string }[] } => ({
      content: [{ type: 'text', text: JSON.stringify(v, null, 1).slice(0, 60_000) }]
    })
    const engine = this.engine
    const pcbOr = (p?: string): string => {
      const v = p || ctx.pcb
      if (!v) throw new Error('no board selected; pass pcb (project-relative .kicad_pcb path)')
      return v
    }
    // A run ends with a run.state notification whose state is not 'running'.
    const waitEnd = (id: string, timeoutMs: number): Promise<Record<string, unknown>> => waitRunEnd(engine, id, timeoutMs)
    // Build/route result for the agent: verdict, cause and the candidate (path, target, gate metrics). No adopt.
    const candidateSummary = async (id: string, timeoutMs: number): Promise<Record<string, unknown>> => {
      const { state, cause, run_id, elapsed_s, candidate, policy } = await waitEnd(id, timeoutMs)
      return {
        run: id,
        run_id,
        state,
        cause,
        elapsed_s,
        policy,
        candidate: candidate ?? null,
        next: candidate
          ? 'The user reviews the candidate in the Runs section and adopts it there (only a passed, gate-verified candidate).'
          : 'No candidate board was produced; report the cause.'
      }
    }
    return createSdkMcpServer({
      name: 'pcb',
      version: '0.1.0',
      tools: [
        tool('boards', 'List the boards of the open project with revisions, states, PCB paths and gate names.', {}, async () => {
          if (!ctx.projectRoot) throw new Error('no project open')
          const p = (await engine.call('project.open', { root: ctx.projectRoot })) as ProjectInfo
          return json(p.boards)
        }),
        tool(
          'board_parts',
          'Footprints of a board: ref, value, C-number, position (mm), rotation, pad count. Default: the board open in the app.',
          { pcb: z.string().optional() },
          async ({ pcb }) =>
            // engine board.parts: one C-number rule (parts.footprint_c_number) for the agent, the BOM and the viewer
            json((await engine.call('board.parts', { pcb: pcbOr(pcb) })) as BoardParts)
        ),
        tool('bom', 'BOM lines of a board with C-numbers, MPNs, datasheet and CAD-asset presence, and missing-data counts.', { pcb: z.string().optional() }, async ({ pcb }) =>
          json(await engine.call('board.bom', { pcb: pcbOr(pcb) }))
        ),
        tool(
          'run_gate',
          'Run the board gate (ERC, DRC with schematic parity, planes, pairs, paths, viapads, kicad-happy) and wait for the verdict. fresh=false reuses cached checks for unchanged inputs.',
          { board: z.string().optional().describe('gate name; default: the open board'), fresh: z.boolean().default(false) },
          async ({ board, fresh }) => {
            const gate = board || ctx.gate
            if (!gate) throw new Error('this board revision has no gate')
            const started = (await engine.call('gate.check', { board: gate, fresh })) as RunSummary
            const end = await waitEnd(started.id, GATE_WAIT_MS)
            const f = (await engine.call('run.findings', { id: started.id })) as Findings
            return json({ ...end, findings: f.items.slice(0, 40), findings_total: f.items.length })
          }
        ),
        tool(
          'build',
          "Run the board's own build pipeline (tools/pcb build) into an isolated candidate, gate it fresh and wait for the verdict. Canonical CAD is not changed. Boards without a pipeline fail with a cause.",
          { board: z.string().optional().describe('gate name; default: the open board') },
          async ({ board }) => {
            const gate = board || ctx.gate
            if (!gate) throw new Error('this board revision has no gate')
            const started = (await engine.call('op.build', { board: gate })) as RunSummary
            return json(await candidateSummary(started.id, BUILD_WAIT_MS))
          }
        ),
        tool(
          'route',
          'Autoroute the board with iotroute (tools/pcb route --router iotroute, policy iot-lab.iotroute-policy.v1) into an isolated candidate, gate it fresh and wait for the verdict. Canonical CAD is not changed. Returns the candidate path and its gate metrics.',
          {
            board: z.string().optional().describe('gate name; default: the open board'),
            iters: z.number().int().positive().max(ROUTE_LIMITS.iters).default(80).describe('router iterations'),
            timeout_s: z
              .number()
              .int()
              .positive()
              .max(ROUTE_LIMITS.timeout_s)
              .default(300)
              .describe('router time budget (verification is extra)'),
            keep: z
              .enum(['lock-nets', 'all'])
              .default('lock-nets')
              .describe('lock-nets: route all but the pair and crystal copper; all: keep all copper, route what is open'),
            layers: z.array(z.string()).default([]).describe('copper layers the router may use; default: all'),
            nets: z.array(z.string()).default([]).describe('exact net names to route; default: every net. Use with keep all')
          },
          async ({ board, iters, timeout_s, keep, layers, nets }) => {
            const gate = board || ctx.gate
            if (!gate) throw new Error('this board revision has no gate')
            const started = (await engine.call('op.route', {
              board: gate,
              policy: { iters, timeout_s, keep, layers, nets }
            })) as RunSummary
            return json(await candidateSummary(started.id, (timeout_s + VERIFY_S + 300) * 1000))
          }
        ),
        tool('start_loop', 'Start the explicitly requested experimental routing loop. It is disabled by default; benchmarks have not shown a speed advantage. Ordinary isolated candidates and full fresh gates are used. Continue with wait_loop and decide_loop.', {
          board: z.string().optional(), experimental: z.literal(true), max_rounds: z.number().int().min(1).max(8).default(3),
          deadline_s: z.number().int().min(30).max(7200).default(900), iters: z.number().int().min(1).max(1000).default(80),
          keep: z.enum(['all','lock-nets']).default('all'), layers: z.array(z.string()).default([]), nets: z.array(z.string()).default([]),
          sprints: z.boolean().default(false)
        }, async ({board,experimental,max_rounds,deadline_s,iters,keep,layers,nets,sprints}) => {
          const gate=board||ctx.gate;if(!gate)throw new Error('this board revision has no gate')
          const route={schema:'iot-lab.iotroute-policy.v1',iters,keep,layers,nets,
            ...(sprints?{sprints:{seeds:[0,1],parallelism:2,deadline_s:Math.min(180,deadline_s-20),verify_reserve_s:30,mem_gb:4}}:{max_time_s:Math.min(300,deadline_s-20)})}
          return json(await engine.call('loop.start',{board:gate,policy:{experimental,max_rounds,deadline_s,done_when:'verified',route}}))
        }),
        tool('wait_loop', 'Wait for the current round to finish and return the next decision boundary or terminal result. Each round uses the existing live viewer. No new round starts here.', {
          id:z.string(),wait_s:z.number().int().min(1).max(600).default(600)
        }, async ({id,wait_s})=>json(await engine.call('loop.wait',{id,wait_s}))),
        tool('decide_loop', 'Record a reason and one validated move at the current revision. Routing moves stay within the admitted policy. Placement/pin proposals stop for separate review. Use stop when no justified continuation remains.', {
          id:z.string(),revision:z.number().int().positive(),reason:z.string().min(1).max(2000),
          move:z.discriminatedUnion('kind',[
            z.object({kind:z.literal('stop')}),z.object({kind:z.literal('reroute_stuck')}),z.object({kind:z.literal('single_reuse')}),
            z.object({kind:z.literal('change_setting'),setting:z.enum(['passes','time_s','layers']),value:z.union([z.number(),z.array(z.string())])}),
            z.object({kind:z.literal('widen_region'),nets:z.array(z.string()).min(1)}),
            z.object({kind:z.literal('move_part'),ref:z.string(),dx_mm:z.number(),dy_mm:z.number()}),
            z.object({kind:z.literal('move_cluster'),refs:z.array(z.string()).min(2),dx_mm:z.number(),dy_mm:z.number()}),
            z.object({kind:z.literal('swap_pins'),ref:z.string(),pads:z.array(z.string()).length(2)}),
            z.object({kind:z.literal('ask_user'),question:z.string().min(1)})
          ])
        }, async ({id,revision,reason,move})=>json(await engine.call('loop.decide',{id,revision,decision:{reason,move}}))),
        tool('cancel_loop', 'Stop the requested loop. The current child must settle; retained candidates are never adopted automatically.',
          {id:z.string()},async ({id})=>json(await engine.call('loop.cancel',{id}))),
        tool('findings', 'DRC findings (with positions) of an earlier gate run by its id.', { run: z.string() }, async ({ run }) =>
          json(await engine.call('run.findings', { id: run }))
        ),
        tool(
          'show_on_board',
          "Move the user's board view to a part (ref) or a point (x, y in mm).",
          { ref: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
          async ({ ref, x, y }) => {
            this.emit({ kind: 'viewer', ref, x, y })
            return json({ ok: true })
          }
        )
      ]
    })
  }

  async send(text: string, ctx: AgentContext): Promise<void> {
    if (this.abort) throw new Error('the agent is still answering')
    ctx = { ...ctx, projectRoot: this.projectRoot() } // main's verified root, not the renderer's
    const root = ctx.projectRoot
    const sdk = await this.load()
    this.abort = new AbortController()
    const contextLine = `[context] project=${ctx.projectRoot ?? 'none'} board=${ctx.pcb ?? 'none'} gate=${ctx.gate ?? 'none'} selection=${ctx.selection ?? 'none'}`
    try {
      const q = sdk.query({
        prompt: `${contextLine}\n${text}`,
        options: {
          // In Electron, process.execPath is the Electron binary: run the Claude Code CLI with real Node, and give a
          // Finder-launched app the user's tool PATH (config.ts).
          executable: 'node',
          env: { ...process.env, PATH: toolPath() },
          stderr: (d: string) => console.error('[agent]', d.trimEnd()),
          abortController: this.abort,
          cwd: root ?? undefined,
          resume: this.sessionId ?? undefined,
          mcpServers: { pcb: this.tools(sdk, ctx) },
          // Built-in tools: only these exist in the session. Read/Grep/Glob are checked per call (agentPolicy.ts).
          tools: ['Read', 'Grep', 'Glob', 'WebSearch'],
          allowedTools: ['mcp__pcb__*', 'WebSearch'],
          disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch'],
          permissionMode: 'default',
          canUseTool: async (name, input) => checkToolUse(name, input, root),
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (h) => {
                    const i = h as { tool_name: string; tool_input: unknown }
                    const r = checkToolUse(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>, root)
                    return r.behavior === 'deny'
                      ? {
                          hookSpecificOutput: {
                            hookEventName: 'PreToolUse' as const,
                            permissionDecision: 'deny' as const,
                            permissionDecisionReason: r.message
                          }
                        }
                      : {}
                  }
                ]
              }
            ]
          },
          settingSources: ['project'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT_APPEND }
        }
      })
      for await (const m of q) {
        if ('session_id' in m && m.session_id) this.sessionId = m.session_id
        if (m.type === 'assistant') {
          for (const block of m.message.content) {
            if (block.type === 'text' && block.text.trim()) this.emit({ kind: 'text', text: block.text })
            else if (block.type === 'tool_use') this.emit({ kind: 'tool', name: block.name, input: block.input })
          }
        } else if (m.type === 'result') {
          if (m.subtype === 'success') {
            this.emit({ kind: 'done', costUsd: m.total_cost_usd, durationMs: m.duration_ms, turns: m.num_turns })
          } else {
            this.emit({ kind: 'error', message: `agent stopped: ${m.subtype}` })
          }
        }
      }
    } catch (e) {
      this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.abort = null
    }
  }
}
