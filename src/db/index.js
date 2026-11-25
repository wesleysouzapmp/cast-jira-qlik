import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrations.js';

// Abre (e migra) o banco. ':memory:' para testes; arquivo usa journal WAL.
export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}
