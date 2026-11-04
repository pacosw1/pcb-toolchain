// JSON-RPC 2.0 core: one method registry shared by the WebSocket API and the web viewer.
import { AsyncLocalStorage } from 'node:async_hooks'

export const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL_ERROR = -32603

type Handler = (...args: never[]) => unknown

const clients = new AsyncLocalStorage<unknown>()

/** The client whose request is running (the `client` given to Registry.handle), or undefined. */
export const currentClient = (): unknown => clients.getStore()

interface Method { fn: Handler, params: string[], required: number }

const errorText = (id: unknown, code: number, message: string): string =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

export class Registry {
  private methods = new Map<string, Method>()

  /** params names the arguments of fn in order; the first `required` of them must be given. */
  method(name: string, params: string[], required: number, fn: Handler): void {
    if (this.methods.has(name)) throw new Error(`duplicate method ${name}`)
    this.methods.set(name, { fn, params, required })
  }

  names(): string[] { return [...this.methods.keys()].sort() }

  /** The arguments in order. Throws TypeError when the params do not fit the method (-> INVALID_PARAMS). */
  private bind(name: string, params: unknown): unknown[] {
    const m = this.methods.get(name)!
    const given = params !== null && typeof params === 'object' ? params : []
    if (Array.isArray(given)) {
      if (given.length < m.required || given.length > m.params.length) throw new TypeError(`${name}: expected ${m.required} to ${m.params.length} arguments`)
      return given
    }
    const named = given as Record<string, unknown>
    for (const k of Object.keys(named)) if (!m.params.includes(k)) throw new TypeError(`${name}: unexpected argument '${k}'`)
    m.params.slice(0, m.required).forEach(k => { if (!(k in named)) throw new TypeError(`${name}: missing argument '${k}'`) })
    return m.params.map(k => named[k])
  }

  async call(name: string, params?: unknown): Promise<unknown> {
    const args = this.bind(name, params)
    return await (this.methods.get(name)!.fn as (...a: unknown[]) => unknown)(...args)
  }

  /** One request text in, one response text out (null for a notification). `client` identifies the connection for
   *  methods that hold something per client; a transport passes its events.ts sender. */
  handle(raw: string, client?: unknown): Promise<string | null> {
    return clients.run(client, () => this.dispatch(raw))
  }

  private async dispatch(raw: string): Promise<string | null> {
    let req: unknown
    try {
      req = JSON.parse(raw)
    } catch (e) {
      return errorText(null, PARSE_ERROR, `parse error: ${(e as Error).message}`)
    }
    const r = req as { jsonrpc?: unknown, method?: unknown, id?: unknown, params?: unknown } | null
    const isRequest = r !== null && typeof r === 'object' && !Array.isArray(r)
    if (!isRequest || r.jsonrpc !== '2.0' || typeof r.method !== 'string') return errorText(isRequest ? r.id : null, INVALID_REQUEST, 'invalid request')
    const { id, method, params } = r
    if (!this.methods.has(method as string)) return errorText(id, METHOD_NOT_FOUND, `method not found: ${method as string}`)
    try {
      this.bind(method as string, params)
    } catch (e) {
      return errorText(id, INVALID_PARAMS, (e as Error).message)
    }
    let result: unknown
    try {
      result = await this.call(method as string, params)
    } catch (e) {                                   // reported to the caller, never swallowed
      return errorText(id, INTERNAL_ERROR, `${(e as Error).name}: ${(e as Error).message}`)
    }
    return id === undefined || id === null ? null : JSON.stringify({ jsonrpc: '2.0', id, result: result ?? null })
  }
}
