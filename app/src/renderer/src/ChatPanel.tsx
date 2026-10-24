// Claude chat beside the board. The agent runs in the main process (Claude Agent SDK) with the engine as tools.
import { useEffect, useRef, useState } from 'react'
import type { AgentContext, AgentEvent } from '../../preload/types'

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

  const send = async (): Promise<void> => {
    const text = draft.trim()
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

  return (
    <aside className="chat chatpanel" aria-label="Claude">
      <div className="chathead">
        <strong>Claude</strong>
        <span style={{ color: 'var(--dim)', fontSize: 12 }}>read-only tools · edits come with candidates</span>
        <span style={{ flex: '1 1 auto' }} />
        <button
          type="button"
          className="tab"
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
          <p style={{ color: 'var(--dim)' }}>
            Ask about the open board: parts, datasheets, gate results. Click a pad on the board to mention it.
          </p>
        ) : null}
        {msgs.map((m, i) =>
          m.who === 'tool' ? (
            <div key={i} className="toolchip mono" title={JSON.stringify(m.input)}>
              ⚙ {toolLabel(m.name)}
            </div>
          ) : m.who === 'meta' ? (
            <div key={i} className="meta" style={{ color: m.error ? 'var(--err)' : 'var(--dim)' }}>
              {m.text}
            </div>
          ) : (
            <div key={i} className={m.who === 'you' ? 'bubble you' : 'bubble claude'}>
              <span className="who">{m.who === 'you' ? 'You' : 'Claude'}</span>
              <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
            </div>
          )
        )}
        {busy ? <div className="meta">Claude is working…</div> : null}
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
          <button type="button" className="tab mono" onClick={() => setDraft((d) => (d ? `${d} ${mention} ` : `${mention} `))}>
            + {mention}
          </button>
        ) : null}
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-input"
          rows={3}
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
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {busy ? (
            <button type="button" onClick={() => window.api.agent.cancel()}>
              Stop
            </button>
          ) : null}
          <button type="submit" className="primary" disabled={busy || !draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </aside>
  )
}
