import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';
import { nowIso, uid } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS words (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  lookup_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'word',
  source_doc TEXT,
  source_sentence TEXT,
  note TEXT,
  tags TEXT,
  lookup_count INTEGER NOT NULL DEFAULT 0,
  last_lookup_at TEXT,
  first_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  spelling_dismissed INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_words_key_live
  ON words(lookup_key) WHERE deleted = 0;
CREATE INDEX IF NOT EXISTS idx_words_updated ON words(updated_at);

CREATE TABLE IF NOT EXISTS definitions (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_definitions_word_provider
  ON definitions(word_id, provider);

CREATE TABLE IF NOT EXISTS review_states (
  word_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'new',
  step INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  interval_days REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_review_at TEXT,
  updated_at TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_states_due ON review_states(due_at);

CREATE TABLE IF NOT EXISTS review_logs (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  prev_state TEXT,
  next_state TEXT,
  prev_interval_days REAL,
  next_interval_days REAL,
  duration_ms INTEGER,
  reviewed_at TEXT NOT NULL,
  day TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_day ON review_logs(day);
CREATE INDEX IF NOT EXISTS idx_logs_word ON review_logs(word_id);

CREATE TABLE IF NOT EXISTS search_misses (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

let db = null;

function ensureColumn(table, column, ddl) {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'english-learn.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  // Older databases predate the spelling feature; add the column in place.
  ensureColumn('words', 'spelling_dismissed', 'spelling_dismissed INTEGER NOT NULL DEFAULT 0');
  if (getMeta('sync_rev') === null) setMeta('sync_rev', '0');
  if (getMeta('audio_bytes') === null) setMeta('audio_bytes', '0');
  return db;
}

export function getDb() {
  if (!db) throw new Error('database not initialised');
  return db;
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function getMeta(key) {
  const row = get('SELECT value FROM meta WHERE key = ?', [key]);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  run(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

/** Bump the global sync revision; every mutation stamps the touched row with it. */
export function nextRev() {
  const rev = Number(getMeta('sync_rev') || 0) + 1;
  setMeta('sync_rev', rev);
  return rev;
}

export function currentRev() {
  return Number(getMeta('sync_rev') || 0);
}

export function tagsToJson(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags || '')
        .split(/[,，]/)
        .map((t) => t.trim());
  return JSON.stringify([...new Set(list.filter(Boolean))]);
}

export function tagsFromJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function findWordByKey(lookupKey, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT * FROM words WHERE lookup_key = ? ORDER BY deleted ASC, created_at DESC LIMIT 1'
    : 'SELECT * FROM words WHERE lookup_key = ? AND deleted = 0 LIMIT 1';
  return get(sql, [lookupKey]);
}

export function ensureReviewState(wordId) {
  const existing = get('SELECT * FROM review_states WHERE word_id = ?', [wordId]);
  if (existing) return existing;
  const rev = nextRev();
  const now = nowIso();
  run(
    `INSERT INTO review_states(word_id, state, step, due_at, interval_days, ease, reps, lapses, updated_at, rev)
     VALUES (?, 'new', 0, ?, 0, 2.5, 0, 0, ?, ?)`,
    [wordId, now, now, rev]
  );
  return get('SELECT * FROM review_states WHERE word_id = ?', [wordId]);
}

export function newId(prefix) {
  return uid(prefix);
}

export function serializeWord(row, definition, state) {
  return {
    id: row.id,
    text: row.text,
    lookupKey: row.lookup_key,
    kind: row.kind,
    sourceDoc: row.source_doc || '',
    sourceSentence: row.source_sentence || '',
    note: row.note || '',
    tags: tagsFromJson(row.tags),
    lookupCount: row.lookup_count,
    lastLookupAt: row.last_lookup_at,
    firstSeenAt: row.first_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rev: row.rev,
    deleted: !!row.deleted,
    spellingDismissed: !!row.spelling_dismissed,
    definition: definition || null,
    review: state
      ? {
          state: state.state,
          step: state.step,
          dueAt: state.due_at,
          intervalDays: state.interval_days,
          ease: state.ease,
          reps: state.reps,
          lapses: state.lapses,
          lastReviewAt: state.last_review_at
        }
      : null
  };
}
