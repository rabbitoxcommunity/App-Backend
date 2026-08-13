import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

export async function connectDb(): Promise<typeof mongoose> {
  mongoose.set('strictQuery', true);

  const conn = await mongoose.connect(env.MONGO_URI);

  const isReplicaSet = Boolean(conn.connection.getClient().options.replicaSet);
  if (!isReplicaSet && env.NODE_ENV !== 'test') {
    logger.warn(
      'MONGO_URI does not specify a replicaSet. Transactions (§13 of the design doc) ' +
        'will fail on a standalone mongod. See .env.example for a local replica-set setup.',
    );
  }

  logger.info({ host: conn.connection.host, db: conn.connection.name }, 'MongoDB connected');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
