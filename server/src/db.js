import { DatabaseSync } from 'node:sqlite';

export const PRIORITY_RANK = { low: 1, medium: 2, high: 3, urgent: 4 };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- A user can be in many teams with a different role in each.
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  role    TEXT NOT NULL CHECK (role IN ('viewer','member','lead')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id                INTEGER PRIMARY KEY,
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','blocked','resolved','closed')),
  priority          TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('low','medium','high','urgent')),
  priority_rank     INTEGER NOT NULL DEFAULT 2,
  assignee_id       INTEGER REFERENCES users(id),
  creator_id        INTEGER NOT NULL REFERENCES users(id),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval_state    TEXT NOT NULL DEFAULT 'none'
                    CHECK (approval_state IN ('none','pending','approved','rejected')),
  due_at            INTEGER,
  version           INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency token
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_activity_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_team_activity    ON items(team_id, last_activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_assignee_status  ON items(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_items_team_status      ON items(team_id, status, priority_rank DESC);
CREATE INDEX IF NOT EXISTS idx_items_approval         ON items(approval_state, team_id) WHERE approval_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_items_due              ON items(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_team_rank        ON items(team_id, priority_rank DESC, last_activity_at DESC, id DESC);

-- Full text search over title + description (external-content FTS5, kept in sync by triggers).
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, description, content='items', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, description ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, description) VALUES ('delete', old.id, old.title, old.description);
  INSERT INTO items_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

-- Append-only history. Every meaningful change writes a row in the same transaction as the change.
CREATE TABLE IF NOT EXISTS item_events (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id),
  actor_id   INTEGER REFERENCES users(id),
  type       TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_item ON item_events(item_id, id DESC);
CREATE TRIGGER IF NOT EXISTS item_events_no_update BEFORE UPDATE ON item_events
  BEGIN SELECT RAISE(ABORT, 'item_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS item_events_no_delete BEFORE DELETE ON item_events
  BEGIN SELECT RAISE(ABORT, 'item_events is append-only'); END;

-- Replay protection for client retries.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id     INTEGER NOT NULL,
  key         TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status      INTEGER NOT NULL,
  response    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- Transactional outbox: written in the same transaction as the business change.
CREATE TABLE IF NOT EXISTS outbox (
  id              INTEGER PRIMARY KEY,
  topic           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  dedupe_key      TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  locked_until    INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  item_id    INTEGER REFERENCES items(id),
  message    TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,   -- makes the worker safe to run twice
  read_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/**
 * Runs fn inside BEGIN IMMEDIATE so the write lock is taken up front.
 * Two connections (e.g. two server processes) can never interleave inside it.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}
