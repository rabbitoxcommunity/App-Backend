import { startImportWorker } from '../modules/import/worker.js';
import { startRiderTimeoutWorker } from '../modules/orders/riderTimeoutWorker.js';
import { startRollupWorker, scheduleRollups } from './rollups.js';
import { startInvoiceWorker, scheduleInvoices } from './invoices.js';
import { registerNotificationListeners } from '../modules/notifications/listeners.js';
import { logger } from '../config/logger.js';

/** Starts every BullMQ worker + repeatable schedule. Called once from server.ts. */
export async function startAllWorkers(): Promise<void> {
  startImportWorker();
  startRiderTimeoutWorker();
  startRollupWorker();
  startInvoiceWorker();
  registerNotificationListeners();
  await scheduleRollups();
  await scheduleInvoices();
  logger.info('Background workers started');
}
