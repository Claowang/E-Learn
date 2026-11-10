import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../config.js';

let handle = null;
let handleKey = '';
let columns = [];
let tableName = 'stardict';

function resolvePath(configured) {
  if (!configured) return null;
  return path.isAbsolute(configured) ? configured : path.join(DATA_DIR, configured);
}

export function offlineDbPath(settings) {
  return resolvePath(settings.dbPath || 'ecdict.db');
}

function open(settings) {
  const file = offlineDbPath(settings);
  if (!file || !fs.existsSync(file)) return null;
  if (handle && handleKey === file) return handle;
  if (handle) {
    try {
      handle.close();
    } catch {
      /* ignore */
    }
  }
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((row) => row.name);
  tableName = tables.includes('stardict') ? 'stardict' : tables[0];
  if (!tableName) return null;
  columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => row.name);
  handle = db;
  handleKey = file;
  return handle;
}

function pick(row, ...names) {
  for (const name of names) {
    if (columns.includes(name) && row[name] != null && row[name] !== '') return String(row[name]);
  }
  return '';
}

function parseSenses(translation, pos) {
  const senses = [];
  for (const rawLine of String(translation || '').split(/\n+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-z]{1,5}\.\s*)?(.*)$/i);
    const tag = (match?.[1] || pos || '').trim().replace(/\.$/, '');
    senses.push({ pos: tag, meaning: (match?.[2] || line).trim(), note: '' });
  }
  return senses.slice(0, 12);
}

export function lookupWithOffline(text, settings) {
  let db;
  try {
    db = open(settings);
  } catch (err) {
    return { ok: false, provider: 'offline', error: `打开离线词库失败：${err.message}` };
  }
  if (!db) {
    return {
      ok: false,
      provider: 'offline',
      error: `未找到离线词库文件 ${offlineDbPath(settings) || 'data/ecdict.db'}`
    };
  }

  // ECDICT keeps a lowercase "search word" column; falling back to `word` covers the
  // stardict.db / CSV dumps that only ship a single spelling column.
  const searchCols = ['sw', 'word', 'lemma'].filter((c) => columns.includes(c));
  if (!searchCols.length) {
    return { ok: false, provider: 'offline', error: '离线词库缺少 word 列，可能不是 ECDICT 数据库' };
  }

  const lower = text.toLowerCase();
  const candidates = [
    text,
    lower,
    lower.charAt(0).toUpperCase() + lower.slice(1),
    lower.toUpperCase()
  ];
  let row = null;
  outer: for (const column of searchCols) {
    if (searchCols[0] === 'sw' && column === 'sw') {
      // the search column is already normalised: one lowercase probe is enough
      row = db.prepare(`SELECT * FROM ${tableName} WHERE sw = ? LIMIT 1`).get(lower);
      if (row) break;
      continue;
    }
    for (const candidate of candidates) {
      row = db.prepare(`SELECT * FROM ${tableName} WHERE ${column} = ? LIMIT 1`).get(candidate);
      if (row) break outer;
    }
  }
  if (!row) {
    // Last resort: case-insensitive scan. Slower, but it still finds proper nouns.
    for (const column of searchCols) {
      row = db
        .prepare(`SELECT * FROM ${tableName} WHERE ${column} = ? COLLATE NOCASE LIMIT 1`)
        .get(lower);
      if (row) break;
    }
  }
  if (!row && text.includes(' ')) {
    const head = text.split(/\s+/)[0];
    for (const column of searchCols) {
      row = db
        .prepare(`SELECT * FROM ${tableName} WHERE ${column} = ? LIMIT 1`)
        .get(head.toLowerCase());
      if (row) break;
    }
  }
  if (!row) {
    return { ok: false, provider: 'offline', error: `离线词库中没有 "${text}"` };
  }

  const translation = pick(row, 'translation');
  const definition = pick(row, 'definition');
  const phonetic = pick(row, 'phonetic');
  const pos = pick(row, 'pos');
  const exchange = pick(row, 'exchange');

  const card = {
    provider: 'offline',
    model: 'ECDICT',
    translation: translation.split('\n')[0] || '',
    pos: pos ? pos.split(/[,/]/).map((p) => p.trim()).filter(Boolean) : [],
    phonetics: { us: phonetic ? `/${phonetic}/` : '', uk: phonetic ? `/${phonetic}/` : '' },
    senses: parseSenses(translation || definition, pos),
    domainNote: '',
    abbreviations: [],
    collocations: [],
    examples: [],
    synonymNotes: [],
    writingExamples: [],
    memoryHook: exchange ? `词形变化：${exchange}` : '',
    spelling: { isCorrect: true, suggestion: '', note: '' },
    raw: definition ? { englishDefinition: definition.slice(0, 1200) } : undefined
  };
  return { ok: true, payload: card };
}

/** Optimal string alignment distance (Levenshtein + adjacent transposition). */
function editDistance(a, b) {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > 4) return 99;
  const dp = Array.from({ length: al + 1 }, (_, i) => {
    const row = new Array(bl + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= bl; j += 1) dp[0][j] = j;
  for (let i = 1; i <= al; i += 1) {
    for (let j = 1; j <= bl; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[al][bl];
}

function scanCandidates(db, searchCol, clean, prefixLength) {
  const len = clean.length;
  const pattern = `${clean.slice(0, prefixLength)}%`;
  const rows = db
    .prepare(
      `SELECT ${searchCol} AS w, COALESCE(frq, 0) AS frq, COALESCE(bnc, 0) AS bnc
       FROM ${tableName}
       WHERE length(${searchCol}) BETWEEN ? AND ? AND ${searchCol} LIKE ?
       LIMIT 2000`
    )
    .all(Math.max(2, len - 2), len + 2, pattern);

  const threshold = len <= 6 ? 1 : len <= 9 ? 2 : 3;
  let best = null;
  for (const row of rows) {
    const candidate = String(row.w || '').toLowerCase();
    if (!candidate || candidate === clean) continue;
    const distance = editDistance(clean, candidate);
    if (distance === 0 || distance > threshold) continue;
    const frequency = Number(row.frq) + Number(row.bnc);
    if (
      !best ||
      distance < best.distance ||
      (distance === best.distance && frequency > best.frequency)
    ) {
      best = {
        suggestion: candidate,
        distance,
        frequency,
        threshold
      };
    }
  }
  return best;
}

/**
 * Offline fuzzy spelling check powered by the ECDICT database.
 * Returns null when the dictionary is not installed.
 */
export function suggestFromOffline(text, settings) {
  let db;
  try {
    db = open(settings);
  } catch {
    return null;
  }
  if (!db) return null;

  const clean = String(text || '').trim().toLowerCase();
  if (!/^[a-z][a-z'’-]{1,29}$/.test(clean)) return null;

  const searchCol = columns.includes('sw') ? 'sw' : columns.includes('word') ? 'word' : null;
  if (!searchCol) return null;

  const exact = db
    .prepare(`SELECT 1 AS ok FROM ${tableName} WHERE ${searchCol} = ? LIMIT 1`)
    .get(clean);
  if (exact) {
    return { checked: true, isCorrect: true, suggestion: '', source: 'offline', reason: '' };
  }

  let best = scanCandidates(db, searchCol, clean, 2);
  if (!best) best = scanCandidates(db, searchCol, clean, 1);
  if (!best) {
    return {
      checked: true,
      isCorrect: true,
      suggestion: '',
      source: 'offline',
      reason: '离线词库里没有这个词，也没有找到足够接近的拼写'
    };
  }

  return {
    checked: true,
    isCorrect: false,
    suggestion: best.suggestion,
    source: 'offline',
    reason: `离线词库里没有 "${clean}"，最接近的是 "${best.suggestion}"`
  };
}

export function offlineStatus(settings) {
  const file = offlineDbPath(settings);
  if (!file) return { installed: false, path: '' };
  if (!fs.existsSync(file)) return { installed: false, path: file };
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
      .all()
      .map((r) => r.name);
    const table = tables.includes('stardict') ? 'stardict' : tables[0];
    const count = table ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : 0;
    db.close();
    return { installed: true, path: file, entries: Number(count), sizeBytes: fs.statSync(file).size };
  } catch (err) {
    return { installed: false, path: file, error: err.message };
  }
}
