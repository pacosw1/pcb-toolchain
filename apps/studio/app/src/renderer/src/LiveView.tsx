import { useEffect, useMemo, useRef, useState } from 'react'
import { LiveBoard } from './LiveBoard'
import { activityRows } from './liveActivity'
import { interpolatePlacement, placementGeometry, type Placement } from './livePlacement'
import type { Geometry } from './types'

type Event = { cursor: number; source: string; host: string; board: string; run: string; kind: string; receivedAt: number; data: Record<string, unknown> }
type Status = 'connecting' | 'connected' | 'disconnected'
type Preview = { passes: number; tracks: { a: [number, number]; b: [number, number]; w: number; layer: string; net: string }[];
  vias: { x: number; y: number; d: number; drill: number; net: string }[] }
const keyOf = (e: Event): string => [e.source, e.board, e.run, e.kind,
  e.kind === 'run.event' ? String(e.cursor) : ['board.snapshot', 'board.invalid', 'board.removed', 'route.preview', 'placement.preview'].includes(e.kind) ? String(e.data?.path ?? '') : ''].join('\0')
const runKey = (e: Event): string => `${e.source}\0${e.run}`
const valid = (e: Event): boolean => !!e && Number.isSafeInteger(e.cursor) && typeof e.source === 'string' && typeof e.host === 'string' &&
  typeof e.board === 'string' && typeof e.run === 'string' && typeof e.kind === 'string' && Number.isFinite(e.receivedAt) &&
  !!e.data && typeof e.data === 'object' && !Array.isArray(e.data)

export function LiveView(): React.JSX.Element {
  const [events, setEvents] = useState<Record<string, Event>>({})
  const [status, setStatus] = useState<Status>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState('')
  const [selectedRun, setSelectedRun] = useState('')
  const [followRun, setFollowRun] = useState(true)
  const [geometry, setGeometry] = useState<Geometry | null>(null)
  const [loadedHash, setLoadedHash] = useState<string | null>(null)
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadedPreviewHash, setLoadedPreviewHash] = useState<string | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [placementFrame, setPlacementFrame] = useState<Placement | null>(null)
  const previousPlacement = useRef<Placement | null>(null)
  const [now, setNow] = useState(Date.now())
  const [truncated, setTruncated] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [coordinatorLabel, setCoordinatorLabel] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    setStatus('connecting')
    setError(null)
    const merge = (incoming: Event[]): void => {
      setEvents(old => {
        const next = { ...old }
        for (const e of incoming.filter(valid)) {
          const k = keyOf(e)
          if (!next[k] || next[k].cursor < e.cursor) next[k] = e
        }
        const timeline = Object.entries(next).filter(([, e]) => e.kind === 'run.event').sort((a, b) => b[1].cursor - a[1].cursor)
        for (const [k] of timeline.slice(300)) delete next[k]
        return next
      })
    }
    const off = window.api.engine.onNotify(n => {
      if (n.method === 'live.event') merge([n.params as unknown as Event])
      if (n.method === 'live.reset') {
        const snapshot = n.params as unknown as { events: Event[]; truncated: boolean }
        setEvents({}); merge(snapshot.events); setTruncated(snapshot.truncated)
      }
      if (n.method === 'live.connection') {
        setStatus(n.params.state === 'connected' ? 'connected' : 'disconnected')
        setError(n.params.state === 'connected' ? null : String(n.params.error ?? 'Connection lost'))
      }
    })
    window.api.engine.call('live.open').then(value => {
      if (closed) return
      const snapshot = value as { events: Event[]; truncated: boolean; label?: string }
      merge(snapshot.events); setTruncated(snapshot.truncated); setCoordinatorLabel(snapshot.label ?? null)
    }).catch(e => { if (!closed) { setStatus('disconnected'); setError(String(e)) } })
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => { closed = true; clearInterval(timer); off() }
  }, [attempt])

  const all = useMemo(() => Object.values(events), [events])
  const unavailable = all.filter(e => e.kind === 'board.invalid' && !all.some(next =>
    ['board.snapshot', 'candidate.snapshot', 'board.removed'].includes(next.kind) && next.source === e.source && next.board === e.board &&
    next.run === e.run && next.data?.path === e.data?.path && next.cursor > e.cursor))
  const boards = useMemo(() => all.filter(e => ['board.snapshot', 'candidate.snapshot', 'route.preview', 'placement.preview'].includes(e.kind) && typeof e.data?.sha256 === 'string' &&
    !(e.kind === 'board.snapshot' && e.run === 'saved' && all.some(r => r.kind === 'board.removed' && r.source === e.source && r.board === e.board && r.data?.path === e.data.path && r.cursor > e.cursor)))
    .sort((a, b) => `${a.board} ${a.host} ${a.run}`.localeCompare(`${b.board} ${b.host} ${b.run}`)), [all])
  const current = boards.find(e => keyOf(e) === selected) ?? null
  const runs = all.filter(e => e.kind === 'run.state' && (!current || (e.source === current.source && e.board === current.board)))
    .sort((a, b) => b.cursor - a.cursor)
  const active = runs.find(e => runKey(e) === selectedRun) ?? (current?.run && current.run !== 'saved' ? runs.find(e => e.run === current.run) : runs.find(e => ['queued', 'running', 'stopping'].includes(String(e.data.status))) ?? runs[0])
  const following = current && followRun && active && active.data.status === 'running' && active.data.supervisorAlive === true
    ? boards.filter(e => ['candidate.snapshot', 'route.preview', 'placement.preview'].includes(e.kind) && e.source === active.source && e.board === active.board && e.run === active.run).sort((a, b) => b.cursor - a.cursor)[0]
    : undefined
  const view = following ?? current
  const viewIdentity = view ? [view.source, view.board, view.run].join('\0') : ''
  const invalid = view && ['board.snapshot', 'candidate.snapshot'].includes(view.kind) ? all.find(e => e.kind === 'board.invalid' && e.source === view.source && e.board === view.board && e.run === view.run && e.data.path === view.data.path && e.cursor > view.cursor) : undefined
  const base = view?.kind === 'route.preview' ? boards.find(e => e.kind === 'board.snapshot' && e.source === view.source && e.board === view.board && e.run === view.run && e.data.sha256 === view.data.baseSha256) : view
  const hash = view?.kind === 'placement.preview' && typeof view.data.baseSha256 === 'string' ? view.data.baseSha256 : typeof base?.data.sha256 === 'string' ? base.data.sha256 : null
  const previewHash = view?.kind === 'route.preview' && typeof view.data.sha256 === 'string' ? view.data.sha256 : null
  const placementHash = view?.kind === 'placement.preview' && typeof view.data.sha256 === 'string' ? view.data.sha256 : null
  useEffect(() => {
    let closed = false
    if (!hash) { setGeometry(null); return }
    window.api.engine.call('live.geometry', { sha256: hash }).then(g => {
      if (!closed) { setGeometry(g as Geometry); setLoadedHash(hash); setLoadedIdentity(viewIdentity) }
    }).catch(e => { if (!closed) setError(`Board snapshot unavailable: ${e}`) })
    return () => { closed = true }
  }, [hash, viewIdentity])
  useEffect(() => {
    let closed = false
    if (!previewHash) { setPreview(null); return }
    window.api.engine.call('live.preview', { sha256: previewHash }).then(value => {
      if (!closed) { setPreview(value as Preview); setLoadedPreviewHash(previewHash) }
    }).catch(e => { if (!closed) setError(`Route preview unavailable: ${e}`) })
    return () => { closed = true }
  }, [previewHash])
  useEffect(() => {
    let closed = false
    if (!placementHash) { setPlacement(null); setPlacementFrame(null); previousPlacement.current = null; return }
    window.api.engine.call('live.placement', { sha256: placementHash }).then(value => {
      if (!closed) setPlacement(value as Placement)
    }).catch(e => { if (!closed) setError(`Placement preview unavailable: ${e}`) })
    return () => { closed = true }
  }, [placementHash])
  useEffect(() => {
    if (!placement || !placementHash || placement.board_sha256 !== hash) return
    const start = previousPlacement.current
    let frame = 0
    const timer = setInterval(() => {
      frame++
      const currentFrame = interpolatePlacement(start, placement, Math.min(1, frame / 5))
      setPlacementFrame(currentFrame)
      previousPlacement.current = currentFrame
      if (frame >= 5) clearInterval(timer)
    }, 50)
    return () => clearInterval(timer)
  }, [placement, placementHash, hash])
  const rendered = useMemo(() => {
    if (!geometry || loadedIdentity !== viewIdentity) return null
    if (loadedHash !== hash) return view?.kind === 'candidate.snapshot' ? geometry : null
    if (placementHash && placementFrame && placementFrame.board_sha256 === hash) return placementGeometry(geometry, placementFrame)
    if (!previewHash || !preview || loadedPreviewHash !== previewHash) return geometry
    return { ...geometry, tracks: [...geometry.tracks, ...preview.tracks.map(t => ({ x1: t.a[0], y1: t.a[1], x2: t.b[0], y2: t.b[1], w: t.w, layer: t.layer, net: t.net }))],
      vias: [...geometry.vias, ...preview.vias.map(v => ({ x: v.x, y: v.y, d: v.d, drill: v.drill, net: v.net, layers: ['F.Cu', 'B.Cu'] }))] }
  }, [geometry, loadedHash, loadedIdentity, viewIdentity, view?.kind, hash, placementHash, placementFrame, preview, loadedPreviewHash, previewHash])
  const heartbeats = new Map(all.filter(e => e.kind === 'host.heartbeat').map(e => [e.source, e.receivedAt]))
  const stateFor = (e: Event): string => {
    if (status !== 'connected') return 'disconnected'
    const last = heartbeats.get(e.source)
    return last && now - last < 45_000 ? 'live' : 'stale'
  }
  const recent = all.filter(e => e.kind === 'run.event' && (!current || (e.source === current.source && e.board === current.board)) &&
    (!active || (e.run === active.run && e.source === active.source && e.board === active.board)))
    .sort((a, b) => b.cursor - a.cursor).slice(0, 12)
  const rawStatus = typeof active?.data.status === 'string' ? active.data.status : 'unknown'
  const runStatus = ['running', 'stopping'].includes(rawStatus) && active?.data.supervisorAlive !== true
    ? active?.data.supervisorAlive === false ? 'interrupted (not confirmed)' : 'status unconfirmed' : rawStatus
  const stages = Array.isArray(active?.data.active_stages) ? active.data.active_stages.filter((v): v is string => typeof v === 'string') : []
  const elapsed = typeof active?.data.elapsed_s === 'number' ? active.data.elapsed_s : null
  const lastProgress = typeof active?.data.last_progress_s === 'number' && elapsed !== null ? Math.max(0, elapsed - active.data.last_progress_s) : null
  const routeFrame = all.find(e => e.kind === 'route.preview' && e.source === active?.source && e.board === active?.board && e.run === active?.run)
  const placeFrame = all.find(e => e.kind === 'placement.preview' && e.source === active?.source && e.board === active?.board && e.run === active?.run)
  const note = all.filter(e => e.kind === 'run.note' && e.source === active?.source && e.board === active?.board && e.run === active?.run && typeof e.data.message === 'string')
    .sort((a, b) => b.cursor - a.cursor)[0]
  const agentUpdate = all.filter(e => e.kind === 'agent.update' && e.source === current?.source && e.board === current?.board)
    .sort((a, b) => b.cursor - a.cursor)[0]
  const agentMessage = all.filter(e => e.kind === 'agent.message' && e.source === current?.source && e.board === current?.board)
    .sort((a, b) => b.cursor - a.cursor)[0]
  const metrics = active?.data.metrics && typeof active.data.metrics === 'object' && !Array.isArray(active.data.metrics) ? Object.entries(active.data.metrics as Record<string, unknown>) : []
  return (
    <div className="panel live-view" aria-label="Live boards">
      <h1>Live boards</h1>
      <p role="status">Coordinator: {status}{coordinatorLabel ? ` · ${coordinatorLabel}` : ''}{error ? ` · ${error}` : ''}</p>
      {status === 'disconnected' ? <button type="button" onClick={() => setAttempt(n => n + 1)}>Reconnect</button> : null}
      {truncated ? <p>Some older observations are not shown.</p> : null}
      {unavailable.length ? <details><summary>{unavailable.length} board snapshot{unavailable.length === 1 ? '' : 's'} unavailable</summary>
        <ul>{unavailable.map(e => <li key={keyOf(e)}>{e.board} · {e.host} · {String(e.data.error ?? 'Unavailable')}</li>)}</ul>
      </details> : null}
      <label>Board and machine{' '}
        <select value={selected} onChange={e => { setSelectedRun(''); setSelected(e.target.value) }}>
          <option value="">Choose a board</option>
          {boards.map(e => <option key={keyOf(e)} value={keyOf(e)}>{e.board} · {e.host} · {e.kind === 'route.preview' ? `route preview ${e.run}` : e.kind === 'placement.preview' ? `placement preview ${e.run}` : e.run === 'saved' ? `saved ${String(e.data.path ?? '').split('/').pop()}` : `candidate ${e.run}`} · {stateFor(e)}</option>)}
        </select>
      </label>
      {current ? <label style={{ marginLeft: 12 }}><input type="checkbox" checked={followRun} onChange={e => setFollowRun(e.target.checked)} /> Follow active run</label> : null}
      {view ? <p>{stateFor(view)} · {following ? 'Following active run · ' : ''}{view.kind === 'route.preview' ? `Unverified route preview, pass ${loadedPreviewHash === previewHash ? preview?.passes ?? '…' : '…'}` : view.kind === 'placement.preview' ? `Unverified placement preview, epoch ${String(view.data.epoch ?? '…')}` : view.kind === 'candidate.snapshot' ? `Unverified working candidate from ${view.run}` : view.run === 'saved' ? 'Saved board' : `Candidate from ${view.run}`} · last received {new Date(view.receivedAt).toLocaleString()}</p> : <p>No board selected.</p>}
      {hash ? <p>Source board version: <code>{hash.slice(0, 12)}</code></p> : null}
      {invalid ? <p role="alert">Showing the last available board: {String(invalid.data.error ?? 'the latest snapshot is unavailable')}.</p> : null}
      <section className="panel runsummary live-activity" aria-label="Current activity">
        <h2>Current activity</h2>
        {active ? <>
          <p role="status"><strong>{runStatus}</strong> · {String(active.data.operation ?? 'operation')}{typeof active.data.router === 'string' ? ` (${active.data.router})` : ''} · {active.host} · {active.run}</p>
          {runs.length > 1 ? <label>Run{' '}<select value={runKey(active)} onChange={e => setSelectedRun(e.target.value)}>
            {runs.map(e => <option key={runKey(e)} value={runKey(e)}>{e.run} · {e.host} · {String(e.data.status ?? 'unknown')}</option>)}
          </select></label> : null}
          <p>{stages.length ? `Working on: ${stages.join(', ')}` : rawStatus === 'queued' ? 'Waiting to start' : 'No active stage reported'}</p>
          <p>{elapsed === null ? 'Elapsed time not reported' : `Elapsed: ${Math.round(elapsed)} s`}{lastProgress === null ? '' : ` · Last progress: ${Math.round(lastProgress)} s before the latest update`}</p>
          {typeof active.data.timeoutS === 'number' ? <p>Run time limit: {active.data.timeoutS} s</p> : null}
          <p>Last report: {Math.max(0, Math.round((now - active.receivedAt) / 1000))} s ago</p>
          {typeof active.data.cause === 'string' && active.data.cause ? <p>{active.data.cause}</p> : null}
          {metrics.length ? <table className="metrics"><tbody>{metrics.map(([name, value]) => <tr key={name}><td>{name.replace(/_/g, ' ')}</td><td>{String(value ?? 'not reported')}</td></tr>)}</tbody></table> : null}
          {now - active.receivedAt > 45_000 && ['running', 'queued', 'stopping'].includes(rawStatus) ? <p>Run status has not updated recently.</p> : null}
          {['build', 'edit', 'route', 'repair', 'release'].includes(String(active.data.operation)) && ['running', 'queued', 'stopping'].includes(rawStatus) && active.data.coordinated === false
            ? <p role="alert">This run is not protected by the shared board lock.</p> : null}
          {routeFrame ? <p>Router: pass {String(routeFrame.data.passes ?? 'not reported')}{typeof routeFrame.data.maxPasses === 'number' ? ` of ${routeFrame.data.maxPasses}` : ''}
            {typeof routeFrame.data.conflictNets === 'number' ? ` · ${routeFrame.data.conflictNets} nets in conflict` : ''}
            {typeof routeFrame.data.conflictPairs === 'number' ? ` · ${routeFrame.data.conflictPairs} conflicts` : ''} · preview is not verified</p> : null}
          {placeFrame ? <p>Placement: epoch {String(placeFrame.data.epoch ?? '…')} of {String(placeFrame.data.epochs ?? '…')} · cost {String(placeFrame.data.cost ?? 'not reported')}</p> : null}
          {note ? <p>Latest {String(note.data.kind ?? 'note')}: {String(note.data.message)}</p> : null}
        </> : <p>{current ? 'No run reported for this board on this machine.' : 'Choose a board to see its activity.'}</p>}
      </section>
      {agentUpdate || agentMessage ? <section className="panel live-activity" aria-label="Agent updates">
        <h2>Agent</h2>
        {agentUpdate ? <p>{String(agentUpdate.data.message ?? agentUpdate.data.state ?? 'Status unavailable')}</p> : null}
        {agentMessage ? <p>Latest update: {String(agentMessage.data.message)}</p> : null}
      </section> : null}
      {view && !base ? <p>Waiting for the matching source board snapshot.</p> : null}
      {view?.kind === 'candidate.snapshot' && loadedHash !== hash && rendered ? <p>Loading the latest candidate; showing the previous snapshot.</p> : null}
      {view?.kind === 'placement.preview' ? <p>Placement preview: existing copper is hidden while parts move.</p> : null}
      {rendered && view ? <LiveBoard geo={rendered} identity={viewIdentity} animate={view.kind === 'candidate.snapshot'} /> : null}
      {recent.length ? <section aria-label="Recent run activity"><h2>Recent run activity</h2>
        <ol className="live-timeline">{recent.flatMap(e => activityRows(e.data).map((row, i) => <li key={`${e.cursor}:${i}`} className={`live-entry ${row.tone}`}>
          <time dateTime={new Date(e.receivedAt).toISOString()}>{new Date(e.receivedAt).toLocaleTimeString()}</time>
          <span className="live-entry-dot" aria-hidden="true" />
          <div><strong>{row.title}</strong>{row.detail ? <span className="live-entry-detail">{row.detail}</span> : null}
            <details><summary>Technical details</summary><pre>{row.raw}</pre></details>
          </div>
        </li>))}</ol>
      </section> : null}
    </div>
  )
}
