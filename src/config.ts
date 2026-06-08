import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres:password@localhost:5432/gamehub'),
  JWT_SECRET: z.string(),
  PORT: z.coerce.number().default(3000),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  ADMIN_EMAIL: z.string().email().optional(),
  ADMIN_PASSWORD: z.string().min(8).optional(),
});

export const config = envSchema.parse(process.env);
