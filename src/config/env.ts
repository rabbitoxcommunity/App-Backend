import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_BASE_PATH: z.string().default('/api/v1'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('60m'),
  REFRESH_TTL_DAYS: z.coerce.number().default(60),

  ARGON2_MEMORY_KB: z.coerce.number().default(19456),
  ARGON2_TIME_COST: z.coerce.number().default(2),

  S3_ENDPOINT: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_KEY: z.string().default(''),
  S3_SECRET: z.string().default(''),
  S3_PUBLIC_BASE: z.string().default(''),

  OTP_PROVIDER: z.enum(['console', 'sms', 'whatsapp']).default('console'),
  OTP_API_KEY: z.string().default(''),
  OTP_SENDER_ID: z.string().default(''),
  WHATSAPP_BSP_KEY: z.string().default(''),

  EXPO_ACCESS_TOKEN: z.string().default(''),

  ENCRYPTION_KEY: z.string().default(''),

  DEFAULT_TIMEZONE: z.string().default('Asia/Dubai'),

  PLATFORM_ORIGIN: z.string().default('http://localhost:5174'),
  ADMIN_ORIGIN_PATTERN: z.string().default('http://localhost:5173'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
