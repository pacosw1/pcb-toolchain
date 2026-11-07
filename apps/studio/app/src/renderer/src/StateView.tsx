// Stages: the state machine of the open board as a vertical trace. Studio only reads. The rows come from `pcb state` and
// `pcb history` (stateRows.ts), and the engine pushes a new read when the board files change (state.watch).
// Trace, TraceItem, TraceLine and TraceCollapsible are plain parts in the shape of the shadcn-svelte Trace.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import './assets/state.css'
import { runsOfBoard } from './live-runs'
import type { RunSummary } from './runs'
import { buildRows, formatSize, STATUSES } from './stateRows'
import type { HistoryJson, ItemJson, LogLine, Row, StateJson, Status } from './stateRows'

const LABEL: Record<Status, string> = {
  done: 'Done',
  running: 'Here now',
  blocked: 'Blocked',
  stale: 'Stale',
  person: 'Waits for a person',
  pending: 'Not reached',
  unproven: 'Not proven'
}
const HINT: Record<Status, string> = {
  done: 'The evidence is current.',
  running: 'The board is at this stage.',
  blocked: 'The board is here and the next step is refused or cannot be read.',
  stale: 'The evidence is out of date.',
  person: 'A person must approve before the board goes on.',
  pending: 'The board has not reached this stage.',
  unproven: 'The board is past this stage, but no saved result shows that the stage passed.'
}

interface Snapshot {
  state: StateJson
  history: HistoryJson
  rev: number
}
interface LiveRun {
  runId: string
  summary: { run: { board?: string; label?: string } | null }
}

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const clock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' })
const within = (path: string, root: string | null): string =>
  root && path.startsWith(root + '/') ? path.slice(root.length + 1) : path

// ---- the trace parts ------------------------------------------------------------------------------------------------

const NODE: Record<Status, string> = {
  done: 'M7 12.5l3.2 3.2L17 9',
  running: 'M12 4a8 8 0 0 1 8 8',
  blocked: 'M12 7.5v5.5M12 16.5h.01',
  stale: 'M12 7.5V12l3 2',
  person:
    'M12 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM7.5 17.5c.6-2.3 2.4-3.5 4.5-3.5s3.9 1.2 4.5 3.5',
  pending: '',
  unproven: ''
}

function TraceIcon({ status }: { status: Status }): React.JSX.Element {
  return (
    <svg
      className="trace-icon"
      data-status={status}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" className="ring" />
      {NODE[status] ? <path d={NODE[status]} className="mark" /> : null}
    </svg>
  )
}

function Trace({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ol className="trace" aria-label={label}>
      {children}
    </ol>
  )
}

/** The line of one row: icon, title, description and secondary text. The secondary text is never cut. */
function TraceLine({
  status,
  title,
  description,
  meta
}: {
  status: Status
  title: string
  description?: string | null
  meta?: string
}): React.JSX.Element {
  return (
    <span className="trace-line" data-status={status}>
      <TraceIcon status={status} />
      <span className="trace-text">
        <span className="trace-title">{title}</span>
        {description ? <span className="trace-desc">{description}</span> : null}
      </span>
      {meta ? <span className="trace-meta">{meta}</span> : null}
    </span>
  )
}

/** Closed by default, and open while `running`, unless the person has chosen: `open` is the same as in the Svelte part (open ?? running). */
function TraceCollapsible({
  status,
  here,
  open,
  running,
  line,
  peek,
  children
}: {
  status: Status
  here?: boolean
  open?: boolean
  running: boolean
  line: React.ReactNode
  peek?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const [chosen, setChosen] = useState<boolean | null>(null)
  // A row that changes status pulses once: the overlay is new on each change, so its animation starts again.
  const [seen, setSeen] = useState(status)
  const [flash, setFlash] = useState(0)
  if (seen !== status) {
    setSeen(status)
    setFlash((n) => n + 1)
  }
  const id = useId()
  const shown = chosen ?? open ?? running
  return (
    <li className="trace-item" data-status={status} aria-current={here ? 'step' : undefined}>
      <button
        type="button"
        className="trace-trigger"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setChosen(!shown)}
      >
        {flash ? <span key={flash} className="trace-flash" aria-hidden="true" /> : null}
        {line}
        {peek}
        <svg
          className="trace-chevron"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      <div id={id} className="trace-content" hidden={!shown}>
        {shown ? children : null}
      </div>
    </li>
  )
}

// ---- the detail of one row ------------------------------------------------------------------------------------------

function Items({
  title,
  items,
  root,
  missing
}: {
  title: string
  items: ItemJson[]
  root: string | null
  missing: string
}): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <section className="trace-items">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            <span className="item-name">{item.name}</span>
            {item.path ? (
              <code className="item-path">{within(item.path, root)}</code>
            ) : item.template ? (
              <span className="item-note">needs a run</span>
            ) : null}
            {item.path && item.exists && item.size !== undefined ? (
              <span className="item-size">{formatSize(item.size)}</span>
            ) : null}
            {item.path && !item.exists ? <span className="item-note warn">{missing}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Log({ lines }: { lines: LogLine[] }): React.JSX.Element {
  return (
    <section className="trace-log">
      <h3>Log of this stage</h3>
      <ul>
        {lines.map((line) => (
          <li key={line.id}>
            <span className="log-when" title={line.at ?? undefined}>
              {line.at ? time.format(new Date(line.at)) : 'no time, in log order'}
            </span>
            <span className="log-who">{line.by ?? 'tool'}</span>
            <code className="log-type">
              {line.source} {line.type}
            </code>
            {line.summary ? <span className="log-what">{line.summary}</span> : null}
            {line.cause ? <pre className="log-cause">{line.cause}</pre> : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Detail({
  row,
  root,
  runs,
  live,
  onImage,
  onOpen
}: {
  row: Row
  root: string | null
  runs: RunSummary[]
  live: LiveRun[]
  onImage: (path: string, name: string) => void
  onOpen: (tab: 'runs' | 'live') => void
}): React.JSX.Element {
  const names = new Map(row.outputs.concat(row.inputs).map((item) => [item.path, item.name]))
  return (
    <div className="trace-body">
      {row.why ? <p className={`trace-why ${row.status}`}>{row.why}</p> : null}
      {row.reopened.map((note) => (
        <p key={note.text} className="trace-reopen">
          <b>
            {note.pending ? 'A change opened this stage.' : 'The last change opened this stage.'}
          </b>{' '}
          {note.text}
        </p>
      ))}
      {row.here && (runs.length || live.length) ? (
        <div className="trace-run">
          {runs.map((run) => (
            <span key={run.id}>
              Run <code>{run.run_id ?? run.id}</code> ({run.op}, {run.state})
            </span>
          ))}
          {live.map((run) => (
            <span key={run.runId}>
              Live run <code>{run.runId}</code>
            </span>
          ))}
          {runs.length ? (
            <button type="button" onClick={() => onOpen('runs')}>
              Open the Runs view
            </button>
          ) : null}
          {live.length ? (
            <button type="button" onClick={() => onOpen('live')}>
              Open the Live view
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="trace-io">
        <Items title="Needs" items={row.inputs} root={root} missing="not found" />
        <Items title="Made" items={row.outputs} root={root} missing="not made yet" />
      </div>
      {row.images.length ? (
        <ul className="trace-thumbs" aria-label="Images">
          {row.images.map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => onImage(path, names.get(path) ?? path)}
                aria-label={`Open ${names.get(path) ?? path} larger`}
              >
                <img src={window.api.fileUrl(path)} alt={names.get(path) ?? path} loading="lazy" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {row.log.length ? (
        <Log lines={row.log} />
      ) : (
        <p className="trace-none">No log line names this stage.</p>
      )}
      {row.back.length ? (
        <p className="trace-back">
          Goes back:{' '}
          {row.back.map((edge) => (
            <span key={`${edge.to}-${edge.on}`}>
              <code>{edge.to}</code> on {edge.on}
            </span>
          ))}
        </p>
      ) : null}
      {row.gap ? <p className="trace-gap">Not covered yet by the tools: {row.gap}</p> : null}
    </div>
  )
}

// ---- data -----------------------------------------------------------------------------------------------------------

function useStages(board: string | null): {
  snap: Snapshot | null
  error: string | null
  at: number | null
  retry: () => void
} {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [tries, setTries] = useState(0)
  // The view is keyed by the board, so a new board starts with empty state.
  useEffect(() => {
    if (!board) return
    let dead = false
    const take = (value: Snapshot): void => {
      setSnap((old) =>
        old && old.rev >= value.rev
          ? old
          : { state: value.state, history: value.history, rev: value.rev }
      )
      setAt(Date.now())
      setError(null)
    }
    const off = window.api.engine.onNotify((n) => {
      if (dead || n.params.board !== board) return
      if (n.method === 'state.changed') take(n.params as unknown as Snapshot)
      else if (n.method === 'state.error') setError(String(n.params.error))
    })
    window.api.engine
      .call('state.watch', { board })
      .then((result) => {
        if (!dead) take(result as Snapshot)
      })
      .catch((e) => {
        if (!dead) setError(String(e))
      })
    return () => {
      dead = true
      off()
      window.api.engine.call('state.unwatch', { board }).catch(() => undefined) // a dead engine has no watch left
    }
  }, [board, tries])
  return { snap, error, at, retry: () => setTries((n) => n + 1) }
}

/** The runs of this board that work now: local runs by their notifications, and the solver runs of the live coordinator. */
function useActive(
  board: string | null,
  pcb: string | null,
  rev: number | null
): { runs: RunSummary[]; live: LiveRun[] } {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [live, setLive] = useState<LiveRun[]>([])
  useEffect(() => {
    window.api.engine
      .call('run.list')
      .then((r) => setRuns(r as RunSummary[]))
      .catch(() => undefined)
    return window.api.engine.onNotify((n) => {
      if (n.method !== 'run.state') return
      const s = n.params as unknown as RunSummary
      setRuns((old) => [s, ...old.filter((r) => r.id !== s.id)])
    })
  }, [])
  useEffect(() => {
    let dead = false
    window.api.engine
      .call('live.runs')
      .then((r) => {
        if (!dead) setLive(runsOfBoard((r as { runs: LiveRun[] }).runs, pcb))
      })
      .catch(() => {
        if (!dead) setLive([])
      }) // no coordinator is configured: there is no live run to show
    return () => {
      dead = true
    }
  }, [pcb, rev])
  return {
    runs: useMemo(
      () => runs.filter((r) => r.board === board && r.state === 'running'),
      [runs, board]
    ),
    live
  }
}

// ---- the view -------------------------------------------------------------------------------------------------------

export function StateView({
  board,
  pcb,
  root,
  onOpen
}: {
  board: string | null
  pcb: string | null
  root: string | null
  onOpen: (tab: 'runs' | 'live') => void
}): React.JSX.Element {
  const { snap, error, at, retry } = useStages(board)
  const { runs, live } = useActive(board, pcb, snap?.rev ?? null)
  const active = runs.length > 0 || live.length > 0
  const result = useMemo(
    () => (snap ? buildRows(snap.state, snap.history, { active }) : null),
    [snap, active]
  )
  const [image, setImage] = useState<{ path: string; name: string } | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (image && !element.open) element.showModal()
    if (!image && element.open) element.close()
  }, [image])

  if (!board)
    return (
      <section className="stages stages-empty" aria-label="Stages">
        <TraceIcon status="pending" />
        <h2>No stages for this board</h2>
        <p>The board has no gate name. Add a gate to the board registry to see its stages.</p>
      </section>
    )
  if (!result) {
    return error ? (
      <section className="stages stages-empty" aria-label="Stages" role="alert">
        <TraceIcon status="blocked" />
        <h2>The stages cannot be read</h2>
        <p>{error}</p>
        <button type="button" onClick={retry}>
          Try again
        </button>
      </section>
    ) : (
      <section className="stages stages-loading" aria-label="Stages" role="status" aria-busy="true">
        <p className="stages-at">Reading the stages of {board}…</p>
        <ol className="trace" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i} className="trace-item skeleton" />
          ))}
        </ol>
      </section>
    )
  }
  const here = result.rows.find((row) => row.here)
  const stages = result.rows.filter((row) => row.group === 'stage'),
    rules = result.rows.filter((row) => row.group === 'rule')
  const renderRow = (row: Row): React.JSX.Element => (
    <TraceCollapsible
      key={row.id}
      status={row.status}
      here={row.here}
      running={row.here}
      peek={
        row.images.length ? (
          <span className="trace-peek" aria-hidden="true">
            {row.images.slice(0, 3).map((path) => (
              <img key={path} src={window.api.fileUrl(path)} alt="" loading="lazy" />
            ))}
            {row.images.length > 3 ? <b>+{row.images.length - 3}</b> : null}
          </span>
        ) : null
      }
      line={
        <TraceLine
          status={row.status}
          title={row.name}
          description={row.why && !row.here ? row.why : row.here ? row.why : null}
          meta={row.id}
        />
      }
    >
      <Detail
        row={row}
        root={root}
        runs={row.here ? runs : []}
        live={row.here ? live : []}
        onImage={(path, name) => setImage({ path, name })}
        onOpen={onOpen}
      />
    </TraceCollapsible>
  )
  return (
    <section className="stages" aria-label="Stages">
      <header className="stages-head">
        <div>
          <h2>{snap!.state.board}</h2>
          <p className="stages-at">
            {here ? (
              <>
                Now at <b>{here.name}</b> <code>{here.id}</code>
              </>
            ) : (
              'The board is not at a stage in the table.'
            )}
          </p>
        </div>
        <p className="stages-live" role="status">
          <span className="dot" data-live={error ? 'off' : 'on'} />
          {error
            ? 'Not live. Showing the last good read.'
            : `Live, read at ${at ? clock.format(at) : '—'}`}
        </p>
      </header>
      {error ? (
        <p className="stages-error" role="alert">
          {error}
        </p>
      ) : null}
      {result.next.command ? (
        <pre className="stages-next" aria-label="Next command">
          {result.next.command}
        </pre>
      ) : null}
      {snap!.state.change.problems.length ? (
        <p className="stages-error" role="alert">
          {snap!.state.change.problems.join('; ')}
        </p>
      ) : null}
      <ol className="strip" aria-label="Progress through the stages">
        {stages.map((row) => (
          <li
            key={row.id}
            data-status={row.status}
            title={`${row.id} ${row.name}: ${LABEL[row.status]}`}
          />
        ))}
      </ol>
      <ul className="legend" aria-label="Status">
        {STATUSES.map((status) => (
          <li key={status} title={HINT[status]} data-status={status}>
            <TraceIcon status={status} />
            <span>{LABEL[status]}</span>
            <b>{result.counts[status]}</b>
          </li>
        ))}
      </ul>
      <Trace label="Stages of the board">{stages.map(renderRow)}</Trace>
      {rules.length ? (
        <details className="stages-rules">
          <summary>Rules for every stage ({rules.length})</summary>
          <Trace label="Rules for every stage">{rules.map(renderRow)}</Trace>
        </details>
      ) : null}
      <dialog
        ref={dialog}
        className="stages-dialog"
        aria-label={image?.name ?? 'Image'}
        onClose={() => setImage(null)}
        onClick={(e) => {
          if (e.target === dialog.current) setImage(null)
        }}
      >
        {image ? (
          <>
            <img src={window.api.fileUrl(image.path)} alt={image.name} />
            <button type="button" onClick={() => setImage(null)}>
              Close
            </button>
          </>
        ) : null}
      </dialog>
    </section>
  )
}
