import http from 'node:http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDb, disconnectDb } from './config/db.js';
import { disconnectRedis } from './config/redis.js';
import { buildApp } from './app.js';
import { attachSocketServer } from './realtime/io.js';
import { startAllWorkers } from './jobs/index.js';
import { closeWorkers } from './jobs/queues.js';

async function main(): Promise<void> {
  await connectDb();

  const app = buildApp();
  const server = http.createServer(app);
  attachSocketServer(server);
  await startAllWorkers();

  server.listen(env.PORT, () => {
    logger.info(`FreshCart backend listening on :${env.PORT}${env.API_BASE_PATH}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    server.close(async () => {
      await closeWorkers();
      await disconnectDb();
      await disconnectRedis();
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error during startup');
  process.exit(1);
});
