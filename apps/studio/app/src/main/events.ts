// Server-to-client notifications (JSON-RPC 2.0 notifications without id). Port of engine/src/pcbstudio/events.py.
export type Sender = (text: string) => void | Promise<void>

const subscribers = new Set<Sender>()

export function subscribe(send: Sender): void { subscribers.add(send) }

export function unsubscribe(send: Sender): void { subscribers.delete(send) }

/** Fire and forget to every connected client; a closed client is dropped. */
export function publish(method: string, params: unknown): void {
  const text = JSON.stringify({ jsonrpc: '2.0', method, params })
  for (const send of [...subscribers]) {
    Promise.resolve().then(() => send(text)).catch(() => unsubscribe(send))
  }
}
