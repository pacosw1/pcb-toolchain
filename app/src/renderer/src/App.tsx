import { useCallback, useEffect, useState } from 'react'
import type { EngineStatus } from '../../preload/types'
import { BoardView, type Selection } from './BoardView'
import { BoardPicker } from './BoardPicker'
import { Icon } from './Icon'
import { ChatPanel } from './ChatPanel'
import { ChecksView } from './ChecksView'
import { DatasheetView } from './DatasheetView'
import { PartsView } from './PartsView'
import { Viewer3D } from './Viewer3D'
import type { Bom, BomLine, Finding, Geometry, ProjectInfo } from './types'

type Tab = 'board' | '3d' | 'parts' | 'datasheets' | 'checks'

const STATE_COLOR: Record<EngineStatus['state'], string> = {
  ready: 'var(--ok)',
  starting: 'var(--warn)',
  restarting: 'var(--warn)',
  stopped: 'var(--err)'
}
const LAST_PROJECT = 'pcbstudio.lastProject'

function useEngineStatus(): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  useEffect(() => {
    window.api.engine.status().then(setStatus)
    return window.api.engine.onStatus(setStatus)
  }, [])
  return status
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT)
  } catch {
    return null
  }
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
    <details className="panel" aria-label="Engine">
      <summary>
        Engine · {status?.state ?? '…'} · restarts {status?.restarts ?? 0}
      </summary>
      <dl className="kv" style={{ marginTop: 10 }}>
        <dt>Port / PID</dt>
        <dd>
          {status?.port ?? '—'} / {status?.pid ?? '—'}
        </dd>
        <dt>Restarts</dt>
        <dd>{status?.restarts ?? 0}</dd>
        <dt>Version</dt>
        <dd>{(info?.version as string) ?? '—'}</dd>
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
    </details>
  )
}

const LAST_PCB = 'pcbstudio.lastPcb'

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* per-viewer convenience only */
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function App(): React.JSX.Element {
  const status = useEngineStatus()
  const ready = status?.state === 'ready'
  const [project, setProject] = useState<ProjectInfo | null>(null)
  const [pcb, setPcb] = useState<string | null>(null)
  const [geo, setGeo] = useState<Geometry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [tab, setTab] = useState<Tab>('board')
  const [bom, setBom] = useState<Bom | null>(null)
  const [sheet, setSheet] = useState<BomLine | null>(null)
  const [focus, setFocus] = useState<{ ref: string } | null>(null)
  const [findings, setFindings] = useState<Finding[]>([])
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number; span?: number } | null>(null)
  const mention = selection
    ? `@${selection.ref}.${selection.pad.num}${selection.pad.net ? ` #${selection.pad.net}` : ''}`
    : null
  const board = project?.boards.find((b) => b.revisions.some((r) => r.pcb && r.pcb === pcb)) ?? null
  const revision = board?.revisions.find((r) => r.pcb === pcb) ?? null
  const gate = revision?.gate ?? null

  const choosePcb = (p: string | null): void => {
    setPcb(p)
    if (p) remember(LAST_PCB, p)
  }

  const openProject = useCallback(async (root: string) => {
    setError(null)
    try {
      const p = (await window.api.engine.call('project.open', { root })) as ProjectInfo
      setProject(p)
      await window.api.setProjectRoot(p.root)
      remember(LAST_PROJECT, p.root)
      const last = recall(LAST_PCB)
      if (last && p.boards.some((b) => b.revisions.some((r) => r.pcb === last))) setPcb((cur) => cur ?? last)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  // Reopen the project (and the board) after start and after an engine restart.
  useEffect(() => {
    if (!ready) return
    ;(async () => {
      const root = (await window.api.defaultProject()) ?? project?.root ?? readLast()
      if (root) await openProject(root)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, status?.restarts])

  useEffect(() => {
    if (!pcb || !ready || !project) return
    setFindings([])
    setFocusPoint(null)
    setSelection(null)
    setBusy(true)
    setError(null)
    window.api.engine
      .call('board.geometry', { pcb })
      .then((g) => setGeo(g as Geometry))
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false))
    window.api.engine
      .call('board.bom', { pcb })
      .then((b) => setBom(b as Bom))
      .catch((e) => setError(String(e)))
  }, [pcb, ready, project])

  const pickProject = async (): Promise<void> => {
    const root = await window.api.openProjectDialog()
    if (root) await openProject(root)
  }

  const sections: [Tab, string, string, string | null][] = [
    ['board', 'Board', 'board', geo ? `${geo.footprints.length} parts` : null],
    ['3d', '3D', 'cube', null],
    ['parts', 'Parts / BOM', 'list', bom ? `${bom.summary.lines} lines` : null],
    ['datasheets', 'Datasheets', 'doc', bom ? String(bom.lines.filter((l) => l.datasheet).length) : null],
    ['checks', 'Checks', 'check', gate ? null : 'no gate']
  ]

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PCB Studio</span>
        <nav className="crumbs" aria-label="Location">
          <span>{project ? project.root.split('/').pop() : 'No project open'}</span>
          {board ? (
            <>
              <span className="sep">/</span>
              <span className="cur">{board.id}</span>
            </>
          ) : null}
          {revision ? <span className="statechip">{revision.revision ? `rev ${revision.revision}` : 'unregistered'} · {revision.state ?? '—'}</span> : null}
        </nav>
        <span style={{ flex: '1 1 auto' }} />
        {window.api.mode === 'desktop' ? (
          <button type="button" onClick={pickProject} disabled={!ready}>
            Open project…
          </button>
        ) : (
          <span className="statechip">web viewer · read-only</span>
        )}
        <span className="pill" role="status" aria-label="Engine status">
          <span className="dot" style={{ background: status ? STATE_COLOR[status.state] : 'var(--dim)' }} />
          engine {status?.state ?? '…'}
        </span>
      </header>
      <div className="body">
        <nav className="sidebar" aria-label="Board">
          {!project ? (
            <p style={{ color: 'var(--dim)', margin: 0 }}>Open a hardware project (for example iot-lab).</p>
          ) : (
            <>
              <BoardPicker
                boards={project.boards}
                current={board}
                onPick={(_b, p) => {
                  choosePcb(p)
                  setTab('board')
                }}
              />
              {board && board.revisions.filter((r) => r.pcb).length > 1 ? (
                <label className="revpick">
                  <span>Revision</span>
                  <select value={pcb ?? ''} onChange={(e) => choosePcb(e.target.value)}>
                    {board.revisions
                      .filter((r) => r.pcb)
                      .map((r) => (
                        <option key={r.pcb!} value={r.pcb!}>
                          {r.revision ? `rev ${r.revision}` : r.pcb!.split('/').pop()} · {r.state ?? '—'}
                        </option>
                      ))}
                  </select>
                </label>
              ) : revision ? (
                <div className="revpick">
                  <span>Revision</span>
                  <span style={{ color: 'var(--text)' }}>
                    {revision.revision ? `rev ${revision.revision}` : 'unregistered'} · {revision.state ?? '—'}
                  </span>
                </div>
              ) : null}
              {geo ? (
                <ul className="sections" aria-label="Sections">
                  {sections.map(([k, label, icon, note]) => (
                    <li key={k}>
                      <button
                        type="button"
                        className={tab === k ? 'section on' : 'section'}
                        aria-current={tab === k ? 'page' : undefined}
                        onClick={() => setTab(k)}
                      >
                        <Icon name={icon} />
                        <span className="label">{label}</span>
                        {note ? <span className="note">{note}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
          <div style={{ flex: '1 1 auto' }} />
          <EnginePanel status={status} />
        </nav>
        <main className="main">
          {error ? (
            <div className="panel" role="alert" style={{ color: 'var(--err)' }}>
              {error}
            </div>
          ) : null}
          {geo && tab === 'board' ? (
            <BoardView geo={geo} onSelect={setSelection} focusRef={focus} findings={findings} focusPoint={focusPoint} />
          ) : geo && tab === '3d' && pcb ? (
            <Viewer3D pcb={pcb} />
          ) : geo && tab === 'parts' && bom ? (
            <PartsView
              bom={bom}
              onDatasheet={(l) => {
                setSheet(l)
                setTab('datasheets')
              }}
              onShowRef={(ref) => {
                setFocus({ ref })
                setTab('board')
              }}
            />
          ) : geo && tab === 'datasheets' && bom ? (
            <DatasheetView bom={bom} initial={sheet} />
          ) : geo && tab === 'checks' ? (
            <ChecksView
              gate={gate}
              onFindings={setFindings}
              onShowFinding={(f) => {
                const xs = f.items.map((i) => i.x)
                const ys = f.items.map((i) => i.y)
                const span = xs.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0
                setFocusPoint({ x: f.x, y: f.y, span })
                setTab('board')
              }}
            />
          ) : (
            <section className="panel placeholder" aria-label="Board view">
              {busy ? 'Loading board…' : project ? 'Choose a board on the left.' : 'No project open.'}
            </section>
          )}
        </main>
        {window.api.mode === 'web' ? null : (
        <ChatPanel
          ctx={{ projectRoot: project?.root ?? null, pcb, gate, selection: mention }}
          mention={mention}
          onViewer={(v) => {
            setTab('board')
            if (v.ref) setFocus({ ref: v.ref })
            else if (v.x != null && v.y != null) setFocusPoint({ x: v.x, y: v.y })
          }}
        />
        )}
      </div>
    </div>
  )
}

export default App
