// Candidate runs (phase 5): every run of the board (check / build / route), Build and Route actions, and the review
// of a candidate: its board next to the current one, its gate metrics against the latest check, and Adopt.
// The engine wraps tools/pcb; the candidate stays in .gate/cli/RUN_ID/workspace/ until the user adopts it.
import { useEffect, useMemo, useState } from 'react'
import { BoardView } from './BoardView'
import { isWarning, line, STATE_COLOR, type Ev, type RunSummary } from './runs'
import type { Geometry } from './types'
import './assets/runs.css'

const OP_LABEL: Record<string, string> = { check: 'check', build: 'build', route: 'route' }

function metricColor(k: string, v: number | undefined): string {
  if (v == null) return 'var(--dim)'
  return v === 0 ? 'var(--ok)' : isWarning(k) ? 'var(--dim)' : 'var(--err)'
}

function RouteForm({
  layers,
  disabled,
  onStart
}: {
  layers: string[]
  disabled: boolean
  onStart: (policy: Record<string, unknown>) => void
}): React.JSX.Element {
  const [on, setOn] = useState<string[]>(layers)
  const [nets, setNets] = useState('')
  const [iters, setIters] = useState(80)
  const [timeout, setTimeout_] = useState(300)
  const [keep, setKeep] = useState('lock-nets')
  const toggle = (l: string): void =>
    setOn((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))
  const netList = nets
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
  return (
    <form
      className="panel routeform"
      aria-label="Route policy"
      onSubmit={(e) => {
        e.preventDefault()
        // Every layer on asks for no limit: the board's own rules still narrow each net.
        onStart({
          iters,
          timeout_s: timeout,
          keep,
          layers: on.length === layers.length ? [] : on,
          nets: netList
        })
      }}
    >
      <h2>Route (iotroute)</h2>
      <fieldset>
        <legend>Layers</legend>
        {layers.map((l) => (
          <label key={l} className="check">
            <input type="checkbox" checked={on.includes(l)} onChange={() => toggle(l)} /> {l}
          </label>
        ))}
      </fieldset>
      <label>
        <span>Nets (optional; empty = every net; with a list, keep all copper)</span>
        <textarea
          rows={3}
          value={nets}
          placeholder="/SPI_CLK, /SPI_MOSI"
          onChange={(e) => setNets(e.target.value)}
        />
      </label>
      <div className="row">
        <label>
          <span>Iterations</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={iters}
            onChange={(e) => setIters(Number(e.target.value))}
          />
        </label>
        <label>
          <span>Router timeout (s)</span>
          <input
            type="number"
            min={1}
            value={timeout}
            onChange={(e) => setTimeout_(Number(e.target.value))}
          />
        </label>
        <label>
          <span>Keep</span>
          <select value={keep} onChange={(e) => setKeep(e.target.value)}>
            <option value="lock-nets">Pair and crystal copper</option>
            <option value="all">All copper</option>
          </select>
        </label>
      </div>
      <p className="hint">
        Policy iot-lab.iotroute-policy.v1. The candidate then gets the complete fresh gate; the CLI
        deadline is the router timeout + 600 s.
      </p>
      <button
        type="submit"
        disabled={disabled || !on.length || iters < 1 || iters > 1000 || timeout < 1}
      >
        Start route
      </button>
    </form>
  )
}

function AdoptDialog({
  run,
  onCancel,
  onDone
}: {
  run: RunSummary
  onCancel: () => void
  onDone: (receipt: Record<string, unknown>) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const target = run.candidate?.target ?? '?'
  const adopt = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      onDone((await window.api.engine.call('run.adopt', { id: run.id })) as Record<string, unknown>)
    } catch (e) {
      setErr(String(e))
      setBusy(false)
    }
  }
  return (
    <div className="modal-back">
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="adopt-title">
        <h2 id="adopt-title">Adopt candidate {run.run_id}?</h2>
        <p>This replaces the board file</p>
        <p className="mono target">{target}</p>
        <p style={{ color: 'var(--muted)' }}>
          tools/pcb adopt verifies the sealed candidate, its evidence and the unchanged inputs
          again, keeps a backup of the original in the run folder, and replaces only this PCB file.
          Commit the result in git.
        </p>
        {err ? (
          <p role="alert" style={{ color: 'var(--err)' }}>
            {err}
          </p>
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={adopt} disabled={busy} autoFocus>
            {busy ? 'Adopting…' : 'Replace board file'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function RunsView({
  gate,
  current,
  onAdopted
}: {
  gate: string | null
  current: Geometry
  onAdopted: () => void
}): React.JSX.Element {
  const desktop = window.api.mode === 'desktop'
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, Ev[]>>({})
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState(false)
  const [show, setShow] = useState<'candidate' | 'current'>('candidate')
  const [cand, setCand] = useState<{ pcb: string; geo: Geometry } | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    window.api.engine
      .call('run.list')
      .then((r) => setRuns(r as RunSummary[]))
      .catch(() => undefined)
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

  const mine = useMemo(
    () => runs.filter((r) => r.board === gate).sort((a, b) => b.started - a.started),
    [runs, gate]
  )
  const run = mine.find((r) => r.id === cur) ?? mine[0] ?? null
  const lastCheck =
    mine.find((r) => (r.op ?? 'check') === 'check' && r.state !== 'running' && r.metrics) ?? null
  const busy = mine.some((r) => r.state === 'running')

  useEffect(() => {
    if (!run || events[run.id]) return
    window.api.engine
      .call('run.get', { id: run.id })
      .then((r) => setEvents((m) => ({ ...m, [run.id]: (r as { events: Ev[] }).events })))
      .catch(() => undefined)
  }, [run, events])

  // Candidate geometry of the shown run, once its candidate file exists.
  const candPcb = run?.candidate?.exists ? run.candidate.pcb : null
  useEffect(() => {
    if (!candPcb || cand?.pcb === candPcb) return
    window.api.engine
      .call('board.geometry', { pcb: candPcb })
      .then((g) => {
        setCand({ pcb: candPcb, geo: g as Geometry })
        setShow('candidate')
      })
      .catch((e) => setErr(String(e)))
  }, [candPcb, cand?.pcb])

  const start = async (
    method: 'op.build' | 'op.route' | 'gate.check',
    params: Record<string, unknown>
  ): Promise<void> => {
    setErr(null)
    setNote(null)
    try {
      const s = (await window.api.engine.call(method, params)) as RunSummary
      setRuns((rs) => [s, ...rs.filter((r) => r.id !== s.id)])
      // A comparison check keeps the candidate under review; a new build/route becomes the shown run.
      if (method === 'gate.check') setCur((c) => c ?? run?.id ?? null)
      else setCur(s.id)
      setForm(false)
    } catch (e) {
      setErr(String(e))
    }
  }

  const evs = run ? (events[run.id] ?? []) : []
  const candMetrics = run?.candidate?.metrics ?? null
  const keys = [
    ...new Set([...Object.keys(candMetrics ?? {}), ...Object.keys(lastCheck?.metrics ?? {})])
  ]
  const geoShown =
    run?.candidate && cand?.pcb === candPcb && show === 'candidate' ? cand.geo : current

  return (
    <div className="checksview runsview">
      <div className="parts-head">
        <strong>Runs</strong>
        <span className="mono">{gate ?? 'no gate for this revision'}</span>
        <span style={{ flex: '1 1 auto' }} />
        {desktop ? (
          <>
            <button
              type="button"
              disabled={!gate || busy}
              onClick={() => start('op.build', { board: gate })}
            >
              Build
            </button>
            <button
              type="button"
              disabled={!gate || busy}
              aria-expanded={form}
              onClick={() => setForm((f) => !f)}
            >
              Route…
            </button>
          </>
        ) : (
          <span style={{ color: 'var(--dim)', fontSize: 12 }}>
            Build, route and adopt start from the desktop app
          </span>
        )}
        {desktop && run?.state === 'running' ? (
          <button
            type="button"
            onClick={() => window.api.engine.call('run.cancel', { id: run.id })}
          >
            Cancel
          </button>
        ) : null}
      </div>
      {err ? (
        <div className="panel" role="alert" style={{ color: 'var(--err)' }}>
          {err}
        </div>
      ) : null}
      {note ? (
        <div className="panel" role="status" style={{ color: 'var(--ok)' }}>
          {note}
        </div>
      ) : null}
      {desktop && form && gate ? (
        <RouteForm
          layers={current.layers.filter((l) => l.endsWith('.Cu'))}
          disabled={busy}
          onStart={(policy) => start('op.route', { board: gate, policy })}
        />
      ) : null}
      {!run ? (
        <div className="panel placeholder">No run yet for this board.</div>
      ) : (
        <div className="parts-body">
          <section className="panel runsummary" aria-label="Runs list">
            <h2>All runs ({mine.length})</h2>
            {mine.map((r) => (
              <button
                key={r.id}
                type="button"
                className={r === run ? 'rev on' : 'rev'}
                onClick={() => setCur(r.id)}
              >
                <span style={{ color: STATE_COLOR[r.state] }}>●</span>{' '}
                {new Date(r.started * 1000).toLocaleTimeString()} · {OP_LABEL[r.op ?? 'check']}{' '}
                {r.op === 'check' || !r.op ? `(${r.mode})` : ''} · {r.state}
                {r.adoption ? ' · adopted' : ''}
              </button>
            ))}
          </section>
          <section className="panel candidate" aria-label="Run review">
            <div className="row" style={{ alignItems: 'center' }}>
              <span className="dot" style={{ background: STATE_COLOR[run.state] }} />
              <strong role="status" aria-label="Candidate run state">
                {OP_LABEL[run.op ?? 'check']} · {run.state}
              </strong>
              <span className="mono" style={{ color: 'var(--dim)' }}>
                {run.run_id ?? run.id}
                {run.elapsed_s != null ? ` · ${run.elapsed_s.toFixed(1)} s` : ''}
              </span>
            </div>
            {run.cause ? (
              <p style={{ margin: '8px 0', color: 'var(--muted)' }}>{run.cause}</p>
            ) : null}
            {run.candidate ? (
              <>
                <dl className="kv">
                  <dt>Candidate</dt>
                  <dd>{run.candidate.pcb}</dd>
                  <dt>Replaces</dt>
                  <dd>{run.candidate.target ?? '—'}</dd>
                  <dt>Gate-verified</dt>
                  <dd style={{ color: run.candidate.verified ? 'var(--ok)' : 'var(--err)' }}>
                    {run.candidate.verified ? 'yes' : 'no'}
                    {run.candidate.identity_preserved === false ? ' · design identity changed' : ''}
                  </dd>
                </dl>
                <table className="metrics" aria-label="Candidate metrics">
                  <thead>
                    <tr>
                      <td>metric</td>
                      <td>candidate</td>
                      <td>current{lastCheck ? '' : ' (no check)'}</td>
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => {
                      const c = candMetrics?.[k]
                      const b = lastCheck?.metrics?.[k]
                      return (
                        <tr key={k}>
                          <td>{k.replace(/_/g, ' ')}</td>
                          <td className="mono" style={{ color: metricColor(k, c) }}>
                            {c ?? '—'}
                            {c != null && b != null && c !== b ? (c < b ? ' ↓' : ' ↑') : ''}
                          </td>
                          <td className="mono" style={{ color: metricColor(k, b) }}>
                            {b ?? '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {!lastCheck && desktop ? (
                  <button
                    type="button"
                    className="rev"
                    disabled={busy || !gate}
                    onClick={() => start('gate.check', { board: gate, fresh: false })}
                  >
                    Run a check of the current board to compare
                  </button>
                ) : null}
                {run.adoption ? (
                  <p style={{ color: 'var(--ok)' }}>Adopted into {run.candidate.target}.</p>
                ) : desktop ? (
                  <div className="row" style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      className="danger"
                      disabled={!run.adoptable}
                      title={
                        run.adoptable
                          ? undefined
                          : 'Only a passed run with a gate-verified candidate can be adopted'
                      }
                      onClick={() => setConfirm(true)}
                    >
                      Adopt…
                    </button>
                  </div>
                ) : null}
              </>
            ) : run.state !== 'running' && run.op && run.op !== 'check' ? (
              <p style={{ color: 'var(--dim)' }}>This run produced no candidate board.</p>
            ) : null}
            <h2 style={{ marginTop: 12 }}>Events ({evs.length})</h2>
            <pre className="log">{evs.map((e) => line(e)).join('\n')}</pre>
          </section>
          {run.candidate?.exists ? (
            <section className="panel candview" aria-label="Candidate board">
              <div className="row" role="group" aria-label="Show board">
                {(['candidate', 'current'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={show === k ? 'rev on' : 'rev'}
                    aria-pressed={show === k}
                    onClick={() => setShow(k)}
                  >
                    {k === 'candidate' ? 'Candidate' : 'Current'}
                  </button>
                ))}
                <span
                  className="mono"
                  style={{ color: 'var(--dim)', fontSize: 12, alignSelf: 'center' }}
                >
                  {geoShown.tracks.length} tracks · {geoShown.vias.length} vias
                </span>
              </div>
              <BoardView geo={geoShown} />
            </section>
          ) : null}
        </div>
      )}
      {confirm && run ? (
        <AdoptDialog
          run={run}
          onCancel={() => setConfirm(false)}
          onDone={(r) => {
            setConfirm(false)
            setNote(
              `Adopted ${run.run_id}: ${String(r.target ?? run.candidate?.target)} replaced (backup in the run folder).`
            )
            onAdopted()
          }}
        />
      ) : null}
    </div>
  )
}
