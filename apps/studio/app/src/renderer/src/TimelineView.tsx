// Timeline: the tool calls of the open board as swimlanes. One lane for each `tools/pcb` command, one tick for each call, on one
// time axis. Studio only reads. The calls come from `.gate/calls.jsonl` (written by tools/pcb), and the engine pushes a new read
// when the file changes (calls.watch). The mapping is in callRows.ts.
import { useEffect, useMemo, useRef, useState } from 'react'
import './assets/timeline.css'
import { ago, buildTimeline, formatDuration } from './callRows'
import type { Call, CallsJson, CallState } from './callRows'

interface Snapshot extends CallsJson {
  rev: number
}

const STATE_LABEL: Record<CallState, string> = {
  ok: 'Passed',
  failed: 'Failed',
  running: 'Running',
  unknown: 'End not recorded'
}
const LIST_STEP = 12
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })
const stamp = (time: number): string => `${day.format(time)} ${clock.format(time)}`
const argsOf = (call: Call): string => call.args.join(' ')

function useCalls(): { snap: Snapshot | null; error: string | null; retry: () => void } {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tries, setTries] = useState(0)
  useEffect(() => {
    let dead = false
    const take = (value: Snapshot): void => {
      setSnap((old) =>
        old && old.rev >= value.rev ? old : { calls: value.calls, runs: value.runs, rev: value.rev }
      )
      setError(null)
    }
    const off = window.api.engine.onNotify((n) => {
      if (dead) return
      if (n.method === 'calls.changed') take(n.params as unknown as Snapshot)
      else if (n.method === 'calls.error') setError(String(n.params.error))
    })
    window.api.engine
      .call('calls.watch')
      .then((result) => {
        if (!dead) take(result as Snapshot)
      })
      .catch((e) => {
        if (!dead) setError(String(e))
      })
    return () => {
      dead = true
      off()
      window.api.engine.call('calls.unwatch').catch(() => undefined) // a dead engine has no watch left
    }
  }, [tries])
  return { snap, error, retry: () => setTries((n) => n + 1) }
}

/** The clock of the axis. It only moves the right edge and the ages; the data is pushed. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function Mark({ state }: { state: CallState }): React.JSX.Element {
  return <span className="call-dot" data-state={state} aria-hidden="true" />
}

function Empty({
  title,
  children,
  alert,
  action
}: {
  title: string
  children: React.ReactNode
  alert?: boolean
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      className="calls calls-empty"
      aria-label="Tool calls"
      role={alert ? 'alert' : undefined}
    >
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M4 8h40M4 16h40M4 24h40" />
        <path className="ticks" d="M10 5v6M22 13v6M34 21v6M16 21v6M38 5v6" />
      </svg>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </section>
  )
}

export function TimelineView({
  board,
  onOpen
}: {
  board: string | null
  onOpen: (tab: 'runs') => void
}): React.JSX.Element {
  const { snap, error, retry } = useCalls()
  const live = useNow()
  const [opened] = useState(() => Date.now())
  const [frozen, setFrozen] = useState<{ snap: Snapshot | null; now: number } | null>(null)
  const [head, setHead] = useState<number | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [more, setMore] = useState(LIST_STEP)
  const plot = useRef<HTMLDivElement>(null)

  const paused = frozen !== null
  const shown = paused ? frozen.snap : snap
  const now = paused ? frozen.now : live
  const timeline = useMemo(
    () => (board && shown ? buildTimeline(shown, { board, now, head }) : null),
    [shown, board, now, head]
  )

  if (!board)
    return (
      <Empty title="No tool calls for this board">
        The board has no gate name. Add a gate to the board registry to see its tool calls.
      </Empty>
    )
  if (!timeline)
    return error ? (
      <Empty
        alert
        title="The tool calls cannot be read"
        action={
          <button type="button" onClick={retry}>
            Try again
          </button>
        }
      >
        {error}
      </Empty>
    ) : (
      <section
        className="calls calls-loading"
        aria-label="Tool calls"
        role="status"
        aria-busy="true"
      >
        <p className="calls-sub">Reading the tool calls of {board}…</p>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="lane-skeleton" aria-hidden="true" />
        ))}
      </section>
    )
  if (!timeline.totals.calls)
    return (
      <Empty title="No tool calls recorded yet">
        Every call of <code>tools/pcb</code> that names {board} is added to{' '}
        <code>.gate/calls.jsonl</code> and shows here at once. Run a command, such as{' '}
        <code>tools/pcb state {board}</code>, and its tick appears.
      </Empty>
    )

  const picture = timeline.calls.find((call) => call.id === picked) ?? null
  const waiting = paused && snap !== null && frozen.snap !== null && snap.rev > frozen.snap.rev
  const resume = (): void => {
    setFrozen(null)
    setHead(null)
  }
  const place = (event: React.MouseEvent<HTMLDivElement>): void => {
    const box = plot.current?.getBoundingClientRect()
    if (!box || !box.width) return
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    setFrozen((old) => old ?? { snap, now: live })
    setHead(timeline.from + fraction * (timeline.to - timeline.from))
  }
  const headX =
    head === null
      ? 1
      : Math.min(1, Math.max(0, (head - timeline.from) / (timeline.to - timeline.from)))
  const list = timeline.calls.slice(0, more)

  return (
    <section className="calls" aria-label="Tool calls">
      <header className="calls-head">
        <button
          type="button"
          className="calls-play"
          onClick={paused || head !== null ? resume : () => setFrozen({ snap, now: live })}
          aria-label={paused || head !== null ? 'Follow live calls' : 'Pause live updates'}
          title={paused || head !== null ? 'Follow live calls' : 'Pause live updates'}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {paused || head !== null ? (
              <path d="M4 2.5v11l9-5.5z" />
            ) : (
              <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
            )}
          </svg>
        </button>
        <div className="calls-state" role="status">
          {paused ? (
            <>
              <b>Paused</b>
              {waiting ? <span className="calls-new">new calls waiting</span> : null}
            </>
          ) : (
            <>
              <span className="calls-live" aria-hidden="true" />
              <b>Live</b>
            </>
          )}
        </div>
        <div className="calls-range">
          <b>{board}</b>
          <span>
            {stamp(timeline.from)} to {clock.format(timeline.to)}
          </span>
        </div>
      </header>

      {error ? (
        <p className="calls-warn" role="alert">
          The last read failed, so this view may be old: {error}
        </p>
      ) : null}

      <div className="chart" aria-label="Tool calls over time">
        <ul className="lanes">
          {timeline.lanes.map((lane) => (
            <li key={lane.command} className="lane">
              <span className="lane-name">{lane.command}</span>
              <div
                className="lane-track"
                role="group"
                aria-label={`${lane.command}: ${lane.count} calls`}
              >
                {lane.ticks.map((tick) => {
                  const call = timeline.calls.find((c) => c.id === tick.id)!
                  return (
                    <button
                      key={tick.id}
                      type="button"
                      className={`tick${call.start > opened ? ' tick-new' : ''}${picked === tick.id ? ' tick-picked' : ''}`}
                      data-state={tick.state}
                      data-dim={tick.dim || undefined}
                      data-edge={tick.x > 0.7 ? 'right' : undefined}
                      style={{ left: `${tick.x * 100}%` }}
                      onClick={() => setPicked(picked === tick.id ? null : tick.id)}
                      aria-label={`${call.command} ${argsOf(call)}: ${STATE_LABEL[call.state]}`}
                      aria-pressed={picked === tick.id}
                    >
                      <span className="tip" role="tooltip">
                        <b>{call.command}</b> <code>{argsOf(call) || 'no arguments'}</code>
                        <span>
                          {STATE_LABEL[call.state]}
                          {call.exit !== null ? `, exit ${call.exit}` : ''}
                          {call.signal ? `, signal ${call.signal}` : ''} ·{' '}
                          {formatDuration(call.duration)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
              <span
                className="lane-count"
                title={lane.failed ? `${lane.failed} failed` : undefined}
              >
                {lane.count}
                {lane.failed ? <i>{lane.failed}</i> : null}
              </span>
            </li>
          ))}
        </ul>
        <div className="overlay">
          <div ref={plot} className="plot" onClick={place} title="Click to move the play head">
            {timeline.marks.map((mark) => (
              <span
                key={mark.id}
                className="mark"
                style={{ left: `${mark.x * 100}%` }}
                title={`Run ${mark.id} started`}
              />
            ))}
            <span className="head" style={{ left: `${headX * 100}%` }} />
          </div>
        </div>
      </div>

      <p className="calls-legend" aria-label="Legend">
        <span>
          <Mark state="ok" /> passed
        </span>
        <span>
          <Mark state="failed" /> failed
        </span>
        <span>
          <Mark state="running" /> running
        </span>
        <span>
          <Mark state="unknown" /> end not recorded
        </span>
        <span>
          <i className="mark-key" /> a run started
        </span>
        <span>The pale line is the play head. Click the chart to move it.</span>
      </p>

      {picture ? (
        <div className="detail" data-state={picture.state}>
          <header>
            <Mark state={picture.state} />
            <b>{picture.command}</b>
            <span>{STATE_LABEL[picture.state]}</span>
            <button type="button" onClick={() => setPicked(null)} aria-label="Close the details">
              Close
            </button>
          </header>
          <dl>
            <dt>Arguments</dt>
            <dd>
              <code>{argsOf(picture) || 'none'}</code>
            </dd>
            <dt>Started</dt>
            <dd>{stamp(picture.start)}</dd>
            <dt>Duration</dt>
            <dd>{formatDuration(picture.duration)}</dd>
            <dt>Result</dt>
            <dd>
              {picture.state === 'unknown' || picture.state === 'running'
                ? 'No end was recorded, so the result is not known.'
                : picture.signal
                  ? `Stopped by signal ${picture.signal}`
                  : `Exit code ${picture.exit}`}
            </dd>
            {picture.caller ? (
              <>
                <dt>Caller</dt>
                <dd>{picture.caller}</dd>
              </>
            ) : null}
            <dt>Run</dt>
            <dd>
              {picture.run ? (
                <>
                  <code>{picture.run}</code>{' '}
                  <button type="button" onClick={() => onOpen('runs')}>
                    Open the Runs tab
                  </button>
                </>
              ) : (
                'This call started no run.'
              )}
            </dd>
          </dl>
        </div>
      ) : null}

      <ol className="calls-list" aria-label="Newest calls first">
        {list.map((call, index) => (
          <li
            key={call.id}
            className={call.start > opened ? 'row-new' : undefined}
            data-newest={index === 0 || undefined}
          >
            <button
              type="button"
              data-picked={picked === call.id || undefined}
              onClick={() => setPicked(call.id)}
            >
              <span className="row-age">{ago(Math.max(0, now - call.start))}</span>
              <Mark state={call.state} />
              <b>{call.command}</b>
              <code>{argsOf(call)}</code>
              <span className="row-time">
                {call.state === 'running' ? 'running' : formatDuration(call.duration)}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {timeline.calls.length > list.length ? (
        <button type="button" className="calls-more" onClick={() => setMore((n) => n + LIST_STEP)}>
          Show {Math.min(LIST_STEP, timeline.calls.length - list.length)} more
        </button>
      ) : null}

      <footer className="calls-foot">
        <span>
          <b>{timeline.totals.calls}</b> calls
        </span>
        <span>
          <b>{timeline.totals.failed}</b> failed
        </span>
        {timeline.totals.unfinished ? (
          <span>
            <b>{timeline.totals.unfinished}</b> with no end
          </span>
        ) : null}
        <span>
          <b>{timeline.totals.runs}</b> runs started
        </span>
        <span>
          <b>{formatDuration(timeline.totals.span)}</b> shown
        </span>
      </footer>
    </section>
  )
}
