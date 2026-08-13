import argon2 from 'argon2';
import { Types, type FilterQuery } from 'mongoose';
import { User } from '../../models/User.js';
import { AppError } from '../../lib/errors.js';
import { assertStaffSeatLimit } from '../../lib/planLimits.js';
import { env } from '../../config/env.js';

/**
 * ADMIN GAP FILL — §10/§5.2 of the design doc lists `CRUD /admin/staff
 * storeAdmin + deliveryStaff` in the route table, but no module implements
 * it. The Staff.jsx screen in the CMS needs to list, add and update both
 * storeAdmin and deliveryStaff accounts, so this fills that gap.
 */

export async function listStaff(tenantId: Types.ObjectId, opts: { role?: 'storeAdmin' | 'deliveryStaff' }) {
  const filter: FilterQuery<typeof User> = {
    tenantId,
    role: opts.role ?? { $in: ['storeAdmin', 'deliveryStaff'] },
  };
  return User.find(filter).sort({ createdAt: -1 });
}

export async function getStaffMember(tenantId: Types.ObjectId, id: string) {
  const member = await User.findOne({
    _id: id,
    tenantId,
    role: { $in: ['storeAdmin', 'deliveryStaff'] },
  });
  if (!member) throw AppError.notFound('Staff member');
  return member;
}

export type CreateStaffInput = {
  role: 'storeAdmin' | 'deliveryStaff';
  name: string;
  phone: string;
  email?: string;
  password: string;
  permissions?: 'owner' | 'manager' | 'staff'; // storeAdmin only
  vehicle?: { type: 'bike' | 'van' | 'car'; plate: string };
};

export async function createStaff(tenantId: Types.ObjectId, input: CreateStaffInput) {
  await assertStaffSeatLimit(tenantId);

  if (input.role === 'storeAdmin' && !input.permissions) {
    throw AppError.validationFailed({ permissions: 'Required for storeAdmin accounts.' });
  }
  if (input.role === 'storeAdmin' && !input.email) {
    throw AppError.validationFailed({ email: 'Required for storeAdmin accounts (used to log in).' });
  }

  const passwordHash = await argon2.hash(input.password, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });

  return User.create({
    tenantId,
    role: input.role,
    name: input.name,
    phone: input.phone,
    email: input.email ?? null,
    passwordHash,
    permissions: input.role === 'storeAdmin' ? input.permissions : null,
    vehicle: input.role === 'deliveryStaff' ? input.vehicle : undefined,
    availability: input.role === 'deliveryStaff' ? 'off_shift' : undefined,
  });
}

export type UpdateStaffInput = Partial<{
  name: string;
  phone: string;
  email: string | null;
  permissions: 'owner' | 'manager' | 'staff';
  vehicle: { type: 'bike' | 'van' | 'car'; plate: string };
  status: 'active' | 'blocked' | 'offShift';
}>;

export async function updateStaff(tenantId: Types.ObjectId, id: string, input: UpdateStaffInput) {
  const member = await getStaffMember(tenantId, id);
  Object.assign(member, input);
  await member.save();
  return member;
}

export async function resetStaffPassword(tenantId: Types.ObjectId, id: string, newPassword: string) {
  const member = await getStaffMember(tenantId, id);
  member.passwordHash = await argon2.hash(newPassword, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });
  await member.save();
}

export async function deactivateStaff(tenantId: Types.ObjectId, id: string) {
  const member = await getStaffMember(tenantId, id);
  member.status = 'blocked';
  await member.save();
  return member;
}
