import { useMemo, useState } from 'react'
import type { LiveEvent } from './LiveView'

type Entry = { source: string; board: string; host: string; preferred: LiveEvent; status: 'working' | 'waiting' | 'stale' | 'idle'; run?: LiveEvent }
type Machine = { name: string; label: string; entries: Entry[]; local: boolean }
const hostName = (host: string): string => host.replace(/\s+\([^)]*\)$/, '')
const shortHost = (host: string): string => host.toLowerCase().split('.')[0]
const checkout = (host: string): string | null => /\(([^)]+)\)$/.exec(host)?.[1] ?? null
function labelFor(host: string, local: string | null): string {
  if (local && shortHost(host) === shortHost(local)) return 'This computer'
  if (/mac[- ]?mini/i.test(host)) return 'Mac mini'
  return host
}

export function LiveSidebar({ events, boards, selectedSource, selectedBoard, localHost, connected, now, onPick }: {
  events: LiveEvent[]; boards: LiveEvent[]; selectedSource: string | null; selectedBoard: string | null;
  localHost: string | null; connected: boolean; now: number; onPick: (event: LiveEvent) => void
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const machines = useMemo(() => {
    const heartbeats = new Map(events.filter(e => e.kind === 'host.heartbeat').map(e => [e.source, e.receivedAt]))
    const identities = new Map<string, LiveEvent[]>()
    for (const e of [...boards, ...events.filter(e => e.kind === 'run.state')]) {
      if (!e.board || e.board.endsWith('/_host')) continue
      const key = `${e.source}\0${e.board}`
      const list = identities.get(key) ?? []
      list.push(e); identities.set(key, list)
    }
    const groups = new Map<string, Machine>()
    if (localHost) groups.set(shortHost(localHost), { name: localHost, label: 'This computer', entries: [], local: true })
    for (const items of identities.values()) {
      const list = [...items].sort((a, b) => b.cursor - a.cursor), sample = list[0]
      const snapshots = list.filter(e => e.kind !== 'run.state')
      const preferred = snapshots.find(e => e.kind === 'board.snapshot' && e.run === 'saved') ?? snapshots[0] ?? sample
      const states = list.filter(e => e.kind === 'run.state')
      const recent = states.find(e => ['running', 'queued', 'stopping'].includes(String(e.data.status)) && e.data.supervisorAlive === true && now - e.receivedAt < 45000)
      const heartbeat = heartbeats.get(sample.source)
      const online = connected && !!heartbeat && now - heartbeat < 45000
      const status: Entry['status'] = !online ? 'stale' : recent ? recent.data.status === 'queued' ? 'waiting' : 'working' : 'idle'
      const host = hostName(sample.host), key = shortHost(host)
      const group = groups.get(key) ?? { name: host, label: labelFor(host, localHost), entries: [], local: !!localHost && key === shortHost(localHost) }
      group.entries.push({ source: sample.source, board: sample.board, host: sample.host, preferred, status, run: recent })
      groups.set(key, group)
    }
    return [...groups.values()].sort((a, b) => Number(b.local) - Number(a.local) || a.label.localeCompare(b.label)).map(group => ({
      ...group, entries: group.entries.filter(e => `${e.board} ${e.host}`.toLowerCase().includes(filter.toLowerCase()))
        .sort((a, b) => Number(b.status === 'working') - Number(a.status === 'working') || a.board.localeCompare(b.board) || a.host.localeCompare(b.host))
    }))
  }, [events, boards, localHost, connected, now, filter])
  return <section className="live-sidebar" aria-label="Machines and boards">
    <div className="live-sidebar-header"><strong>Machines</strong><span>View only</span></div>
    <input type="search" aria-label="Filter boards" placeholder="Find a board" value={filter} onChange={e => setFilter(e.target.value)} />
    <div className="live-machine-list">
      {machines.map(machine => <details key={shortHost(machine.name)} open>
        <summary><span>{machine.label}</span><small>{machine.entries.filter(e => e.status === 'working').length} working</small></summary>
        {machine.entries.length ? <ul>{machine.entries.map(entry => <li key={`${entry.source}\0${entry.board}`}>
          <button type="button" className={`live-board-item ${entry.source === selectedSource && entry.board === selectedBoard ? 'on' : ''}`}
            aria-current={entry.source === selectedSource && entry.board === selectedBoard ? 'true' : undefined}
            onClick={() => onPick(entry.preferred)}>
            <span className={`live-board-dot ${entry.status}`} aria-hidden="true" />
            <span className="live-board-name">{entry.board.split('/').slice(1).join('/') || entry.board}
              {checkout(entry.host) ? <small>{checkout(entry.host)}</small> : null}
            </span>
            <span className="live-board-status">{entry.status === 'idle' ? '' : entry.status}</span>
          </button>
        </li>)}</ul> : <p className="live-empty">{filter ? 'No matching boards' : 'No boards reported'}</p>}
      </details>)}
      {!machines.length ? <p className="live-empty">Waiting for machines</p> : null}
    </div>
  </section>
}
