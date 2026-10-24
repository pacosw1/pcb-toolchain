// Claude agent host (phase 4): Claude Agent SDK in the main process, with the engine's commands as MCP tools.
// One conversation per window; each user turn resumes the same session. The agent can look at boards, BOMs,
// datasheets, run the gate, make build/route candidates (phase 5) and steer the viewer. It has no adopt tool and no
// file-writing tools: replacing a board file stays a user click in the Runs section.
import { z } from 'zod'
import type { EngineSupervisor } from './engine'

export interface AgentContext {
  projectRoot: string | null
  pcb: string | null
  gate: string | null
  selection: string | null // "@U101.41 #FSPI_D0"
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'viewer'; ref?: string; x?: number; y?: number }
  | { kind: 'done'; costUsd?: number; durationMs?: number; turns?: number }
  | { kind: 'error'; message: string }

const PROMPT_APPEND = `
You are the PCB design agent inside PCB Studio, a desktop app for building PCBs (KiCad 10, JLCPCB parts).
The user sees a live board view, a parts/BOM table, datasheets and gate runs next to this chat.
Use the pcb tools to answer from real data: never guess part numbers, counts or gate results.
- pcb.board_parts / pcb.bom read the board; pcb.run_gate runs the real board gate and waits for the verdict;
  pcb.findings lists DRC findings of a run; pcb.show_on_board moves the user's board view to a part or point.
- pcb.build / pcb.route make an isolated candidate board (tools/pcb build, or Fastroute with an explicit routing policy),
  gate it fresh and return the verdict, the candidate path and its gate metrics. They never change the board file.
- You cannot adopt a candidate or edit CAD files. Adopting replaces the board file; only the user does it, with the
  Adopt button in the Runs section. Tell the user which run to review and why; never claim it is adopted.
- After you name a part or a finding, call pcb.show_on_board so the user sees it.
- Quote gate counts from the tool output. Keep answers short.
User messages start with a [context] line: open project, board, gate and the user's board selection.`

export class AgentHost {
  private sessionId: string | null = null
  private abort: AbortController | null = null
  private sdk: typeof import('@anthropic-ai/claude-agent-sdk') | null = null

  constructor(
    private engine: EngineSupervisor,
    private emit: (e: AgentEvent) => void
  ) {}

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
    const waitEnd = (id: string): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        const on = (n: { method: string; params: Record<string, unknown> }): void => {
          if (n.method === 'run.state' && n.params.id === id && n.params.state !== 'running') {
            engine.off('notify', on)
            resolve(n.params)
          }
        }
        engine.on('notify', on)
      })
    // Build/route result for the agent: verdict, cause and the candidate (path, target, gate metrics). No adopt.
    const candidateSummary = async (id: string): Promise<Record<string, unknown>> => {
      const { state, cause, run_id, elapsed_s, candidate, policy } = await waitEnd(id)
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
          const p = (await engine.call('project.open', { root: ctx.projectRoot })) as { boards: unknown[] }
          return json(p.boards)
        }),
        tool(
          'board_parts',
          'Footprints of a board: ref, value, C-number, position (mm), rotation, pad count. Default: the board open in the app.',
          { pcb: z.string().optional() },
          async ({ pcb }) => {
            const g = (await engine.call('board.geometry', { pcb: pcbOr(pcb) })) as {
              footprints: { ref: string; x: number; y: number; rot: number; props?: Record<string, string>; pads: unknown[] }[]
              tracks: unknown[]
              vias: unknown[]
              bbox: number[]
            }
            return json({
              bbox_mm: g.bbox,
              tracks: g.tracks.length,
              vias: g.vias.length,
              footprints: g.footprints.map((f) => ({
                ref: f.ref,
                value: f.props?.Value,
                lcsc: f.props?.LCSC,
                x: f.x,
                y: f.y,
                rot: f.rot,
                pads: f.pads.length
              }))
            })
          }
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
            const started = (await engine.call('gate.check', { board: gate, fresh })) as { id: string }
            const end = await waitEnd(started.id)
            const f = (await engine.call('run.findings', { id: started.id })) as { items: unknown[] }
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
            const started = (await engine.call('op.build', { board: gate })) as { id: string }
            return json(await candidateSummary(started.id))
          }
        ),
        tool(
          'route',
          'Autoroute the board with Fastroute (tools/pcb route --router fastroute, policy iot-lab.routing-policy.v1) into an isolated candidate, gate it fresh and wait for the verdict. Canonical CAD is not changed. Returns the candidate path and its gate metrics.',
          {
            board: z.string().optional().describe('gate name; default: the open board'),
            layers: z.array(z.string()).default(['F.Cu', 'B.Cu']).describe('copper layers the router may use'),
            nets: z.array(z.string()).optional().describe('exact net names; default: every net on the board'),
            passes: z.number().int().positive().default(40),
            timeout_s: z.number().int().positive().default(300).describe('router time budget (verification is extra)'),
            threads: z.number().int().positive().default(1)
          },
          async ({ board, layers, nets, passes, timeout_s, threads }) => {
            const gate = board || ctx.gate
            if (!gate) throw new Error('this board revision has no gate')
            const started = (await engine.call('op.route', {
              board: gate,
              policy: { layers, nets: nets ?? [], passes, timeout_s, threads }
            })) as { id: string }
            return json(await candidateSummary(started.id))
          }
        ),
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
    const sdk = await this.load()
    this.abort = new AbortController()
    const contextLine = `[context] project=${ctx.projectRoot ?? 'none'} board=${ctx.pcb ?? 'none'} gate=${ctx.gate ?? 'none'} selection=${ctx.selection ?? 'none'}`
    try {
      const q = sdk.query({
        prompt: `${contextLine}\n${text}`,
        options: {
          // In Electron, process.execPath is the Electron binary: run the Claude Code CLI with real Node, and give a
          // Finder-launched app the Homebrew PATH.
          executable: 'node',
          env: {
            ...process.env,
            PATH: [process.env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin'].join(':')
          },
          stderr: (d: string) => console.error('[agent]', d.trimEnd()),
          abortController: this.abort,
          cwd: ctx.projectRoot ?? undefined,
          resume: this.sessionId ?? undefined,
          mcpServers: { pcb: this.tools(sdk, ctx) },
          allowedTools: ['mcp__pcb__*', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
          disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit'],
          permissionMode: 'dontAsk',
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
