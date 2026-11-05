import { useEffect, useRef, useState } from 'react'
import { applyLiveEvent, emptyLiveState } from '../../../../../job-daemon/src/live-protocol'
import type {
  LiveEvent,
  LiveState,
  LiveTrack,
  LiveVia
} from '../../../../../job-daemon/src/live-protocol'
import type { Geometry } from './types'
import { LiveCanvas } from './LiveCanvas'
import type { InspectSelection } from './LiveCanvas'
import './assets/live.css'
type Packed = Omit<LiveState, 'tracks' | 'vias'> & { tracks: LiveTrack[]; vias: LiveVia[] }
const unpack = (s: Packed): LiveState => ({
  ...s,
  tracks: new Map(s.tracks.map((t) => [t.id, t])),
  vias: new Map(s.vias.map((v) => [v.id, v]))
})
interface Run {
  runId: string
  seq: number
  summary: { run: { label: string }; finished: unknown }
}
export function LiveView({
  selection,
  onSelect
}: {
  selection: InspectSelection | null
  onSelect: (s: InspectSelection | null) => void
}): React.JSX.Element {
  const [runs, setRuns] = useState<Run[]>([]),
    [run, setRun] = useState(''),
    [error, setError] = useState('')
  const [state, setState] = useState<LiveState | null>(null),
    [geo, setGeo] = useState<Geometry | null>(null)
  const [paused, setPaused] = useState(false),
    [head, setHead] = useState(0),
    [compare, setCompare] = useState<LiveState | null>(null)
  const [focus, setFocus] = useState<[number, number, number, number] | null>(null),
    [best, setBest] = useState(false)
  const live = useRef<LiveState | null>(null),
    pausedRef = useRef(false),
    seek = useRef(0)
  useEffect(() => {
    let dead = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async (): Promise<void> => {
      try {
        const r = (await window.api.engine.call('live.runs')) as { runs: Run[] }
        if (!dead) {
          setRuns(r.runs)
          setRun((old) => old || r.runs[0]?.runId || '')
        }
      } catch (e) {
        if (!dead) setError(String(e))
      }
      if (!dead) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      dead = true
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    if (!run) return
    let dead = false,
      dirty = false
    let timer: ReturnType<typeof setTimeout>
    live.current = emptyLiveState(run)
    setState(null)
    setHead(0)
    setGeo(null)
    setCompare(null)
    setPaused(false)
    pausedRef.current = false
    setFocus(null)
    seek.current++
    const receive = (events: LiveEvent[]): void => {
      const s = live.current!
      for (const event of events) {
        if (event.seq <= s.seq) continue
        applyLiveEvent(s, event)
        dirty = true
      }
      setHead((old) => Math.max(old, s.seq))
    }
    const stop = window.api.engine.onNotify((n) => {
      if (dead || n.params.run !== run) return
      if (n.method === 'live.events') {
        try {
          receive(n.params.events as LiveEvent[])
          setError('')
        } catch (e) {
          setError(String(e))
        }
      } else if (n.method === 'live.error') setError(String(n.params.error))
    })
    const paint = setInterval(() => {
      if (dirty && !pausedRef.current) {
        setState(structuredClone(live.current!))
        dirty = false
      }
    }, 100)
    const recover = async (): Promise<void> => {
      try {
        const s = live.current!
        await window.api.engine.call('live.watch', { run, after: s.seq })
        const r = (await window.api.engine.call('live.events', { run, after: s.seq })) as {
          events: LiveEvent[]
          headSeq: number
        }
        if (dead) return
        receive(r.events)
        setHead((old) => Math.max(old, r.headSeq))
        setError('')
      } catch (e) {
        if (!dead) setError(`Reconnecting: ${String(e)}`)
      }
      if (!dead) timer = setTimeout(recover, 2000)
    }
    void recover()
    return () => {
      dead = true
      clearTimeout(timer)
      clearInterval(paint)
      stop()
      void window.api.engine.call('live.unwatch').catch(() => {})
    }
  }, [run])
  useEffect(() => {
    if (!state?.board) return
    let dead = false
    void window.api.engine
      .call('live.geometry', { sha: state.baseSha256 })
      .then((g) => {
        if (!dead) setGeo(g as Geometry)
      })
      .catch((e) => {
        if (!dead) setError(String(e))
      })
    return () => {
      dead = true
    }
  }, [state?.baseSha256, state?.board?.blobSha256])
  const pause = (): void => {
    pausedRef.current = true
    setPaused(true)
  }
  const goLive = (): void => {
    seek.current++
    pausedRef.current = false
    setPaused(false)
    if (live.current) setState(structuredClone(live.current))
  }
  const at = async (n: number): Promise<void> => {
    pause()
    const ticket = ++seek.current
    try {
      const r = (await window.api.engine.call('live.state', { run, at: n })) as { state: Packed }
      if (ticket === seek.current) setState(unpack(r.state))
    } catch (e) {
      setError(String(e))
    }
  }
  const frame = state?.placement
  return (
    <section className="solver-live" aria-label="Solver live view">
      <div className="live-toolbar">
        <label>
          Run{' '}
          <select value={run} onChange={(e) => setRun(e.target.value)}>
            <option value="">Select a recorded run</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.summary.run?.label ?? r.runId}
              </option>
            ))}
          </select>
        </label>
        <button onClick={paused ? goLive : pause}>
          {paused ? 'Return to live' : 'Pause view'}
        </button>
        <span role="status">
          {paused ? 'Viewing history' : state?.finished ? 'Finished' : 'Live'} · {state?.seq ?? 0} /{' '}
          {head}
        </span>
        <label>
          <input type="checkbox" checked={best} onChange={(e) => setBest(e.target.checked)} /> Best
          pose in epoch
        </label>
        <button
          disabled={!state}
          onClick={() => setCompare(compare ? null : structuredClone(state))}
        >
          {compare ? `Clear comparison (#${compare.seq})` : 'Compare this checkpoint'}
        </button>
      </div>
      {error && (
        <p role="alert" className="live-error">
          {error}
        </p>
      )}
      {!run && !error && <p>No recorded solver runs yet.</p>}
      <div className="live-timeline">
        <label htmlFor="live-position">Timeline</label>
        <input
          id="live-position"
          type="range"
          min={1}
          max={Math.max(1, head)}
          value={state?.seq || 1}
          onChange={(e) => void at(Number(e.target.value))}
        />
        <select
          aria-label="Jump to checkpoint"
          value=""
          onChange={(e) => void at(Number(e.target.value))}
        >
          <option value="">Jump to pass / epoch</option>
          {(live.current?.checkpoints ?? []).map((c) => (
            <option key={c.seq} value={c.seq}>
              {c.label} · #{c.seq}
            </option>
          ))}
        </select>
      </div>
      <div className="live-metrics">
        <span>
          {state?.run?.operation ?? 'Solver'} · attempt {state?.attemptId.slice(0, 8)}
        </span>
        {frame && (
          <>
            <span>Component positions · source copper hidden</span>
            <span>
              Worker {frame.worker} · epoch {frame.epoch} · step {frame.step}
            </span>
            <span>
              Current cost {frame.currentCost.toFixed(2)} · best {frame.bestCost.toFixed(2)}
            </span>
            <span>
              {frame.accepted} accepted / {frame.rejected} rejected
            </span>
          </>
        )}
        {state?.activity && (
          <span>
            Pass {state.activity.pass} · {state.activity.net} · {state.activity.action}
          </span>
        )}
        {state?.finished && <span>{state.finished.message}</span>}
      </div>
      <div className="live-workspace">
        {geo && state ? (
          <LiveCanvas
            geo={geo}
            state={state}
            compare={compare}
            selection={selection}
            onSelect={onSelect}
            focus={focus}
            best={best}
          />
        ) : (
          <div className="live-canvas">Waiting for board geometry...</div>
        )}
        <aside className="live-inspector">
          <h3>Linked inspection</h3>
          <p>{selection?.ref ?? selection?.net ?? 'Select a component or net'}</p>
          <label>
            Component{' '}
            <select
              value={selection?.ref ?? ''}
              onChange={(e) => onSelect(e.target.value ? { ref: e.target.value } : null)}
            >
              <option value="">Select</option>
              {geo?.footprints.map((f) => (
                <option key={f.ref}>{f.ref}</option>
              ))}
            </select>
          </label>
          <label>
            Net{' '}
            <select
              value={selection?.net ?? ''}
              onChange={(e) => onSelect(e.target.value ? { net: e.target.value } : null)}
            >
              <option value="">Select</option>
              {[
                ...new Set(geo?.footprints.flatMap((f) => f.pads.map((p) => p.net)).filter(Boolean))
              ]
                .sort()
                .map((n) => (
                  <option key={n}>{n}</option>
                ))}
            </select>
          </label>
          <h3>Failures ({state?.failures.length ?? 0})</h3>
          {state?.failures
            .slice()
            .reverse()
            .map((f) => (
              <button
                className="live-failure"
                key={f.id}
                onClick={() => {
                  setFocus([...f.region])
                  onSelect({ net: f.net })
                }}
              >
                <strong>{f.net}</strong>
                <span>{f.reason}</span>
                <small>{f.rule}</small>
              </button>
            ))}
        </aside>
      </div>
    </section>
  )
}
