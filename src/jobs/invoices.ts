import { Queue, Worker } from 'bullmq';
import { Types } from 'mongoose';
import { Tenant } from '../models/Tenant.js';
import { Plan } from '../models/Plan.js';
import { Invoice } from '../models/Invoice.js';
import { Order } from '../models/Order.js';
import { queueConnection, QUEUE_NAMES } from './queues.js';
import { logger } from '../config/logger.js';
import { domainEvents } from '../lib/domainEvents.js';

/**
 * §19.3 BILLING. Monthly, per tenant, on the tenant's billing anchor day —
 * plan fee + overage lines, 5% UAE VAT, sequential per-year numbering, due
 * 14 days. RULE: never block an order for a billing limit (§19.2) — this
 * job only invoices; it never suspends. Suspension is a deliberate human
 * action (§19.4).
 */
async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await Invoice.countDocuments({ number: new RegExp(`^INV-${year}-`) });
  return `INV-${year}-${String(count + 1).padStart(4, '0')}`;
}

export async function generateInvoice(tenantId: Types.ObjectId): Promise<void> {
  const tenant = await Tenant.findById(tenantId);
  if (!tenant || !tenant.plan?.planId) return;

  const plan = await Plan.findById(tenant.plan.planId);
  if (!plan) return;

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd);
  periodStart.setMonth(periodStart.getMonth() - 1);

  const orderCount = await Order.countDocuments({
    tenantId,
    placedAt: { $gte: periodStart, $lt: periodEnd },
    status: { $ne: 'cancelled' },
  });

  const lines = [
    { description: `${plan.name.en} plan`, quantity: 1, unitPrice: plan.priceMonthly, amount: plan.priceMonthly },
  ];

  const overageOrders = Math.max(0, orderCount - plan.limits!.ordersPerMonth);
  if (overageOrders > 0) {
    const overageFee = 50; // fils per order over the plan limit — a placeholder rate, tune per commercial terms
    lines.push({
      description: `Order overage (${overageOrders} orders over plan limit)`,
      quantity: overageOrders,
      unitPrice: overageFee,
      amount: overageOrders * overageFee,
    });
  }

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const vatAmount = Math.round(subtotal * 0.05);
  const total = subtotal + vatAmount;

  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + 14);

  const invoice = await Invoice.create({
    tenantId,
    number: await nextInvoiceNumber(),
    periodStart,
    periodEnd,
    lines,
    subtotal,
    vatAmount,
    total,
    status: 'issued',
    issuedAt: new Date(),
    dueAt,
  });

  domainEvents.emit('invoice.issued', { tenantId: String(tenantId), invoice });
}

export function startInvoiceWorker(): void {
  new Worker(
    QUEUE_NAMES.invoices,
    async (job) => {
      await generateInvoice(new Types.ObjectId(job.data.tenantId as string));
    },
    { connection: queueConnection },
  ).on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Invoice job failed'));
}

/** Fires daily; fans out to tenants whose billing anchor day is today. */
export async function scheduleInvoices(): Promise<void> {
  const trigger = new Queue('invoice-trigger', { connection: queueConnection });
  await trigger.upsertJobScheduler('daily-anchor-check', { pattern: '30 1 * * *' }, { name: 'fan-out' });

  new Worker(
    'invoice-trigger',
    async () => {
      const invoiceQueue = new Queue(QUEUE_NAMES.invoices, { connection: queueConnection });
      const today = new Date().getDate();
      const tenants = await Tenant.find({ status: { $in: ['trial', 'active'] }, 'plan.billingAnchorDay': today });
      for (const tenant of tenants) {
        await invoiceQueue.add('generate', { tenantId: String(tenant._id) });
      }
    },
    { connection: queueConnection },
  );
}
