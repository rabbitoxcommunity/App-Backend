import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../config/db.js';
import { User } from '../models/User.js';
import { logger } from '../config/logger.js';

/**
 * One-off migration for the phone-uniqueness change in models/User.ts.
 *
 * `{ tenantId, phone }` used to be unique across EVERY user. It is now unique
 * only for customers, so the staff of a shop with a single phone number can
 * all be registered on it.
 *
 * This needs a script because Mongoose cannot do it: autoIndex only CREATES
 * missing indexes. Faced with an existing index of the same name and
 * different options it raises IndexOptionsConflict and carries on, so the old
 * constraint would keep rejecting staff no matter how the schema reads.
 *
 * Safe to run more than once.
 *
 *   npm run fix:phone-index
 */
const INDEX_NAME = 'tenantId_1_phone_1';

async function main(): Promise<void> {
  await connectDb();
  const collection = mongoose.connection.collection('users');

  const indexes = (await collection.indexes()) as Array<{
    name?: string;
    partialFilterExpression?: Record<string, unknown>;
  }>;
  const existing = indexes.find((i) => i.name === INDEX_NAME);

  if (!existing) {
    logger.info(`No "${INDEX_NAME}" index found — nothing to drop.`);
  } else if (existing.partialFilterExpression) {
    logger.info(`"${INDEX_NAME}" is already partial — migration has run before.`);
    await disconnectDb();
    return;
  } else {
    // A duplicate phone among CUSTOMERS would break the OTP lookup, so refuse
    // to drop the constraint while one exists rather than quietly allowing it.
    const dupes = await collection
      .aggregate([
        { $match: { role: 'customer' } },
        { $group: { _id: { tenantId: '$tenantId', phone: '$phone' }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();

    if (dupes.length > 0) {
      logger.error(
        { dupes },
        'Customers share a phone number. Resolve these before migrating — the new index ' +
          'still requires customer phones to be unique and would fail to build.',
      );
      await disconnectDb();
      process.exitCode = 1;
      return;
    }

    await collection.dropIndex(INDEX_NAME);
    logger.info(`Dropped the old all-roles unique index "${INDEX_NAME}".`);
  }

  await User.createIndexes();
  logger.info('Rebuilt user indexes — phone is now unique for customers only.');

  await disconnectDb();
}

main().catch(async (err) => {
  logger.error({ err }, 'Index migration failed');
  await disconnectDb();
  process.exit(1);
});
