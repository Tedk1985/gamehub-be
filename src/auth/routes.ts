import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/connection.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword } from './utils.js';
import { eq } from 'drizzle-orm';
import { requireAuth } from './middleware.js';

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_LOGIN_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginAttempts) {
    if (now > e.resetAt) loginAttempts.delete(ip);
  }
}, WINDOW_MS);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().min(2).max(100),
});

function authResponse(user: typeof users.$inferSelect, app: FastifyInstance) {
  const token = app.jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    { expiresIn: '7d' }
  );
  return {
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    token,
  };
}

export async function authRoutes(app: FastifyInstance) {
  // ── Login ─────────────────────────────────────────────────────
  app.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const { allowed, retryAfter } = checkRateLimit(ip);
    if (!allowed) {
      return reply.status(429).send({ error: 'Too many login attempts', retryAfter });
    }

    const body = loginSchema.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    if (!user) return reply.status(401).send({ error: 'Invalid credentials' });

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials' });

    loginAttempts.delete(ip);
    return authResponse(user, app);
  });

  // ── Get profile ───────────────────────────────────────────────
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    const auth = req.user as { id: number };
    const [user] = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, auth.id))
      .limit(1);
    if (!user) throw { statusCode: 404, message: 'User not found' };
    return user;
  });

  // ── Create user (admin only) ──────────────────────────────────
  app.post('/api/auth/users', { preHandler: requireAuth }, async (req, reply) => {
    const auth = req.user as { role: string };
    if (auth.role !== 'admin') {
      return reply.status(403).send({ error: 'Only admins can create users' });
    }

    const body = createUserSchema.parse(req.body);
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) return reply.status(409).send({ error: 'Email already registered' });

    const passwordHash = await hashPassword(body.password);
    const [user] = await db
      .insert(users)
      .values({ email: body.email, passwordHash, name: body.name, role: 'viewer' })
      .returning({ id: users.id, name: users.name, email: users.email, role: users.role });

    return reply.status(201).send(user);
  });

  // ── Change password ──────────────────────────────────────────
  app.put('/api/auth/password', { preHandler: requireAuth }, async (req) => {
    const auth = req.user as { id: number };
    const body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }).parse(req.body);

    const [user] = await db.select().from(users).where(eq(users.id, auth.id)).limit(1);
    if (!user) throw { statusCode: 404, message: 'User not found' };

    const valid = await verifyPassword(body.currentPassword, user.passwordHash);
    if (!valid) throw { statusCode: 401, message: 'Current password is incorrect' };

    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, auth.id));
    return { message: 'Password updated' };
  });
}
