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

  // Only CHARGES are blocked on a revoked account. A payment must always be
  // allowed through: withdrawing someone's credit does not clear what they
  // already owe, and refusing to record their repayment would strand the
  // balance for ever — including a rider collecting cash at the door.
  if (!account.active && input.kind === 'charge') {
    throw new AppError('CREDIT_NOT_APPROVED', 'Credit has been disabled for this customer.');
  }

  // A null limit is unlimited, so there is no ceiling to breach. Written as
  // an explicit null check rather than relying on comparison: `x > null`
  // coerces null to 0 in JS, which would reject every single charge.
  if (input.kind === 'charge' && account.limit != null && account.balance + input.amount > account.limit) {
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
/** `limit` of null grants unlimited credit — see models/CreditAccount.ts. */
export async function approveCredit(
  tenantId: Types.ObjectId,
  customerId: string,
  limit: number | null,
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
    // `active: true` matters on re-approval as much as on the first grant —
    // this is also the path that restores credit to a customer it was
    // withdrawn from, and their old account row is still sitting there
    // inactive.
    { limit, dueDate, approvedBy, approvedAt: new Date(), active: true },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return account;
}

/**
 * Withdraw credit. Deliberately NOT a delete: the account and every ledger
 * entry stay, because a customer whose credit is pulled usually still owes
 * something, and the shop needs the history to chase it. What changes is
 * that no new charge can be raised against it.
 *
 * `creditApproved` on the User is cleared too — that flag is what the
 * customer app reads to decide whether to offer Pay Later at all, so without
 * it the option would keep appearing and only fail at checkout.
 */
export async function revokeCredit(tenantId: Types.ObjectId, customerId: string) {
  const customer = await User.findOne({ _id: customerId, tenantId, role: 'customer' });
  if (!customer) throw AppError.notFound('Customer');

  const account = await CreditAccount.findOne({ tenantId, customerId });
  if (!account) throw new AppError('CREDIT_NOT_APPROVED', 'This customer has no credit account.');

  customer.creditApproved = false;
  await customer.save();

  account.active = false;
  await account.save();

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
