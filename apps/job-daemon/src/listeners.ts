import type http from 'node:http';

/** Start the local health endpoint only after the primary API is listening. */
export async function startListeners(server: http.Server, health: http.Server | null, port: number, bind: string): Promise<void> {
  const listen = (target: http.Server, host: string, listenPort: number) => new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { target.off('listening', ready); reject(error); };
    const ready = () => { target.off('error', fail); resolve(); };
    target.once('error', fail); target.once('listening', ready); target.listen(listenPort, host);
  });
  try {
    await listen(server, bind, port);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('primary API has no TCP address');
    if (health) await listen(health, '127.0.0.1', address.port);
  } catch (error) {
    health?.close(); server.close();
    throw error;
  }
}
