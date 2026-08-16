import mongoose from 'mongoose';
import argon2 from 'argon2';
import { PlatformUser } from '../models/PlatformUser.js';
import { generateTotpSecret } from '../lib/totp.js';
import { env } from '../config/env.js';

/** One-off: seeds the first superAdmin account so the Superadmin portal has something to log in with. */
async function main() {
  await mongoose.connect(env.MONGO_URI);

  const email = 'owner@freshcart.platform';
  const password = 'PlatformOwner123!';
  const secret = generateTotpSecret();
  const passwordHash = await argon2.hash(password, {
    memoryCost: env.ARGON2_MEMORY_KB,
    timeCost: env.ARGON2_TIME_COST,
  });

  await PlatformUser.deleteOne({ email });
  await PlatformUser.create({ email, name: 'Platform Owner', passwordHash, mfaSecret: secret, active: true });

  console.log(JSON.stringify({ email, password, totpSecret: secret }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
