import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

// Espera até 5 s por um lock antes de falhar com "database is locked": o serviço, a CLI
// (bootstrap/convite) e o `sqlite3 .backup` abrem o mesmo app.db.
export const BUSY_TIMEOUT_MS = 5000;

// Abre (e migra) o banco. ':memory:' para testes; arquivo usa journal WAL.
// Se a migração falhar, fecha a conexão e repassa o erro.
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  } catch (e) {
    try { db.close(); } catch { /* já fechado */ }
    throw e;
  }
  return db;
}
