import mongoose, { Types } from 'mongoose';
import { Address, type AddressDoc } from '../../models/Address.js';
import { AppError } from '../../lib/errors.js';
import type { Localized } from '../../lib/localized.js';

export type AddressInput = {
  label: Localized;
  lines: Localized;
  phone?: string | null;
  geo?: { lat: number; lng: number } | null;
  isPrimary?: boolean;
};

export async function listAddresses(tenantId: Types.ObjectId, customerId: Types.ObjectId) {
  return Address.find({ tenantId, customerId, archivedAt: null }).sort({ isPrimary: -1, createdAt: -1 });
}

/**
 * §13.1 ADDRESS PRIMARY SWAP. Without a transaction, a failure between
 * clearing the old primary and setting the new one leaves zero or two
 * primaries — the app's AddressesContext assumes exactly one always exists.
 */
export async function createAddress(
  tenantId: Types.ObjectId,
  customerId: Types.ObjectId,
  input: AddressInput,
): Promise<AddressDoc> {
  const session = await mongoose.startSession();
  let address!: AddressDoc;
  try {
    await session.withTransaction(async () => {
      const existingCount = await Address.countDocuments({ tenantId, customerId, archivedAt: null }).session(
        session,
      );
      const makePrimary = input.isPrimary || existingCount === 0;

      if (makePrimary) {
        await Address.updateMany({ tenantId, customerId, isPrimary: true }, { isPrimary: false }, { session });
      }

      const [created] = await Address.create(
        [{ tenantId, customerId, ...input, isPrimary: makePrimary }],
        { session },
      );
      address = created!;
    });
  } finally {
    await session.endSession();
  }
  return address;
}

export async function updateAddress(
  tenantId: Types.ObjectId,
  customerId: Types.ObjectId,
  id: string,
  input: Partial<AddressInput>,
): Promise<AddressDoc> {
  const session = await mongoose.startSession();
  let address!: AddressDoc;
  try {
    await session.withTransaction(async () => {
      const found = await Address.findOne({ _id: id, tenantId, customerId }).session(session);
      if (!found) throw AppError.notFound('Address');

      if (input.isPrimary === true && !found.isPrimary) {
        await Address.updateMany({ tenantId, customerId, isPrimary: true }, { isPrimary: false }, { session });
      }
      if (input.isPrimary === false && found.isPrimary) {
        throw new AppError('PRIMARY_ADDRESS_REQUIRED', 'Set a different address as primary first.');
      }

      Object.assign(found, input);
      await found.save({ session });
      address = found;
    });
  } finally {
    await session.endSession();
  }
  return address;
}

export async function deleteAddress(tenantId: Types.ObjectId, customerId: Types.ObjectId, id: string): Promise<void> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const found = await Address.findOne({ _id: id, tenantId, customerId }).session(session);
      if (!found) throw AppError.notFound('Address');

      found.archivedAt = new Date();
      const wasPrimary = found.isPrimary;
      found.isPrimary = false;
      await found.save({ session });

      if (wasPrimary) {
        const next = await Address.findOne({ tenantId, customerId, archivedAt: null }).sort({ createdAt: 1 }).session(
          session,
        );
        if (next) {
          next.isPrimary = true;
          await next.save({ session });
        }
      }
    });
  } finally {
    await session.endSession();
  }
}
