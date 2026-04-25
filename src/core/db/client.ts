import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Config } from '../config.js';
import * as schema from './schema.js';

export function createDatabase(config: Config) {
  const sql = postgres(config.db.url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return drizzle(sql, { schema });
}

export type Database = ReturnType<typeof createDatabase>;
