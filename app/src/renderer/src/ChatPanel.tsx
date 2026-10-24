// Claude chat beside the board. The agent runs in the main process (Claude Agent SDK) with the engine as tools.
import { useEffect, useRef, useState } from 'react'
import type { AgentContext, AgentEvent } from '../../preload/types'
import { Markdown } from './Markdown'

type Msg =
  | { who: 'you'; text: string }
  | { who: 'claude'; text: string }
  | { who: 'tool'; name: string; input: unknown }
  | { who: 'meta'; text: string; error?: boolean }

function toolLabel(name: string): string {
  return name.replace(/^mcp__pcb__/, 'pcb.')
}

export function ChatPanel({
  ctx,
  mention,
  onViewer
}: {
  ctx: AgentContext
  /** The current board selection as a mention, e.g. "@U101.41 #FSPI_D0". */
  mention: string | null
  onViewer: (v: { ref?: string; x?: number; y?: number }) => void
}): React.JSX.Element {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const viewerRef = useRef(onViewer)
  viewerRef.current = onViewer

  useEffect(() => {
    const off = window.api.agent.onEvent((e: AgentEvent) => {
        if (e.kind === 'text') setMsgs((m) => [...m, { who: 'claude', text: e.text }])
        else if (e.kind === 'tool') setMsgs((m) => [...m, { who: 'tool', name: e.name, input: e.input }])
        else if (e.kind === 'viewer') viewerRef.current(e)
        else if (e.kind === 'done') {
          setBusy(false)
          const bits = [
            e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)} s` : null,
            e.turns != null ? `${e.turns} turns` : null,
            e.costUsd != null ? `$${e.costUsd.toFixed(3)}` : null
          ].filter(Boolean)
          setMsgs((m) => [...m, { who: 'meta', text: bits.join(' · ') }])
        } else if (e.kind === 'error') {
          setBusy(false)
          setMsgs((m) => [...m, { who: 'meta', text: e.message, error: true }])
        }
      })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [msgs])

  const send = async (override?: string): Promise<void> => {
    const text = (override ?? draft).trim()
    if (!text || busy) return
    setDraft('')
    setBusy(true)
    setMsgs((m) => [...m, { who: 'you', text }])
    try {
      await window.api.agent.send(text, ctx)
    } catch (e) {
      setBusy(false)
      setMsgs((m) => [...m, { who: 'meta', text: String(e), error: true }])
    }
  }

  // Consecutive tool calls render as one row of chips.
  const rows: (Msg | { who: 'tools'; items: { name: string; input: unknown }[] })[] = []
  for (const m of msgs) {
    const last = rows[rows.length - 1]
    if (m.who === 'tool') {
      if (last && last.who === 'tools') last.items.push({ name: m.name, input: m.input })
      else rows.push({ who: 'tools', items: [{ name: m.name, input: m.input }] })
    } else rows.push(m)
  }

  const quick = ctx.pcb
    ? ['Summarize this board', 'What is missing in the BOM?', 'Run the gate and explain the result']
    : ['Which boards are in this project?']

  return (
    <aside className="chat chatpanel" aria-label="Claude">
      <div className="chathead">
        <span className="claude-mark" aria-hidden="true">✳</span>
        <strong>Claude</strong>
        <span className="chip-ro" title="Claude reads boards, BOMs and datasheets and runs the gate. File edits arrive with candidate runs.">
          read-only
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void window.api.agent.reset()
            setMsgs([])
            setBusy(false)
          }}
        >
          New chat
        </button>
      </div>
      <div className="chatlog" role="log" aria-label="Conversation">
        {msgs.length === 0 ? (
          <div className="chat-empty">
            <p>Ask about the open board: parts, datasheets, gate results. Click a pad on the board to mention it.</p>
            <div className="quick">
              {quick.map((q) => (
                <button key={q} type="button" className="ghost" onClick={() => void send(q)} disabled={busy}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {rows.map((m, i) =>
          m.who === 'tools' ? (
            <div key={i} className="toolrow">
              {m.items.map((t, j) => (
                <span key={j} className="toolchip mono" title={JSON.stringify(t.input)}>
                  {toolLabel(t.name)}
                </span>
              ))}
            </div>
          ) : m.who === 'meta' ? (
            <div key={i} className="meta" style={{ color: m.error ? 'var(--err)' : undefined }}>
              {m.text}
            </div>
          ) : m.who === 'you' ? (
            <div key={i} className="bubble you">
              {m.text}
            </div>
          ) : m.who === 'claude' ? (
            <div key={i} className="bubble claude">
              <Markdown text={m.text} />
            </div>
          ) : null
        )}
        {busy ? (
          <div className="meta working">
            <span className="spinner" aria-hidden="true" /> Claude is working…
          </div>
        ) : null}
        <div ref={end} />
      </div>
      <form
        className="chatform"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {mention ? (
          <button type="button" className="mention mono" onClick={() => setDraft((d) => (d ? `${d} ${mention} ` : `${mention} `))}>
            + {mention}
          </button>
        ) : null}
        <div className="composer">
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <textarea
            id="chat-input"
            rows={2}
            value={draft}
            placeholder="Ask Claude about this board…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {busy ? (
            <button type="button" className="ghost" onClick={() => window.api.agent.cancel()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary send" aria-label="Send" disabled={!draft.trim()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
        <div className="hint">Enter to send · Shift+Enter for a new line</div>
      </form>
    </aside>
  )
}
