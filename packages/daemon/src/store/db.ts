import Database, { type Database as Db } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  branch_name     TEXT NOT NULL,
  worktree_path   TEXT,
  base_main_sha   TEXT NOT NULL,
  last_head_sha   TEXT,
  owner_user_id   TEXT NOT NULL,
  owner_epoch     INTEGER NOT NULL DEFAULT 1,
  policy_json     TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  session_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  role              TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS events (
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  actor_user_id   TEXT NOT NULL,
  kind            TEXT NOT NULL,
  detail_json     TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS chat (
  session_id      TEXT NOT NULL,
  chat_id         TEXT NOT NULL DEFAULT 'default',
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  text            TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS agent_status (
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  chat_id         TEXT,
  kind            TEXT NOT NULL,
  message         TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  ensureColumn(db, "chat", "chat_id", "TEXT NOT NULL DEFAULT 'default'");
  return db;
}

function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
