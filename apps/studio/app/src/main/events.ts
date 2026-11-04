// Server-to-client notifications (JSON-RPC 2.0 notifications without id). Port of engine/src/pcbstudio/events.py.
export type Sender = (text: string) => void | Promise<void>

const subscribers = new Set<Sender>()
const goneHooks = new Set<(send: Sender) => void>()

export function subscribe(send: Sender): void { subscribers.add(send) }

export function unsubscribe(send: Sender): void {
  if (subscribers.delete(send)) for (const hook of goneHooks) hook(send)
}

/** Call `hook` with each client that goes away, so what it held can be released. */
export function onUnsubscribe(hook: (send: Sender) => void): void { goneHooks.add(hook) }

/** Fire and forget to every connected client; a closed client is dropped. */
export function publish(method: string, params: unknown): void {
  const text = JSON.stringify({ jsonrpc: '2.0', method, params })
  for (const send of [...subscribers]) {
    Promise.resolve().then(() => send(text)).catch(() => unsubscribe(send))
  }
}
