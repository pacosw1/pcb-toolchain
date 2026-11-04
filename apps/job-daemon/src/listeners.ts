import type http from 'node:http';

/** Start the local health endpoint only after the primary API is listening. */
export async function startListeners(server: http.Server, health: http.Server, port: number, bind: string, socket: string): Promise<void> {
  const listen = (target: http.Server, options: { port: number; host: string } | { path: string }) => new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { target.off('listening', ready); reject(error); };
    const ready = () => { target.off('error', fail); resolve(); };
    target.once('error', fail); target.once('listening', ready); target.listen(options);
  });
  try {
    await listen(server, { port, host: bind });
    await listen(health, { path: socket });
  } catch (error) {
    health?.close(); server.close();
    throw error;
  }
}
