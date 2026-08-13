import { registerWorker, QUEUE_NAMES } from '../../jobs/queues.js';
import { handleAssignmentTimeout } from './rider.js';

export function startRiderTimeoutWorker(): void {
  registerWorker<{ tenantId: string; orderId: string; riderId: string }>(
    QUEUE_NAMES.riderTimeout,
    handleAssignmentTimeout,
  );
}
