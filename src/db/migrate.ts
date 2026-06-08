import { pool } from './connection.js';

async function migrate() {
  console.log('Running migrations...');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        name VARCHAR(100) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS game_events (
        id SERIAL PRIMARY KEY,
        game TEXT NOT NULL,
        event TEXT NOT NULL,
        level INTEGER,
        duration_ms INTEGER,
        device TEXT,
        visitor_id TEXT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW() NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_game_events_game ON game_events(game);
      CREATE INDEX IF NOT EXISTS idx_game_events_event ON game_events(event);
      CREATE INDEX IF NOT EXISTS idx_game_events_created ON game_events(created_at);

      DO $$ BEGIN
        ALTER TABLE game_events ADD COLUMN visitor_id TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;

      CREATE INDEX IF NOT EXISTS idx_game_events_visitor ON game_events(visitor_id);
    `);
    console.log('Migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
