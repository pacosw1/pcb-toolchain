import { useCallback, useEffect, useState } from 'react'
import type { EngineStatus } from '../../preload/types'
import { BoardView, type Selection } from './BoardView'
import { ChecksView } from './ChecksView'
import { DatasheetView } from './DatasheetView'
import { PartsView } from './PartsView'
import type { Bom, BomLine, Finding, Geometry, ProjectInfo } from './types'

type Tab = 'board' | 'parts' | 'datasheets' | 'checks'

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
  const gate =
    project?.boards.flatMap((b) => b.revisions).find((r) => r.pcb === pcb)?.gate ?? null

  const openProject = useCallback(async (root: string) => {
    setError(null)
    try {
      const p = (await window.api.engine.call('project.open', { root })) as ProjectInfo
      setProject(p)
      await window.api.setProjectRoot(p.root)
      try {
        localStorage.setItem(LAST_PROJECT, p.root)
      } catch {
        /* per-viewer convenience only */
      }
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

  const pick = async (): Promise<void> => {
    const root = await window.api.openProjectDialog()
    if (root) await openProject(root)
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">PCB Studio</span>
        <span style={{ color: 'var(--muted)' }}>
          {project ? project.root.split('/').pop() : 'No project open'}
          {pcb ? ` ▸ ${pcb.split('/').pop()}` : ''}
        </span>
        <span style={{ flex: '1 1 auto' }} />
        <button type="button" onClick={pick} disabled={!ready}>
          Open project…
        </button>
        <span className="pill" role="status" aria-label="Engine status">
          <span className="dot" style={{ background: status ? STATE_COLOR[status.state] : 'var(--dim)' }} />
          engine {status?.state ?? '…'}
        </span>
      </header>
      <div className="body">
        <nav className="sidebar" aria-label="Boards">
          <h2>Boards</h2>
          {!project ? (
            <p style={{ color: 'var(--dim)', margin: 0 }}>Open a hardware project (for example iot-lab).</p>
          ) : (
            <ul className="boardlist">
              {project.boards.map((b) => (
                <li key={b.directory}>
                  <span className="boardname">{b.id}</span>
                  <span className="lifecycle">{b.lifecycle}</span>
                  {b.revisions
                    .filter((r) => r.pcb)
                    .map((r) => (
                      <button
                        key={r.pcb!}
                        type="button"
                        className={r.pcb === pcb ? 'rev on' : 'rev'}
                        onClick={() => setPcb(r.pcb)}
                      >
                        {r.revision ? `rev ${r.revision}` : r.pcb!.split('/').pop()} · {r.state ?? '—'}
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
        </nav>
        <main className="main">
          {error ? (
            <div className="panel" role="alert" style={{ color: 'var(--err)' }}>
              {error}
            </div>
          ) : null}
          {geo ? (
            <nav className="tabs" aria-label="Workspace tabs">
              {(
                [
                  ['board', 'Board'],
                  ['parts', `Parts / BOM${bom ? ` (${bom.summary.refs})` : ''}`],
                  ['datasheets', 'Datasheets'],
                  ['checks', 'Checks']
                ] as [Tab, string][]
              ).map(([k, label]) => (
                <button key={k} type="button" className={tab === k ? 'tab on' : 'tab'} aria-pressed={tab === k} onClick={() => setTab(k)}>
                  {label}
                </button>
              ))}
            </nav>
          ) : null}
          {geo && tab === 'board' ? (
            <BoardView geo={geo} onSelect={setSelection} focusRef={focus} findings={findings} focusPoint={focusPoint} />
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
          ) : geo ? (
            <section className="panel placeholder">Loading…</section>
          ) : (
            <section className="panel placeholder" aria-label="Board view">
              {busy ? 'Loading board…' : project ? 'Pick a board revision on the left.' : 'No project open.'}
            </section>
          )}
          <EnginePanel status={status} />
        </main>
        <aside className="chat" aria-label="Claude">
          <h2 style={{ fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--dim)' }}>
            Claude
          </h2>
          {selection ? (
            <p style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
              @{selection.ref}.{selection.pad.num} {selection.pad.net ? `#${selection.pad.net}` : ''}
            </p>
          ) : null}
          <p>Agent chat arrives in phase 4. Pads you click show up here as mentions.</p>
        </aside>
      </div>
    </div>
  )
}

export default App
