// Gate runs for the selected board revision: start (fresh / changed), live events, final metrics and verdict.
import { useEffect, useMemo, useState } from 'react'
import type { Finding } from './types'

export interface RunSummary {
  id: string
  board: string
  mode: string
  state: 'running' | 'passed' | 'failed' | 'error' | 'cancelled'
  started: number
  exit_code: number | null
  run_id: string | null
  cause: string | null
  metrics: Record<string, number> | null
  findings: number
  events: number
  elapsed_s: number | null
}

type Ev = Record<string, unknown> & { type?: string; seq?: number }

const STATE_COLOR: Record<RunSummary['state'], string> = {
  running: 'var(--warn)',
  passed: 'var(--ok)',
  failed: 'var(--err)',
  error: 'var(--err)',
  cancelled: 'var(--dim)'
}

function isWarning(metric: string): boolean {
  return metric.endsWith('warnings')
}

function line(e: Ev): string {
  const t = e.type ?? '?'
  const bits = [t]
  for (const k of ['stage', 'check', 'tool', 'status', 'verdict', 'text', 'message', 'cause']) {
    const v = e[k]
    if (typeof v === 'string' && v) bits.push(v)
  }
  return bits.join('  ')
}

export function ChecksView({
  gate,
  onFindings,
  onShowFinding
}: {
  gate: string | null
  onFindings: (f: Finding[]) => void
  onShowFinding: (f: Finding) => void
}): React.JSX.Element {
  const [findings, setFindings] = useState<Finding[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, Ev[]>>({})
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    window.api.engine.call('run.list').then((r) => setRuns(r as RunSummary[])).catch(() => undefined)
    return window.api.engine.onNotify((n) => {
      if (n.method === 'run.state') {
        const s = n.params as unknown as RunSummary
        setRuns((rs) => [s, ...rs.filter((r) => r.id !== s.id)])
      } else if (n.method === 'run.event') {
        const { id, event } = n.params as { id: string; event: Ev }
        setEvents((m) => ({ ...m, [id]: [...(m[id] ?? []).slice(-400), event] }))
      }
    })
  }, [])

  const mine = useMemo(() => runs.filter((r) => r.board === gate).sort((a, b) => b.started - a.started), [runs, gate])
  const run = mine.find((r) => r.id === cur) ?? mine[0] ?? null

  useEffect(() => {
    if (!run || events[run.id]) return
    window.api.engine
      .call('run.get', { id: run.id })
      .then((r) => setEvents((m) => ({ ...m, [run.id]: (r as { events: Ev[] }).events })))
      .catch(() => undefined)
  }, [run, events])

  const start = async (fresh: boolean): Promise<void> => {
    if (!gate) return
    setErr(null)
    try {
      const s = (await window.api.engine.call('gate.check', { board: gate, fresh })) as RunSummary
      setRuns((rs) => [s, ...rs.filter((r) => r.id !== s.id)])
      setCur(s.id)
    } catch (e) {
      setErr(String(e))
    }
  }

  // Findings of the shown run, once it has ended.
  useEffect(() => {
    if (!run || run.state === 'running') {
      setFindings([])
      return
    }
    window.api.engine
      .call('run.findings', { id: run.id })
      .then((r) => {
        const items = (r as { items: Finding[] }).items
        setFindings(items)
        onFindings(items)
      })
      .catch(() => setFindings([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, run?.state])

  const running = mine.some((r) => r.state === 'running')
  const evs = run ? (events[run.id] ?? []) : []

  return (
    <div className="checksview">
      <div className="parts-head">
        <strong>Gate</strong>
        <span className="mono">{gate ?? 'no gate for this revision'}</span>
        <span style={{ flex: '1 1 auto' }} />
        {window.api.mode === 'desktop' ? (
          <>
            <button type="button" disabled={!gate || running} onClick={() => start(true)}>
              Run gate (fresh)
            </button>
            <button type="button" disabled={!gate || running} onClick={() => start(false)}>
              Run changed checks
            </button>
          </>
        ) : (
          <span style={{ color: 'var(--dim)', fontSize: 12 }}>Gate runs start from the desktop app</span>
        )}
        {run?.state === 'running' ? (
          <button type="button" onClick={() => window.api.engine.call('run.cancel', { id: run.id })}>
            Cancel
          </button>
        ) : null}
      </div>
      {err ? (
        <div className="panel" role="alert" style={{ color: 'var(--err)' }}>
          {err}
        </div>
      ) : null}
      {!run ? (
        <div className="panel placeholder">No gate run yet for this board.</div>
      ) : (
        <div className="parts-body">
          <section className="panel runsummary" aria-label="Run result">
            <div className="row" style={{ alignItems: 'center' }}>
              <span className="dot" style={{ background: STATE_COLOR[run.state] }} />
              <strong role="status" aria-label="Run state">
                {run.state}
              </strong>
              <span className="mono" style={{ color: 'var(--dim)' }}>
                {run.mode} · {run.run_id ?? run.id}
                {run.elapsed_s != null ? ` · ${run.elapsed_s.toFixed(1)} s` : ''}
              </span>
            </div>
            {run.cause ? <p style={{ margin: '8px 0', color: 'var(--muted)' }}>{run.cause}</p> : null}
            {run.metrics ? (
              <table className="metrics">
                <tbody>
                  {Object.entries(run.metrics).map(([k, v]) => (
                    <tr key={k}>
                      <td>{k.replace(/_/g, ' ')}</td>
                      <td
                        className="mono"
                        style={{ color: v === 0 ? 'var(--ok)' : isWarning(k) ? 'var(--dim)' : 'var(--err)' }}
                      >
                        {v}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {mine.length > 1 ? (
              <div style={{ marginTop: 12 }}>
                <h2>Earlier runs</h2>
                {mine.map((r) => (
                  <button key={r.id} type="button" className={r === run ? 'rev on' : 'rev'} onClick={() => setCur(r.id)}>
                    <span style={{ color: STATE_COLOR[r.state] }}>●</span> {new Date(r.started * 1000).toLocaleTimeString()} ·{' '}
                    {r.mode} · {r.state}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
          {findings.length ? (
            <section className="panel findings" aria-label="Findings">
              <h2>Findings ({findings.length})</h2>
              <ul>
                {findings.map((f, i) => (
                  <li key={i}>
                    <button type="button" className="rev" onClick={() => onShowFinding(f)}>
                      <span style={{ color: f.kind === 'unconnected' ? '#f5f5a0' : f.severity === 'error' ? 'var(--err)' : 'var(--warn)' }}>
                        ●
                      </span>{' '}
                      <span className="mono">{f.type}</span> {f.description}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="panel runlog" aria-label="Run events">
            <h2>Events ({evs.length})</h2>
            <pre className="log" style={{ maxHeight: 'none', flex: '1 1 auto' }}>
              {evs.map((e) => line(e)).join('\n')}
            </pre>
          </section>
        </div>
      )}
    </div>
  )
}
