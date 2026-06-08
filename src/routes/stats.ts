import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, pool } from '../db/connection.js';
import { gameEvents } from '../db/schema.js';
import { requireAuth, requireAdmin } from '../auth/middleware.js';

const eventSchema = z.object({
  game: z.string().min(1).max(50),
  event: z.string().min(1).max(50),
  level: z.number().int().positive().optional(),
  duration_ms: z.number().int().positive().optional(),
  device: z.string().max(20).optional(),
});

export async function statsRoutes(app: FastifyInstance) {
  // ── POST /api/stats — log a game event (open, no auth required) ─
  app.post('/api/stats', async (req, reply) => {
    const body = eventSchema.parse(req.body);

    await db.insert(gameEvents).values({
      game: body.game,
      event: body.event,
      level: body.level ?? null,
      durationMs: body.duration_ms ?? null,
      device: body.device ?? null,
      userId: null,
    });

    return reply.status(201).send({ ok: true });
  });

  // ── GET /api/stats/overview — dashboard data (admin only) ────
  app.get('/api/stats/overview', { preHandler: requireAdmin }, async () => {
    const totals = await pool.query<{
      game: string;
      total_events: string;
      completes: string;
      fails: string;
      max_level: string | null;
      avg_duration: string | null;
    }>(`
      SELECT game,
        COUNT(*)::text as total_events,
        SUM(CASE WHEN event = 'level_complete' THEN 1 ELSE 0 END)::text as completes,
        SUM(CASE WHEN event = 'level_fail' THEN 1 ELSE 0 END)::text as fails,
        MAX(level)::text as max_level,
        ROUND(AVG(duration_ms))::text as avg_duration
      FROM game_events
      GROUP BY game
    `);

    const daily = await pool.query<{ day: string; events: string }>(`
      SELECT date(created_at) as day, COUNT(*)::text as events
      FROM game_events
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `);

    const levelProgress = await pool.query<{ game: string; level: string; attempts: string }>(`
      SELECT game, level::text, COUNT(*)::text as attempts
      FROM game_events
      WHERE event = 'level_complete'
      GROUP BY game, level
      ORDER BY game, level
    `);

    const uniquePlayers = await pool.query<{ count: string }>(`
      SELECT COUNT(DISTINCT user_id)::text as count FROM game_events
    `);

    const deviceStats = await pool.query<{ device: string; count: string }>(`
      SELECT device, COUNT(*)::text as count
      FROM game_events
      WHERE device IS NOT NULL
      GROUP BY device
    `);

    return {
      totals: totals.rows,
      daily: daily.rows,
      levelProgress: levelProgress.rows,
      uniquePlayers: uniquePlayers.rows[0]?.count ?? '0',
      devices: deviceStats.rows,
    };
  });

  // ── GET /api/stats/mine — current user's stats ───────────────
  app.get('/api/stats/mine', { preHandler: requireAuth }, async (req) => {
    const auth = req.user as { id: number };

    const totals = await pool.query<{
      game: string;
      total_events: string;
      completes: string;
      max_level: string | null;
      avg_duration: string | null;
    }>(`
      SELECT game,
        COUNT(*)::text as total_events,
        SUM(CASE WHEN event = 'level_complete' THEN 1 ELSE 0 END)::text as completes,
        MAX(level)::text as max_level,
        ROUND(AVG(duration_ms))::text as avg_duration
      FROM game_events
      WHERE user_id = $1
      GROUP BY game
    `, [auth.id]);

    const bestLevels = await pool.query<{ game: string; max_level: string }>(`
      SELECT game, MAX(level)::text as max_level
      FROM game_events
      WHERE event = 'level_complete' AND user_id = $1
      GROUP BY game
    `, [auth.id]);

    return {
      totals: totals.rows,
      bestLevels: bestLevels.rows,
    };
  });
}
