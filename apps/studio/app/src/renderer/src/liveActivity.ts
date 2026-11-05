export type ActivityTone = 'neutral' | 'working' | 'success' | 'warning' | 'error'
export type ActivityRow = { title: string; detail: string; tone: ActivityTone; raw: string }

/** Present a toolchain event without upgrading a router result into a verified board verdict. */
export function activityRows(data: Record<string, unknown>): ActivityRow[] {
  const type = typeof data.type === 'string' ? data.type : 'update'
  const text = typeof data.text === 'string' ? data.text : ''
  const stage = typeof data.stage === 'string' ? data.stage.replace(/[-_]/g, ' ') : ''
  if (type === 'tool.output' && text.trim()) return text.trim().split(/\r?\n/).filter(Boolean).map(raw => formatLine(raw.trim(), stage))
  if (type === 'run.end') {
    const status = String(data.status ?? 'unknown')
    const tone: ActivityTone = status === 'passed' ? 'success' : status === 'failed' || status === 'error' ? 'error' : 'neutral'
    return [{ title: `Run ${status}`, detail: typeof data.cause === 'string' ? data.cause : '', tone, raw: JSON.stringify(data) }]
  }
  const titles: Record<string, string> = { 'run.start': 'Run started', 'run.waiting': 'Waiting for board',
    'run.admitted': 'Board available', 'stage.start': 'Stage started', 'stage.end': 'Stage finished',
    'stage.activity': 'Stage update', 'run.heartbeat': 'Run active', 'tool.start': 'Tool started', 'tool.exit': 'Tool finished',
    'run.stopping': 'Stopping run', 'check.end': 'Check finished', 'run.event_oversize': 'Large log entry omitted',
    'run.event_invalid': 'Unreadable log entry' }
  const detail = [stage, ...['check', 'message', 'cause', 'status'].map(k => typeof data[k] === 'string' ? data[k] as string : '')].filter(Boolean).join(' · ')
  return [{ title: titles[type] ?? type.replace(/[._-]/g, ' '), detail, tone: type.includes('waiting') ? 'warning' : 'neutral', raw: JSON.stringify(data) }]
}

function formatLine(raw: string, stage: string): ActivityRow {
  const pass = raw.match(/^iter\s+(\d+):\s+routed\s+(\d+),.*?audit pairs\s+(\d+).*?involved\s+(\d+).*?hard fails\s+(\d+).*?([\d.]+)\s+s\s+hard:.*?involved:\s*(.*)$/i)
  if (pass) {
    const [, n, routed, conflicts, involved, failures, seconds, nets] = pass
    const detail = [`${routed} nets routed`, `${conflicts} clearance conflicts`, `${involved} nets need work`, `${seconds} s`]
    if (Number(failures)) detail.push(`${failures} routing failures`)
    if (nets.trim()) detail.push(`Nets: ${nets.trim()}`)
    return { title: `Routing pass ${n}`, detail: detail.join(' · '), tone: Number(failures) ? 'error' : Number(conflicts) ? 'warning' : 'success', raw }
  }
  const finished = raw.match(/^ROUTE\s+(PASS|FAIL|ERROR).*?iters\s+(\d+)\s+tracks\s+(\d+)\s+vias\s+(\d+)\s+failed\s+(\d+).*?([\d.]+)\s+s\s+->/i)
  if (finished) {
    const [, verdict, passes, tracks, vias, failed, seconds] = finished
    return { title: verdict === 'PASS' ? 'Router finished' : 'Router stopped',
      detail: `${passes} passes · ${tracks} tracks · ${vias} vias · ${failed} failed nets · ${seconds} s`,
      tone: verdict === 'PASS' ? 'success' : 'error', raw }
  }
  const lengths = raw.match(/^length recovery:\s*(\d+) re-route\(s\) kept.*?net length\s+([\d.]+)\s*->\s*([\d.]+)\s*mm/i)
  if (lengths) return { title: 'Routes shortened', detail: `${lengths[1]} improvements · ${lengths[2]} to ${lengths[3]} mm`, tone: 'working', raw }
  const returns = raw.match(/^returns:\s*(\d+) return via\(s\) removed/i)
  if (returns) return { title: 'Return vias checked', detail: `${returns[1]} unnecessary vias removed`, tone: 'neutral', raw }
  const rule = raw.match(/^return via:\s*([\d.]+)\s*\/\s*([\d.]+).*?radius\s+([\d.]+)/i)
  if (rule) return { title: 'Return-via rule', detail: `${rule[1]} mm diameter · ${rule[2]} mm drill · ${rule[3]} mm return radius`, tone: 'neutral', raw }
  return { title: stage ? `${stage[0].toUpperCase()}${stage.slice(1)} update` : 'Tool update', detail: raw, tone: /\b(error|failed|fail)\b/i.test(raw) ? 'error' : 'neutral', raw }
}
