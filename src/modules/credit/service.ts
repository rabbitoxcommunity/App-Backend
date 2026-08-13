import { Types, type ClientSession } from 'mongoose';
import { CreditAccount } from '../../models/CreditAccount.js';
import { CreditEntry } from '../../models/CreditEntry.js';
import { User } from '../../models/User.js';
import type { Localized } from '../../lib/localized.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor, cursorFilter } from '../../lib/cursorPagination.js';
import { domainEvents } from '../../lib/domainEvents.js';

export type AppendEntryInput = {
  tenantId: Types.ObjectId;
  customerId: Types.ObjectId;
  kind: 'charge' | 'payment';
  title: Localized;
  subtitle?: Localized;
  amount: number; // fils; positive charge, negative payment
  orderId?: Types.ObjectId | null;
  recordedBy?: Types.ObjectId | null;
};

/**
 * §13.2 CREDIT LEDGER APPEND — the fix for CMS-SCOPE §2's CRITICAL item.
 * MUST run inside an active mongoose session/transaction. Appends the
 * entry, recomputes the balance, writes balanceAfter, and enforces
 * `balance + amount <= limit` for charges.
 */
export async function appendLedgerEntry(input: AppendEntryInput, session: ClientSession) {
  const account = await CreditAccount.findOne({
    tenantId: input.tenantId,
    customerId: input.customerId,
  }).session(session);

  if (!account) {
    throw new AppError('CREDIT_NOT_APPROVED', 'This customer has no credit account.');
  }

  if (input.kind === 'charge' && account.balance + input.amount > account.limit) {
    throw new AppError('CREDIT_LIMIT_EXCEEDED', 'This charge would exceed the credit limit.', {
      limit: account.limit,
      currentBalance: account.balance,
      attempted: input.amount,
    });
  }

  const balanceAfter = account.balance + input.amount;

  const [entry] = await CreditEntry.create(
    [
      {
        tenantId: input.tenantId,
        accountId: account._id,
        customerId: input.customerId,
        kind: input.kind,
        title: input.title,
        subtitle: input.subtitle ?? { en: '', ar: '' },
        amount: input.amount,
        balanceAfter,
        orderId: input.orderId ?? null,
        recordedBy: input.recordedBy ?? null,
      },
    ],
    { session },
  );

  account.balance = balanceAfter;
  await account.save({ session });

  return entry!;
}

export async function getAccount(tenantId: Types.ObjectId, customerId: Types.ObjectId) {
  const account = await CreditAccount.findOne({ tenantId, customerId });
  if (!account) throw AppError.notFound('Credit account');
  return account;
}

export async function listEntries(
  tenantId: Types.ObjectId,
  customerId: Types.ObjectId,
  opts: { cursor?: string; limit: number },
) {
  const account = await CreditAccount.findOne({ tenantId, customerId });
  if (!account) throw AppError.notFound('Credit account');

  const cursor = decodeCursor(opts.cursor);
  const filter = { tenantId, accountId: account._id, ...cursorFilter('at', cursor) };
  const items = await CreditEntry.find(filter)
    .sort({ at: -1, _id: -1 })
    .limit(opts.limit + 1);

  const hasMore = items.length > opts.limit;
  const page = items.slice(0, opts.limit);
  const last = page[page.length - 1];

  return {
    items: page,
    nextCursor: hasMore && last ? encodeCursor(last.at.getTime(), String(last._id)) : null,
  };
}

/** §4.13/§19.1 — a new customer's credit account, created when a manager approves them. */
export async function approveCredit(
  tenantId: Types.ObjectId,
  customerId: string,
  limit: number,
  approvedBy: Types.ObjectId,
) {
  const customer = await User.findOne({ _id: customerId, tenantId, role: 'customer' });
  if (!customer) throw AppError.notFound('Customer');

  customer.creditApproved = true;
  await customer.save();

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 30);

  const account = await CreditAccount.findOneAndUpdate(
    { tenantId, customerId },
    { limit, dueDate, approvedBy, approvedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return account;
}

export async function adminListEntries(
  tenantId: Types.ObjectId,
  customerId: string,
  opts: { cursor?: string; limit: number },
) {
  return listEntries(tenantId, new Types.ObjectId(customerId), opts);
}

export async function recordPayment(
  tenantId: Types.ObjectId,
  customerId: string,
  amountFils: number,
  recordedBy: Types.ObjectId,
  session: ClientSession,
) {
  const entry = await appendLedgerEntry(
    {
      tenantId,
      customerId: new Types.ObjectId(customerId),
      kind: 'payment',
      title: { en: 'Payment received', ar: 'تم استلام دفعة' },
      amount: -Math.abs(amountFils),
      recordedBy,
    },
    session,
  );
  domainEvents.emit('credit.payment.recorded', { tenantId: String(tenantId), customerId, entry });
  return entry;
}

export async function creditExposure(tenantId: Types.ObjectId) {
  const accounts = await CreditAccount.find({ tenantId, balance: { $gt: 0 } }).sort({ balance: -1 });
  const totalExposure = accounts.reduce((sum, a) => sum + a.balance, 0);
  const overdue = accounts.filter((a) => a.dueDate < new Date());

  // ADMIN GAP FILL — the Credit screen needs the customer's name and phone,
  // same join pattern as modules/orders/service.ts#withCustomerInfo.
  const customerIds = accounts.map((a) => a.customerId);
  const customers = await User.find({ _id: { $in: customerIds } }, { name: 1, phone: 1 });
  const byId = new Map(customers.map((c) => [String(c._id), { name: c.name, phone: c.phone }]));
  const accountsWithCustomer = accounts.map((a) => ({
    ...a.toJSON(),
    customer: byId.get(String(a.customerId)) ?? null,
    overdue: a.dueDate < new Date(),
  }));

  // ADMIN GAP FILL — "settled this month" tile on the Credit screen.
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const monthPayments = await CreditEntry.find({ tenantId, kind: 'payment', at: { $gte: startOfMonth } });
  const monthSettled = monthPayments.reduce((sum, e) => sum + Math.abs(e.amount), 0);

  return {
    totalExposure,
    accountCount: accounts.length,
    overdueCount: overdue.length,
    accounts: accountsWithCustomer,
    monthSettled,
    monthSettledCount: monthPayments.length,
  };
}
