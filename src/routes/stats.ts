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
  visitor_id: z.string().uuid().optional(),
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
      visitorId: body.visitor_id ?? null,
      userId: null,
    });

    return reply.status(201).send({ ok: true });
  });

  // ── GET /api/stats/overview — dashboard data (admin only) ────
  app.get('/api/stats/overview', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    reply.header('Pragma', 'no-cache');

    const { period } = req.query as { period?: string };

    let dateFilter = '';
    let params: string[] = [];
    if (period === 'today') {
      dateFilter = 'AND created_at >= CURRENT_DATE';
    } else if (period === 'yesterday') {
      dateFilter = 'AND created_at >= CURRENT_DATE - INTERVAL \'1 day\' AND created_at < CURRENT_DATE';
    }
    // period === 'all' or undefined → no filter

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
      WHERE 1=1 ${dateFilter}
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
      WHERE event = 'level_complete' ${dateFilter}
      GROUP BY game, level
      ORDER BY game, level
    `);

    const uniqueVisitors = await pool.query<{ count: string }>(`
      SELECT COUNT(DISTINCT visitor_id)::text as count
      FROM game_events
      WHERE visitor_id IS NOT NULL ${dateFilter}
    `);

    const deviceStats = await pool.query<{ device: string; count: string }>(`
      SELECT device, COUNT(*)::text as count
      FROM game_events
      WHERE device IS NOT NULL ${dateFilter}
      GROUP BY device
    `);

    const visitors = await pool.query<{
      visitor_id: string;
      first_seen: string;
      last_seen: string;
      total_events: string;
      games_played: string;
      max_level: string | null;
    }>(`
      SELECT visitor_id,
        MIN(created_at)::text as first_seen,
        MAX(created_at)::text as last_seen,
        COUNT(*)::text as total_events,
        COUNT(DISTINCT game)::text as games_played,
        MAX(level)::text as max_level
      FROM game_events
      WHERE visitor_id IS NOT NULL ${dateFilter}
      GROUP BY visitor_id
      ORDER BY last_seen DESC
      LIMIT 50
    `);

    return {
      totals: totals.rows,
      daily: daily.rows,
      levelProgress: levelProgress.rows,
      uniqueVisitors: uniqueVisitors.rows[0]?.count ?? '0',
      devices: deviceStats.rows,
      visitors: visitors.rows,
    };
  });

  // ── GET /api/stats/visitor/:id — individual visitor (admin only)
  app.get('/api/stats/visitor/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };

    const events = await pool.query<{
      id: string;
      game: string;
      event: string;
      level: string | null;
      duration_ms: string | null;
      device: string | null;
      created_at: string;
    }>(`
      SELECT id, game, event, level::text, duration_ms::text, device, created_at::text
      FROM game_events
      WHERE visitor_id = $1
      ORDER BY created_at ASC
    `, [id]);

    const summary = await pool.query<{
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
      WHERE visitor_id = $1
      GROUP BY game
    `, [id]);

    const firstSeen = await pool.query<{ ts: string }>(`
      SELECT MIN(created_at)::text as ts FROM game_events WHERE visitor_id = $1
    `, [id]);

    return {
      visitorId: id,
      firstSeen: firstSeen.rows[0]?.ts ?? null,
      summary: summary.rows,
      events: events.rows,
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
