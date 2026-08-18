import argon2 from 'argon2';
import { Types, type FilterQuery } from 'mongoose';
import { User } from '../../models/User.js';
import { Order } from '../../models/Order.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { AppError } from '../../lib/errors.js';
import { assertStaffSeatLimit } from '../../lib/planLimits.js';
import { normalizePhone } from '../../lib/phone.js';
import { env } from '../../config/env.js';

/**
 * ADMIN GAP FILL — §10/§5.2 of the design doc lists `CRUD /admin/staff
 * storeAdmin + deliveryStaff` in the route table, but no module implements
 * it. The Staff.jsx screen in the CMS needs to list, add and update both
 * storeAdmin and deliveryStaff accounts, so this fills that gap.
 */

/**
 * User.phone is documented as E.164 (see models/User.ts and lib/phone.ts),
 * but this module used to store whatever the admin typed into the Staff
 * screen. That was invisible until delivery staff gained a phone + password
 * login: that flow normalises the number the rider types before looking them
 * up, so a rider stored as "050 214 8873" could never be matched by
 * "+971502148873" and simply could not sign in.
 *
 * Normalisation only — no format check. The number is a login identifier
 * here, not something an SMS has to reach, so rejecting anything that is not
 * a UAE mobile would lock out rosters this system is perfectly able to
 * serve. What matters is that write and login normalise identically.
 */
function normalizeStaffPhone(raw: string): string {
  return normalizePhone(raw);
}

/**
 * Staff may share a phone number — a small shop often has exactly one. That
 * makes the PASSWORD the thing that tells two riders on that number apart at
 * login (see deliveryLogin), so two of them sharing both would leave one
 * account permanently unreachable: whichever the lookup happened to verify
 * first would always win.
 *
 * So it is rejected at the point it is created, where it can still be
 * explained, rather than discovered later as "my login opens someone else's
 * deliveries".
 */
async function assertPasswordDistinctOnPhone(
  tenantId: Types.ObjectId,
  phone: string,
  password: string,
  excludeId?: Types.ObjectId | string,
): Promise<void> {
  const filter: FilterQuery<typeof User> = {
    tenantId,
    phone,
    role: { $in: ['storeAdmin', 'deliveryStaff'] },
  };
  if (excludeId) filter._id = { $ne: excludeId };

  const siblings = await User.find(filter).select('+passwordHash');
  for (const sibling of siblings) {
    if (!sibling.passwordHash) continue;
    if (await argon2.verify(sibling.passwordHash, password)) {
      throw AppError.conflict(
        'Another staff member on this phone number already uses that password. ' +
          'Give this one a different password so they can be told apart at login.',
        { field: 'password' },
      );
    }
  }
}

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

  const phone = normalizeStaffPhone(input.phone);
  await assertPasswordDistinctOnPhone(tenantId, phone, input.password);

  const passwordHash = await argon2.hash(input.password, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });

  return User.create({
    tenantId,
    role: input.role,
    name: input.name,
    phone,
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
  // NOTE: moving a member ONTO a phone number where someone already uses the
  // same password cannot be detected here — argon2 hashes are salted, so two
  // identical passwords do not compare equal, and the plaintext is not in an
  // update payload. The collision is caught on create and on password reset,
  // which is where a password is actually chosen.
  if (input.phone !== undefined) member.phone = normalizeStaffPhone(input.phone);
  await member.save();
  return member;
}

export async function resetStaffPassword(tenantId: Types.ObjectId, id: string, newPassword: string) {
  const member = await getStaffMember(tenantId, id);
  await assertPasswordDistinctOnPhone(tenantId, member.phone, newPassword, member._id);
  member.passwordHash = await argon2.hash(newPassword, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });
  await member.save();
}

/**
 * HARD delete — the row is removed, not flagged. Blocking someone without
 * erasing them is still available through PATCH /admin/staff/:id with
 * `status: 'blocked'`, which is the right tool for a suspension; this is for
 * a person who should not be on the roster at all.
 *
 * Three things have to be true before a staff row can go, because none of
 * them can be undone afterwards:
 *
 *  1. Nobody deletes themselves. An owner who does is locked out of the shop
 *     with no way back in.
 *  2. The last owner stays. §5.2 makes owner the only grade that can manage
 *     staff, so removing the last one leaves a shop nobody can administer.
 *  3. A rider holding live orders stays. Their `rider.userId` is what the
 *     delivery app and the dispatch queue match on; deleting them mid-round
 *     strands those orders with an owner who no longer exists, and the
 *     auto-assignment path will not pick them up because they are already
 *     assigned. Reassign or cancel first.
 *
 * Completed orders keep rendering fine: `rider.name` and `rider.phone` are
 * snapshotted onto the order itself, so history does not depend on this row
 * surviving.
 */
export async function deleteStaff(
  tenantId: Types.ObjectId,
  id: string,
  actor: { userId: Types.ObjectId },
) {
  const member = await getStaffMember(tenantId, id);

  if (String(member._id) === String(actor.userId)) {
    throw AppError.conflict('You cannot delete your own account.');
  }

  if (member.role === 'storeAdmin' && member.permissions === 'owner') {
    const owners = await User.countDocuments({
      tenantId,
      role: 'storeAdmin',
      permissions: 'owner',
      status: 'active',
    });
    if (owners <= 1) {
      throw AppError.conflict(
        'This is the last owner account. Promote another staff member to owner before deleting it.',
      );
    }
  }

  if (member.role === 'deliveryStaff') {
    // Terminal statuses per lib/orderFlow.ts isTerminal(). `handed_over` has
    // to be in this list: it is the curbside chain's completed state, and
    // omitting it made a finished order look like one still in the rider's
    // hands. `fulfillment` is pinned too — a rider only ever holds delivery
    // orders, and curbside is closed out by counter staff.
    const live = await Order.find({
      tenantId,
      fulfillment: 'delivery',
      'rider.userId': member._id,
      status: { $nin: ['delivered', 'handed_over', 'cancelled'] },
    }).select('reference');

    if (live.length > 0) {
      throw AppError.conflict(
        `This rider still has ${live.length} order(s) in hand. Reassign or cancel them first.`,
        { orders: live.map((o) => o.reference) },
      );
    }
  }

  // Delete the sessions before the user. A refresh token outliving its owner
  // would otherwise sit there until it expired; refreshTokenPair would reject
  // it once the user lookup failed, but leaving live credentials for a
  // deleted account is not something to rely on a downstream check for.
  //
  // NOTE: this does NOT reach an access token already issued. Those are
  // stateless JWTs verified on their signature alone, so a deleted member
  // keeps API access until theirs expires — up to JWT_ACCESS_TTL (60m by
  // default). Closing that gap needs a revocation list checked per request.
  await RefreshToken.deleteMany({ userId: member._id });
  await User.deleteOne({ _id: member._id, tenantId });

  return { id: String(member._id), name: member.name, role: member.role };
}
