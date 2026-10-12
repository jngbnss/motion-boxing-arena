// 진입점: `node src/main.ts` (Node ≥22.18 타입 스트리핑)
import { createServer } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const server = await createServer(config);
const port = await server.listen();
server.app.log.info(
  { port, db: server.ctx.db.kind, dataDir: config.dataDir, publicBaseUrl: config.publicBaseUrl, simLatencyMs: config.simLatencyMs },
  `Motion Boxing Arena server listening on :${port} (REST ${'/api/v1'}, Colyseus room "duel")`,
);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  server.app.log.info({ signal }, 'shutting down');
  try {
    await server.close();
    process.exit(0);
  } catch (err) {
    server.app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
