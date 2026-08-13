import { registerWorker, QUEUE_NAMES } from '../../jobs/queues.js';
import { runCommit } from './service.js';

export function startImportWorker(): void {
  registerWorker<{ tenantId: string; batchId: string }>(QUEUE_NAMES.import, async (data) => {
    await runCommit(data.tenantId, data.batchId);
  });
}
