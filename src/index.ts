import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import { ZodError } from 'zod';
import { config } from './config.js';
import { pool } from './db/connection.js';
import { authRoutes } from './auth/routes.js';
import { statsRoutes } from './routes/stats.js';
import { hashPassword } from './auth/utils.js';
import { db } from './db/connection.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';

const app = Fastify({
  logger: true,
  bodyLimit: 1024 * 1024, // 1MB — game events are small
  pluginTimeout: 10000,
  connectionTimeout: 15000,
});

// ── Plugins ──────────────────────────────────────────────────────────
await app.register(fastifyCors, { origin: config.CORS_ORIGIN, credentials: true });
await app.register(fastifyJwt, { secret: config.JWT_SECRET });
await app.register(fastifyRateLimit, {
  max: 100,
  timeWindow: '1 minute',
});
await app.register(fastifyHelmet);

// ── Global error handler ─────────────────────────────────────────────
app.setErrorHandler((rawError, _req, reply) => {
  const error = rawError as Error & { code?: string; statusCode?: number; validation?: unknown };

  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: 'Validation failed',
      details: error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  if (error.validation) {
    return reply.status(400).send({ error: 'Validation failed', details: error.validation });
  }

  if (error.code === 'FST_JWT_NO_TOKEN_IN_REQUEST' || error.code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED') {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  app.log.error(error);
  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  return reply.status(statusCode).send({
    error: statusCode === 500 ? 'Internal server error' : error.message,
  });
});

// ── Routes ───────────────────────────────────────────────────────────
await app.register(authRoutes);
await app.register(statsRoutes);

// ── Health check ─────────────────────────────────────────────────────
app.get('/api/health', async () => {
  const checks: Record<string, string> = {};
  let healthy = true;
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    checks.database = 'ok';
  } catch (e) {
    checks.database = 'fail';
    healthy = false;
  }
  return { status: healthy ? 'ok' : 'degraded', timestamp: new Date().toISOString(), checks };
});

// ── Seed admin user (if configured) ──────────────────────────────────
async function seedAdmin() {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, config.ADMIN_EMAIL)).limit(1);
  if (existing) return;

  const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
  await db.insert(users).values({
    email: config.ADMIN_EMAIL,
    passwordHash,
    name: 'Admin',
    role: 'admin',
  });
  console.log(`[seed] Admin user created: ${config.ADMIN_EMAIL}`);
}

// ── Graceful shutdown ────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received — shutting down gracefully...`);
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Start ────────────────────────────────────────────────────────────
try {
  await seedAdmin();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  console.log(`Server running on port ${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
