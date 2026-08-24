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
  // Silent no-op if no plan is attached. This is why billing produced nothing
  // for months: every tenant had planId null, so the job returned here every
  // night without a trace. Now it says so.
  if (!tenant) return;
  if (!tenant.plan?.planId) {
    logger.warn({ tenantId: String(tenantId) }, 'Invoice skipped — tenant has no plan attached');
    return;
  }

  const plan = await Plan.findById(tenant.plan.planId);
  if (!plan) {
    logger.warn({ tenantId: String(tenantId), planId: String(tenant.plan.planId) }, 'Invoice skipped — plan not found');
    return;
  }

  const yearly = plan.billingPeriod === 'yearly';

  /**
   * The term being billed. For an annual plan the new year starts the day the
   * old one ends, so the anniversary is fixed regardless of when they pay.
   */
  const periodStart = yearly && tenant.plan.expiresAt ? new Date(tenant.plan.expiresAt) : new Date();
  const periodEnd = new Date(periodStart);
  if (yearly) periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  else periodStart.setMonth(periodStart.getMonth() - 1);

  // One invoice per term. Re-running the job must not bill twice.
  const already = await Invoice.findOne({
    tenantId,
    periodStart: { $gte: new Date(periodStart.getTime() - 60_000), $lte: new Date(periodStart.getTime() + 60_000) },
    status: { $ne: 'void' },
  });
  if (already) return;

  const price = yearly ? plan.priceYearly : plan.priceMonthly;
  const lines = [
    {
      description: yearly ? `${plan.name.en} plan — 12 months` : `${plan.name.en} plan`,
      quantity: 1,
      unitPrice: price,
      amount: price,
    },
  ];

  /**
   * Overage applies to MONTHLY plans only. Annual plans are sold as unlimited:
   * one predictable line, nothing for the customer to be surprised by, and the
   * hardcoded per-order rate stops applying to anyone on an annual term.
   */
  if (!yearly) {
    const orderCount = await Order.countDocuments({
      tenantId,
      placedAt: { $gte: periodStart, $lt: periodEnd },
      status: { $ne: 'cancelled' },
    });
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
  }

  const subtotal = lines.reduce((sum, l) => sum + l.amount, 0);
  const vatAmount = Math.round(subtotal * 0.05);
  const total = subtotal + vatAmount;

  // Annual: due the day the current term runs out, so paying on time means no
  // gap in service. Monthly keeps the original net-14.
  const dueAt = yearly ? new Date(periodStart) : new Date();
  if (!yearly) dueAt.setDate(dueAt.getDate() + 14);

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

/** How far ahead of expiry the renewal invoice is raised, so it can be paid before service is at risk. */
const RENEW_LEAD_DAYS = 14;

/**
 * Fires daily and raises two kinds of work:
 *
 *  - ANNUAL renewals, driven by `plan.expiresAt` falling inside the lead window.
 *    Not by `billingAnchorDay`: that was compared against `new Date().getDate()`,
 *    so a shop anchored on the 29th–31st was simply skipped in shorter months.
 *  - MONTHLY invoices, still on the anchor day, for any plan left on that term.
 *
 * Trials are excluded from both. They have `trialEndsAt`, not `expiresAt`, so a
 * shop inside its free trial can no longer be sent a bill — which the old
 * `$in: ['trial','active']` filter did, while the Superadmin MRR figure
 * simultaneously ignored them.
 */
export async function scheduleInvoices(): Promise<void> {
  const trigger = new Queue('invoice-trigger', { connection: queueConnection });
  await trigger.upsertJobScheduler('daily-anchor-check', { pattern: '30 1 * * *' }, { name: 'fan-out' });

  new Worker(
    'invoice-trigger',
    async () => {
      const invoiceQueue = new Queue(QUEUE_NAMES.invoices, { connection: queueConnection });

      const leadCutoff = new Date(Date.now() + RENEW_LEAD_DAYS * 24 * 60 * 60 * 1000);
      const renewing = await Tenant.find({
        status: 'active',
        'plan.planId': { $ne: null },
        'plan.expiresAt': { $ne: null, $lte: leadCutoff },
      });

      const monthly = await Tenant.find({
        status: 'active',
        'plan.planId': { $ne: null },
        'plan.expiresAt': null,
        'plan.billingAnchorDay': new Date().getDate(),
      });

      for (const tenant of [...renewing, ...monthly]) {
        await invoiceQueue.add('generate', { tenantId: String(tenant._id) });
      }
      logger.info({ renewals: renewing.length, monthly: monthly.length }, 'Invoice fan-out');
    },
    { connection: queueConnection },
  );

  await scheduleOverdueSweep();
}

/**
 * Marks issued invoices whose due date has passed as `overdue`.
 *
 * Nothing ever wrote this status, though the enum and the whole Superadmin
 * "Overdue Accounts" tile depended on it — so the tile read 0 forever and there
 * was no worklist of who owed money.
 */
export async function sweepOverdueInvoices(): Promise<number> {
  const res = await Invoice.updateMany(
    { status: 'issued', dueAt: { $lt: new Date() } },
    { $set: { status: 'overdue' } },
  );
  if (res.modifiedCount > 0) logger.info({ count: res.modifiedCount }, 'Invoices marked overdue');
  return res.modifiedCount;
}

async function scheduleOverdueSweep(): Promise<void> {
  const trigger = new Queue('invoice-overdue-sweep', { connection: queueConnection });
  await trigger.upsertJobScheduler('daily', { pattern: '45 1 * * *' }, { name: 'sweep' });
  new Worker('invoice-overdue-sweep', async () => { await sweepOverdueInvoices(); }, { connection: queueConnection })
    .on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Overdue sweep failed'));
}
