import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => res(p)); });
    srv.on('error', rej);
  });
}

/**
 * A throw-away PostgreSQL server for integration tests. Uses TEST_DATABASE_URL
 * when set (e.g. the CI service container); otherwise starts a real PostgreSQL
 * binary via embedded-postgres in a temporary directory.
 */
export async function startPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'kc-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'kernelcraft', password: 'kernelcraft', port, persistent: false,
    // postgres refuses to run as root; embedded-postgres can create an unprivileged user for it
    createPostgresUser: typeof process.getuid === 'function' && process.getuid() === 0,
    onLog: () => {}, onError: () => {}
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('kc_test');
  return {
    url: `postgres://kernelcraft:kernelcraft@127.0.0.1:${port}/kc_test`,
    stop: async () => { await pg.stop(); rmSync(dir, { recursive: true, force: true }); }
  };
}
