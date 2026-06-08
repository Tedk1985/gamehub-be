import { pgTable, serial, varchar, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  role: varchar('role', { length: 20 }).notNull().default('viewer'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_users_email').on(t.email),
]);

export const gameEvents = pgTable('game_events', {
  id: serial('id').primaryKey(),
  game: text('game').notNull(),
  event: text('event').notNull(),
  level: integer('level'),
  durationMs: integer('duration_ms'),
  device: text('device'),
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_game_events_game').on(t.game),
  index('idx_game_events_event').on(t.event),
  index('idx_game_events_created').on(t.createdAt),
]);
