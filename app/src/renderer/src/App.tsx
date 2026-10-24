import { useEffect, useState } from 'react'
import type { EngineStatus } from '../../preload/types'

const STATE_COLOR: Record<EngineStatus['state'], string> = {
  ready: 'var(--ok)',
  starting: 'var(--warn)',
  restarting: 'var(--warn)',
  stopped: 'var(--err)'
}

function useEngineStatus(): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  useEffect(() => {
    window.api.engine.status().then(setStatus)
    return window.api.engine.onStatus(setStatus)
  }, [])
  return status
}

function EnginePanel({ status }: { status: EngineStatus | null }): React.JSX.Element {
  const [info, setInfo] = useState<Record<string, unknown> | null>(null)
  const [log, setLog] = useState<string[]>([])
  const ready = status?.state === 'ready'
  const add = (line: string): void => setLog((l) => [...l.slice(-30), `${new Date().toLocaleTimeString()} ${line}`])

  useEffect(() => {
    if (!ready) return
    window.api.engine
      .call('engine.info')
      .then((r) => setInfo(r as Record<string, unknown>))
      .catch((e) => add(String(e)))
  }, [ready, status?.restarts])

  const ping = async (): Promise<void> => {
    const t0 = performance.now()
    try {
      const r = (await window.api.engine.call('engine.ping')) as { uptime_s: number }
      add(`ping ok in ${(performance.now() - t0).toFixed(1)} ms, engine uptime ${r.uptime_s} s`)
    } catch (e) {
      add(`ping failed: ${e}`)
    }
  }

  return (
    <section className="panel" aria-label="Engine">
      <h2>Engine</h2>
      <dl className="kv">
        <dt>State</dt>
        <dd>{status?.state ?? '…'}</dd>
        <dt>Port / PID</dt>
        <dd>
          {status?.port ?? '—'} / {status?.pid ?? '—'}
        </dd>
        <dt>Restarts</dt>
        <dd>{status?.restarts ?? 0}</dd>
        <dt>Version</dt>
        <dd>{(info?.version as string) ?? '—'}</dd>
        <dt>Python</dt>
        <dd>{(info?.python as string) ?? '—'}</dd>
        <dt>kicad-cli</dt>
        <dd>{(info?.kicad_cli as string) ?? 'not found'}</dd>
        <dt>Methods</dt>
        <dd>{((info?.methods as string[]) ?? []).join(', ') || '—'}</dd>
        {status?.lastError ? (
          <>
            <dt>Last error</dt>
            <dd>{status.lastError}</dd>
          </>
        ) : null}
      </dl>
      <div className="row">
        <button type="button" onClick={ping} disabled={!ready}>
          Ping engine
        </button>
        <button type="button" onClick={() => window.api.engine.kill().then(() => add('engine killed (crash test)'))}>
          Kill engine (crash test)
        </button>
      </div>
      {log.length ? <pre className="log">{log.join('\n')}</pre> : null}
    </section>
  )
}

function App(): React.JSX.Element {
  const status = useEngineStatus()
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PCB Studio</span>
        <span style={{ color: 'var(--muted)' }}>No project open</span>
        <span style={{ flex: '1 1 auto' }} />
        <span className="pill" role="status" aria-label="Engine status">
          <span className="dot" style={{ background: status ? STATE_COLOR[status.state] : 'var(--dim)' }} />
          engine {status?.state ?? '…'}
        </span>
      </header>
      <div className="body">
        <aside className="sidebar">
          <h2>Boards</h2>
          <p style={{ color: 'var(--dim)', margin: 0 }}>Open a hardware project (phase 2).</p>
        </aside>
        <main className="main">
          <section className="panel placeholder" aria-label="Board view">
            Board view — phase 2
          </section>
          <EnginePanel status={status} />
        </main>
        <aside className="chat" aria-label="Claude">
          <h2 style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--dim)' }}>
            Claude
          </h2>
          Agent chat arrives in phase 4.
        </aside>
      </div>
    </div>
  )
}

export default App
