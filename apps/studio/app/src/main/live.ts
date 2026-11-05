/** Read-only coordinator access. Credentials stay in the engine process. */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fromBytes, bbox } from './kicad/board.ts'
import { isDigest } from '../../../../job-daemon/src/live-protocol.ts'
const cache = new Map<string, ReturnType<typeof fromBytes>>()
async function request(route: string): Promise<Response> {
  const url = process.env.JOBD_URL,
    file = process.env.JOBD_TOKEN_FILE
  if (!url || !file)
    throw new Error(
      'Configure JOBD_URL and JOBD_TOKEN_FILE in the Studio engine to view solver runs.'
    )
  const token = fs.readFileSync(file, 'utf8').trim()
  const response = await fetch(new URL(route, url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Live coordinator returned ${response.status}`)
  return response
}
export async function liveRuns(): Promise<unknown> {
  return (await request('/live/runs')).json()
}
export async function liveEvents(run: string, after = 0): Promise<unknown> {
  if (typeof run !== 'string' || !run || !Number.isSafeInteger(after) || after < 0)
    throw new Error('Invalid live cursor')
  return (await request(`/live/runs/${encodeURIComponent(run)}/events?after=${after}`)).json()
}
export async function liveState(run: string, at?: number): Promise<unknown> {
  if (
    typeof run !== 'string' ||
    !run ||
    (at !== undefined && (!Number.isSafeInteger(at) || at < 0))
  )
    throw new Error('Invalid live position')
  return (
    await request(
      `/live/runs/${encodeURIComponent(run)}/state${at === undefined ? '' : `?at=${at}`}`
    )
  ).json()
}
export async function liveGeometry(sha: string): Promise<unknown> {
  if (!isDigest(sha)) throw new Error('Invalid live asset digest')
  let geo = cache.get(sha)
  if (!geo) {
    const response = await request(`/live/assets/${sha}`)
    if (Number(response.headers.get('content-length')) > 128 * 1024 * 1024)
      throw new Error('Live board is too large')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (
      bytes.length > 128 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !== sha
    )
      throw new Error('Live asset integrity failure')
    geo = fromBytes(bytes)
    cache.set(sha, geo)
    if (cache.size > 4) cache.delete(cache.keys().next().value!)
  }
  return { ...geo, pcb: sha, bbox: bbox(geo) }
}
