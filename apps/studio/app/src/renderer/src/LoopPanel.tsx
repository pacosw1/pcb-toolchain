import { useEffect, useState } from 'react'
import { BoardView } from './BoardView'
import { LiveView } from './LiveView'
import type { Geometry } from './types'

type Move = { kind: string; [key: string]: unknown }
interface Round {
  round: number
  child?: { id: string; folder: string }
  evidence?: {
    state: string
    verified?: boolean
    candidate?: string
    wire_mm?: number
    vias?: number
    cause?: string
  }
  decision?: { reason: string; move: Move }
}
export interface LoopViewState {
  id: string
  root: string
  board: string
  revision: number
  status: string
  cause: string
  deadline_ms: number
  policy: { max_rounds: number; deadline_s: number }
  rounds: Round[]
  best_search: number | null
  best_verified: number | null
}
const terminal = new Set(['passed', 'stopped', 'blocked', 'error', 'cancelled', 'expired'])
const label = (status: string): string =>
  ({
    decision_required: 'Decision needed',
    running: 'Running',
    stopping: 'Stopping',
    passed: 'Verified candidate retained',
    blocked: 'Needs review',
    stopped: 'Stopped',
    expired: 'Time limit reached',
    cancelled: 'Cancelled',
    error: 'Evidence needs review'
  })[status] ?? status

export function LoopPanel({ gate }: { gate: string }): React.JSX.Element {
  const [loops, setLoops] = useState<LoopViewState[]>([]),
    [selected, setSelected] = useState('')
  const [enabled, setEnabled] = useState(false),
    [rounds, setRounds] = useState(3),
    [seconds, setSeconds] = useState(900),
    [sprints, setSprints] = useState(false)
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reason, setReason] = useState('')
  const [move, setMove] = useState('reroute_stuck'),
    [passes, setPasses] = useState(120)
  const [candidate, setCandidate] = useState<Geometry | null>(null),
    [watch, setWatch] = useState<number | null>(null)
  useEffect(() => {
    let dead = false,
      timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const rows = (await window.api.engine.call('loop.list')) as LoopViewState[]
        const mine = rows.filter((x) => x.board === gate)
        const updated = await Promise.all(
          mine.map((x) =>
            terminal.has(x.status)
              ? Promise.resolve(x)
              : (window.api.engine.call('loop.status', { id: x.id }) as Promise<LoopViewState>)
          )
        )
        if (!dead) {
          setLoops(updated)
          setSelected((old) => (updated.some((x) => x.id === old) ? old : (updated[0]?.id ?? '')))
        }
      } catch (e) {
        if (!dead) setError(String(e))
      }
      if (!dead) timer = setTimeout(refresh, 2500)
    }
    void refresh()
    return () => {
      dead = true
      clearTimeout(timer)
    }
  }, [gate])
  const loop = loops.find((x) => x.id === selected) ?? null
  useEffect(() => {
    if (loop && !terminal.has(loop.status) && loop.rounds.length) {
      setWatch(loop.rounds.at(-1)!.round)
      setCandidate(null)
    }
  }, [loop?.id, loop?.rounds.length])
  const update = (s: LoopViewState): void => {
    setLoops((rows) => [s, ...rows.filter((x) => x.id !== s.id)])
    setSelected(s.id)
  }
  const act = async (method: string, params: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      update((await window.api.engine.call(method, params)) as LoopViewState)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  const start = (): void => {
    const route = {
      schema: 'iot-lab.iotroute-policy.v1',
      iters: 80,
      keep: 'all',
      layers: [],
      nets: [],
      ...(sprints
        ? {
            sprints: {
              seeds: [0, 1],
              parallelism: 2,
              deadline_s: Math.min(180, seconds - 20),
              verify_reserve_s: 20,
              mem_gb: 4
            }
          }
        : { max_time_s: Math.min(300, seconds - 20) })
    }
    void act('loop.start', {
      board: gate,
      policy: {
        experimental: true,
        max_rounds: rounds,
        deadline_s: seconds,
        done_when: 'verified',
        route
      }
    })
  }
  const open = async (r: Round): Promise<void> => {
    const path = r.evidence?.candidate
    if (!loop || !path?.startsWith(loop.root + '/')) {
      setError('This candidate is outside the project viewer. Review its recorded CLI run.')
      return
    }
    try {
      setCandidate(
        (await window.api.engine.call('board.geometry', {
          pcb: path.slice(loop.root.length + 1)
        })) as Geometry
      )
      setWatch(null)
    } catch (e) {
      setError(String(e))
    }
  }
  return (
    <section
      className="panel loop-panel"
      aria-label="Experimental routing loop"
      style={{ marginBottom: 12 }}
    >
      <h2>Experimental routing loop</h2>
      <p style={{ color: 'var(--muted)' }}>
        Benchmarks have not shown a speed advantage. Every candidate still needs the complete gate.
      </p>
      <form
        aria-label="Experimental loop policy"
        onSubmit={(e) => {
          e.preventDefault()
          if (enabled) start()
        }}
      >
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />{' '}
            Enable experimental loop
          </label>
          <label>
            Round limit{' '}
            <input
              aria-label="Loop round limit"
              type="number"
              min={1}
              max={8}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              style={{ width: 65 }}
            />
          </label>
          <label>
            Total time (seconds){' '}
            <input
              aria-label="Loop total time"
              type="number"
              min={60}
              max={7200}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
              style={{ width: 85 }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={sprints}
              onChange={(e) => setSprints(e.target.checked)}
            />{' '}
            Packed sprints
          </label>
          <button
            type="submit"
            disabled={!enabled || busy || loops.some((x) => !terminal.has(x.status))}
          >
            Start loop
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" style={{ color: 'var(--err)' }}>
          {error}
        </p>
      )}
      {loops.length > 0 && (
        <label>
          Loop{' '}
          <select
            aria-label="Routing loop"
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value)
              setCandidate(null)
              setWatch(null)
            }}
          >
            {loops.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} · {label(x.status)}
              </option>
            ))}
          </select>
        </label>
      )}
      {loop && (
        <>
          <p role="status" aria-label="Routing loop state">
            <strong>{label(loop.status)}</strong> · {loop.rounds.length} of {loop.policy.max_rounds}{' '}
            rounds
          </p>
          <p>{loop.cause}</p>
          <p style={{ color: 'var(--muted)' }}>
            Search result: {loop.best_search ? `round ${loop.best_search}` : 'none'} · Verified
            candidate: {loop.best_verified ? `round ${loop.best_verified}` : 'none'}
          </p>
          {!terminal.has(loop.status) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('loop.cancel', { id: loop.id })}
            >
              Stop loop
            </button>
          )}
          <table aria-label="Loop round history" style={{ width: '100%', marginTop: 12 }}>
            <thead>
              <tr>
                <th>Round</th>
                <th>Result</th>
                <th>Decision and reason</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {loop.rounds.map((r) => (
                <tr key={r.round}>
                  <td>{r.round}</td>
                  <td>
                    {r.evidence?.verified ? 'Gate verified' : (r.evidence?.state ?? 'Running')}
                  </td>
                  <td>
                    {r.decision ? (
                      <>
                        <strong>
                          {r.decision.move.kind === 'change_setting'
                            ? `${String(r.decision.move.setting)}: ${String(r.decision.move.value)}`
                            : r.decision.move.kind.replaceAll('_', ' ')}
                        </strong>
                        <p>{r.decision.reason}</p>
                      </>
                    ) : (
                      'Initial routing policy'
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        setWatch(r.round)
                        setCandidate(null)
                      }}
                    >
                      Watch round {r.round}
                    </button>
                    {r.evidence?.candidate && (
                      <button type="button" onClick={() => void open(r)}>
                        View candidate {r.round}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loop.status === 'decision_required' && (
            <form
              aria-label="Loop decision"
              onSubmit={(e) => {
                e.preventDefault()
                const choice: Move =
                  move === 'change_setting'
                    ? { kind: move, setting: 'passes', value: passes }
                    : { kind: move }
                void act('loop.decide', {
                  id: loop.id,
                  revision: loop.revision,
                  decision: { reason, move: choice }
                })
              }}
            >
              <p>
                The Studio agent can choose a validated move. A manual decision needs a reason too.
              </p>
              <label>
                Next action{' '}
                <select
                  aria-label="Next loop action"
                  value={move}
                  onChange={(e) => setMove(e.target.value)}
                >
                  <option value="reroute_stuck">Reroute stuck nets</option>
                  <option value="single_reuse">Use single-run reuse after sprints</option>
                  <option value="change_setting">Change pass limit</option>
                  <option value="stop">Stop with evidence</option>
                </select>
              </label>
              {move === 'change_setting' && (
                <label>
                  Pass limit{' '}
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={passes}
                    onChange={(e) => setPasses(Number(e.target.value))}
                  />
                </label>
              )}
              <label>
                Reason{' '}
                <textarea
                  aria-label="Loop decision reason"
                  value={reason}
                  maxLength={2000}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button type="submit" disabled={busy || !reason.trim()}>
                Record decision
              </button>
            </form>
          )}
          {watch !== null && (
            <div role="region" style={{ height: 520 }} aria-label={`Live loop round ${watch}`}>
              <LiveView
                selection={null}
                onSelect={() => undefined}
                preferredLabel={`${loop.id}-r${watch}`}
              />
            </div>
          )}
          {candidate && (
            <div role="region" style={{ height: 420 }} aria-label="Loop candidate preview">
              <BoardView geo={candidate} />
            </div>
          )}
          <p style={{ color: 'var(--muted)', fontSize: 12 }}>
            Candidates are retained in their ordinary CLI runs. Adoption remains an explicit,
            separately verified action.
          </p>
        </>
      )}
    </section>
  )
}
