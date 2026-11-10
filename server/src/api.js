import fs from 'node:fs';
import { loadConfig, writeConfig } from './config.js';
import {
  all,
  currentRev,
  ensureReviewState,
  findWordByKey,
  get,
  newId,
  nextRev,
  run,
  serializeWord,
  tagsFromJson,
  tagsToJson
} from './db.js';
import { lookup as runLookup, tts as runTts, PROVIDER_NAMES } from './providers/index.js';
import { offlineStatus } from './providers/offline.js';
import { checkSpelling } from './providers/spell.js';
import { audioCacheStats, clearAudioCache } from './providers/tts.js';
import { previewIntervals, schedule } from './srs.js';
import {
  addDays,
  classifyKind,
  hashPassword,
  lookupKey,
  maskSecret,
  normalizeText,
  nowIso,
  safeJsonParse,
  signToken,
  todayKey,
  verifyPassword,
  verifyToken
} from './util.js';

const PROVIDER_PREFERENCE = ['llm', 'dict:youdao', 'dict:baidu', 'dict:freedict', 'offline'];

let config = null;

export function initApi(appConfig) {
  config = appConfig;
  return config;
}

export function reloadConfig() {
  config = loadConfig();
  return config;
}

// --- helpers ----------------------------------------------------------------

function publicConfig() {
  const c = config;
  return {
    publicUrl: c.publicUrl,
    lookup: c.lookup,
    srs: c.srs,
    tts: { ...c.tts },
    providers: {
      llm: {
        enabled: c.providers.llm.enabled,
        baseUrl: c.providers.llm.baseUrl,
        model: c.providers.llm.model,
        hasKey: Boolean(c.providers.llm.apiKey),
        apiKeyMasked: maskSecret(c.providers.llm.apiKey)
      },
      dict: {
        enabled: c.providers.dict.enabled,
        engine: c.providers.dict.engine,
        youdao: {
          hasKeys: Boolean(c.providers.dict.youdao.appKey && c.providers.dict.youdao.appSecret),
          appKeyMasked: maskSecret(c.providers.dict.youdao.appKey)
        },
        baidu: {
          hasKeys: Boolean(c.providers.dict.baidu.appId && c.providers.dict.baidu.secretKey),
          appIdMasked: maskSecret(c.providers.dict.baidu.appId)
        },
        freedict: { baseUrl: c.providers.dict.freedict.baseUrl }
      },
      offline: {
        enabled: c.providers.offline.enabled,
        dbPath: c.providers.offline.dbPath,
        status: offlineStatus(c.providers.offline)
      }
    },
    audio: audioCacheStats()
  };
}

function applyConfigPatch(patch) {
  const next = structuredClone(config);
  const assign = (target, source) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (value === undefined) continue;
      if (value === null) continue;
      if (typeof value === 'object' && !Array.isArray(value) && typeof target[key] === 'object') {
        assign(target[key], value);
      } else {
        target[key] = value;
      }
    }
  };
  if (patch.lookup) assign(next.lookup, patch.lookup);
  if (patch.srs) assign(next.srs, patch.srs);
  if (patch.tts) assign(next.tts, patch.tts);
  if (patch.publicUrl !== undefined) next.publicUrl = patch.publicUrl;
  if (patch.providers) {
    const p = patch.providers;
    if (p.llm) assign(next.providers.llm, p.llm);
    if (p.dict) {
      const { engine, enabled, youdao, baidu, freedict } = p.dict;
      if (engine) next.providers.dict.engine = engine;
      if (enabled !== undefined) next.providers.dict.enabled = enabled;
      if (youdao) assign(next.providers.dict.youdao, youdao);
      if (baidu) assign(next.providers.dict.baidu, baidu);
      if (freedict) assign(next.providers.dict.freedict, freedict);
    }
    if (p.offline) assign(next.providers.offline, p.offline);
  }
  config = next;
  writeConfig(config);
  return config;
}

function definitionsFor(wordIds) {
  if (!wordIds.length) return new Map();
  const placeholders = wordIds.map(() => '?').join(',');
  const rows = all(
    `SELECT * FROM definitions WHERE word_id IN (${placeholders})`,
    wordIds
  );
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.word_id)) map.set(row.word_id, {});
    const card = safeJsonParse(row.payload);
    if (card) map.get(row.word_id)[row.provider] = { ...card, cachedAt: row.updated_at };
  }
  return map;
}

function statesFor(wordIds) {
  if (!wordIds.length) return new Map();
  const placeholders = wordIds.map(() => '?').join(',');
  const rows = all(`SELECT * FROM review_states WHERE word_id IN (${placeholders})`, wordIds);
  return new Map(rows.map((row) => [row.word_id, row]));
}

function preferredDefinition(defs) {
  if (!defs) return null;
  for (const name of PROVIDER_PREFERENCE) {
    if (defs[name]) return defs[name];
  }
  const first = Object.values(defs)[0];
  return first || null;
}

function hydrate(rows) {
  const ids = rows.map((row) => row.id);
  const defsMap = definitionsFor(ids);
  const statesMap = statesFor(ids);
  return rows.map((row) => {
    const defs = defsMap.get(row.id) || {};
    const base = serializeWord(row, null, statesMap.get(row.id));
    return { ...base, definitions: defs, definition: preferredDefinition(defs) };
  });
}

function storeDefinition(wordId, card) {
  const now = nowIso();
  const existing = get('SELECT id FROM definitions WHERE word_id = ? AND provider = ?', [
    wordId,
    card.provider
  ]);
  if (existing) {
    run(
      'UPDATE definitions SET payload = ?, model = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(card), card.model || '', now, existing.id]
    );
  } else {
    run(
      `INSERT INTO definitions(id, word_id, provider, model, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId('def_'), wordId, card.provider, card.model || '', JSON.stringify(card), now, now]
    );
  }
}

function bumpLookup(wordId) {
  const rev = nextRev();
  run(
    `UPDATE words SET lookup_count = lookup_count + 1, last_lookup_at = ?, updated_at = ?, rev = ?
     WHERE id = ?`,
    [nowIso(), nowIso(), rev, wordId]
  );
}

async function lookupAndCache(text, { wordId, provider, kind, sourceDoc, sourceSentence, force }) {
  const clean = normalizeText(text);
  if (!clean) return { ok: false, error: '内容为空' };
  const resolvedKind = kind || classifyKind(clean);

  if (wordId && !force) {
    const existing = definitionsFor([wordId]).get(wordId) || {};
    const wanted = provider && provider !== 'auto' && provider !== 'all' ? provider : null;
    if (wanted && existing[wanted]) {
      return { ok: true, card: existing[wanted], provider: wanted, cached: true };
    }
    if (!wanted && Object.keys(existing).length) {
      const card = preferredDefinition(existing);
      if (card) return { ok: true, card, provider: card.provider, cached: true };
    }
  }

  const result = await runLookup(clean, {
    provider,
    kind: resolvedKind,
    sourceDoc,
    sourceSentence,
    config
  });
  if (result.ok && wordId) {
    storeDefinition(wordId, result.card);
  }
  return result;
}

function logMiss(text) {
  run('INSERT INTO search_misses(id, text, created_at) VALUES (?, ?, ?)', [
    newId('miss_'),
    text,
    nowIso()
  ]);
}

function authRequired(pathname) {
  if (pathname === '/api/health') return false;
  if (pathname === '/api/auth/login') return false;
  return pathname.startsWith('/api/');
}

// --- route handlers ---------------------------------------------------------

function handleLogin(body) {
  const { password } = body || {};
  if (!password) return { status: 400, body: { error: '请输入密码' } };
  const ok = verifyPassword(String(password), config.auth.salt, config.auth.passwordHash);
  if (!ok) return { status: 401, body: { error: '密码不正确' } };
  const token = signToken({ sub: 'owner' }, config.auth.secret, config.auth.tokenDays || 90);
  return { body: { token, expiresInDays: config.auth.tokenDays || 90 } };
}

function listWords(query) {
  const clauses = ['deleted = 0'];
  const params = [];
  const search = normalizeText(query.get('search') || '');
  if (search) {
    clauses.push('(text LIKE ? OR note LIKE ? OR source_doc LIKE ? OR source_sentence LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const tag = query.get('tag');
  if (tag) {
    clauses.push('tags LIKE ?');
    params.push(`%"${tag}"%`);
  }
  const kind = query.get('kind');
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  const limit = Math.min(Number(query.get('limit') || 200), 500);
  const offset = Math.max(Number(query.get('offset') || 0), 0);
  const sort = query.get('sort') || 'created';
  const orderBy =
    sort === 'alpha'
      ? 'text COLLATE NOCASE ASC'
      : sort === 'lookups'
        ? 'lookup_count DESC, created_at DESC'
        : 'created_at DESC';

  const rows = all(
    `SELECT * FROM words WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS n FROM words WHERE ${clauses.join(' AND ')}`, params).n;
  return { body: { total: Number(total), items: hydrate(rows) } };
}

async function createWord(body) {
  const text = normalizeText(body?.text);
  if (!text) return { status: 400, body: { error: '内容为空' } };
  const key = lookupKey(text);
  const kind = body.kind || classifyKind(text);
  const now = nowIso();
  let row = findWordByKey(key);

  if (row) {
    const rev = nextRev();
    run(
      `UPDATE words SET updated_at = ?, rev = ?,
        source_doc = COALESCE(NULLIF(?, ''), source_doc),
        source_sentence = COALESCE(NULLIF(?, ''), source_sentence),
        note = COALESCE(NULLIF(?, ''), note),
        tags = ?
       WHERE id = ?`,
      [
        now,
        rev,
        body.sourceDoc || '',
        body.sourceSentence || '',
        body.note || '',
        tagsToJson(
          body.tags && body.tags.length
            ? [...new Set([...tagsFromJson(row.tags), ...(Array.isArray(body.tags) ? body.tags : [])])]
            : tagsFromJson(row.tags)
        ),
        row.id
      ]
    );
    row = get('SELECT * FROM words WHERE id = ?', [row.id]);
  } else {
    const rev = nextRev();
    const id = newId('w_');
    const createdAt = body.createdAt || now;
    run(
      `INSERT INTO words(id, text, lookup_key, kind, source_doc, source_sentence, note, tags,
                         lookup_count, first_seen_at, created_at, updated_at, deleted, rev)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)`,
      [
        id,
        text,
        key,
        kind,
        body.sourceDoc || '',
        body.sourceSentence || '',
        body.note || '',
        tagsToJson(body.tags || []),
        createdAt,
        createdAt,
        now,
        rev
      ]
    );
    ensureReviewState(id);
    row = get('SELECT * FROM words WHERE id = ?', [id]);
  }

  const shouldLookup = body.lookup !== false;
  let lookupResult = null;
  if (shouldLookup) {
    bumpLookup(row.id);
    lookupResult = await lookupAndCache(text, {
      wordId: row.id,
      provider: body.provider || config.lookup.defaultProvider,
      kind,
      sourceDoc: body.sourceDoc,
      sourceSentence: body.sourceSentence,
      force: Boolean(body.force)
    });
    row = get('SELECT * FROM words WHERE id = ?', [row.id]);
    if (!lookupResult.ok) logMiss(text);
  }

  const [item] = hydrate([row]);
  return {
    status: lookupResult && !lookupResult.ok ? 207 : 200,
    body: { item, lookup: lookupResult }
  };
}

/** Copy a word's metadata fields onto another word (used after a spelling merge). */
function applyWordFields(id, body) {
  const row = get('SELECT * FROM words WHERE id = ?', [id]);
  if (!row) return;
  const rev = nextRev();
  run(
    `UPDATE words SET note = ?, source_doc = ?, source_sentence = ?, tags = ?,
       spelling_dismissed = ?, updated_at = ?, rev = ?
     WHERE id = ?`,
    [
      body.note !== undefined ? body.note : row.note,
      body.sourceDoc !== undefined ? body.sourceDoc : row.source_doc,
      body.sourceSentence !== undefined ? body.sourceSentence : row.source_sentence,
      body.tags !== undefined ? tagsToJson(body.tags) : row.tags,
      body.spellingDismissed !== undefined
        ? body.spellingDismissed
          ? 1
          : 0
        : row.spelling_dismissed,
      nowIso(),
      rev,
      id
    ]
  );
}

/**
 * Fold a (usually misspelled) entry into an existing entry with the corrected spelling,
 * so fixing a typo doesn't lose review progress or definitions.
 */
function mergeWords(srcId, dstId) {
  const srcDefs = all('SELECT * FROM definitions WHERE word_id = ?', [srcId]);
  for (const def of srcDefs) {
    const exists = get('SELECT id FROM definitions WHERE word_id = ? AND provider = ?', [
      dstId,
      def.provider
    ]);
    if (!exists) {
      run('UPDATE definitions SET word_id = ? WHERE id = ?', [dstId, def.id]);
    }
  }

  const srcState = get('SELECT * FROM review_states WHERE word_id = ?', [srcId]);
  const dstState = get('SELECT * FROM review_states WHERE word_id = ?', [dstId]);
  if (srcState && !dstState) {
    run('UPDATE review_states SET word_id = ? WHERE word_id = ?', [dstId, srcId]);
  } else if (srcState && dstState) {
    if ((srcState.reps || 0) > (dstState.reps || 0)) {
      const rev = nextRev();
      run(
        `UPDATE review_states SET state = ?, step = ?, due_at = ?, interval_days = ?, ease = ?,
           reps = ?, lapses = ?, last_review_at = ?, updated_at = ?, rev = ?
         WHERE word_id = ?`,
        [
          srcState.state,
          srcState.step,
          srcState.due_at,
          srcState.interval_days,
          srcState.ease,
          srcState.reps,
          srcState.lapses,
          srcState.last_review_at,
          nowIso(),
          rev,
          dstId
        ]
      );
    }
    run('DELETE FROM review_states WHERE word_id = ?', [srcId]);
  }

  run('UPDATE review_logs SET word_id = ? WHERE word_id = ?', [dstId, srcId]);
  const rev = nextRev();
  run('UPDATE words SET deleted = 1, updated_at = ?, rev = ? WHERE id = ?', [nowIso(), rev, srcId]);
}

function updateWord(id, body) {
  let row = get('SELECT * FROM words WHERE id = ? AND deleted = 0', [id]);
  if (!row) return { status: 404, body: { error: '没有这个词条' } };

  if (body.text !== undefined) {
    const next = normalizeText(body.text);
    if (!next) return { status: 400, body: { error: '拼写不能为空' } };
    if (next !== row.text) {
      const nextKey = lookupKey(next);
      const conflict = findWordByKey(nextKey);
      if (conflict && conflict.id !== id) {
        // The corrected spelling already exists: merge this entry into it.
        mergeWords(id, conflict.id);
        applyWordFields(conflict.id, body);
        const [item] = hydrate([get('SELECT * FROM words WHERE id = ?', [conflict.id])]);
        return { body: { item, merged: true } };
      }
      const rev = nextRev();
      run(
        `UPDATE words SET text = ?, lookup_key = ?, kind = ?, spelling_dismissed = 0,
           updated_at = ?, rev = ?
         WHERE id = ?`,
        [next, nextKey, body.kind || classifyKind(next), nowIso(), rev, id]
      );
      row = get('SELECT * FROM words WHERE id = ?', [id]);
    }
  }

  applyWordFields(id, body);
  const [item] = hydrate([get('SELECT * FROM words WHERE id = ?', [id])]);
  return { body: { item, merged: false } };
}

function deleteWord(id) {
  const row = get('SELECT * FROM words WHERE id = ?', [id]);
  if (!row) return { status: 404, body: { error: '没有这个词条' } };
  const rev = nextRev();
  run('UPDATE words SET deleted = 1, updated_at = ?, rev = ? WHERE id = ?', [nowIso(), rev, id]);
  // Drop the review schedule so re-adding the same word later starts clean.
  run('DELETE FROM review_states WHERE word_id = ?', [id]);
  return { body: { ok: true, id, rev } };
}

function wordDetail(id) {
  const row = get('SELECT * FROM words WHERE id = ?', [id]);
  if (!row) return { status: 404, body: { error: '没有这个词条' } };
  const [item] = hydrate([row]);
  const logs = all(
    'SELECT * FROM review_logs WHERE word_id = ? ORDER BY reviewed_at DESC LIMIT 50',
    [id]
  );
  const preview = item.review
    ? previewIntervals(
        {
          state: item.review.state,
          step: item.review.step,
          interval_days: item.review.intervalDays,
          ease: item.review.ease,
          reps: item.review.reps,
          lapses: item.review.lapses
        },
        config.srs
      )
    : {};
  return { body: { item, logs, preview } };
}

function reviewQueue(query) {
  const now = new Date();
  const limit = Math.min(Number(query.get('limit') || 30), 200);
  const includeNew = query.get('new') !== '0';
  const day = todayKey(now);
  const reviewsToday = Number(
    get('SELECT COUNT(*) AS n FROM review_logs WHERE day = ?', [day]).n || 0
  );
  const newDoneToday = Number(
    get("SELECT COUNT(*) AS n FROM review_logs WHERE day = ? AND prev_state = 'new'", [day]).n || 0
  );
  const newAllowance = Math.max(0, (config.srs.newPerDay || 20) - newDoneToday);
  const reviewAllowance = Math.max(0, (config.srs.reviewsPerDay || 200) - reviewsToday);

  const dueRows = all(
    `SELECT w.*, s.due_at, s.state AS sstate FROM words w
     JOIN review_states s ON s.word_id = w.id
     WHERE w.deleted = 0 AND s.state IN ('learning','review','relearning') AND s.due_at <= ?
     ORDER BY s.due_at ASC LIMIT ?`,
    [nowIso(), Math.min(limit, reviewAllowance)]
  );

  const newRows = includeNew
    ? all(
        `SELECT w.*, s.due_at, s.state AS sstate FROM words w
         JOIN review_states s ON s.word_id = w.id
         WHERE w.deleted = 0 AND s.state = 'new'
         ORDER BY w.created_at ASC LIMIT ?`,
        [Math.min(limit, newAllowance)]
      )
    : [];

  const totalDue = Number(
    get(
      `SELECT COUNT(*) AS n FROM words w JOIN review_states s ON s.word_id = w.id
       WHERE w.deleted = 0 AND s.state IN ('learning','review','relearning') AND s.due_at <= ?`,
      [nowIso()]
    ).n || 0
  );
  const totalNew = Number(
    get(
      `SELECT COUNT(*) AS n FROM words w JOIN review_states s ON s.word_id = w.id
       WHERE w.deleted = 0 AND s.state = 'new'`
    ).n || 0
  );

  const items = hydrate([...dueRows, ...newRows].slice(0, limit)).map((item) => ({
    ...item,
    preview: item.review
      ? previewIntervals(
          {
            state: item.review.state,
            step: item.review.step,
            interval_days: item.review.intervalDays,
            ease: item.review.ease,
            reps: item.review.reps,
            lapses: item.review.lapses
          },
          config.srs
        )
      : {}
  }));
  return {
    body: {
      items,
      stats: {
        dueTotal: totalDue,
        newTotal: totalNew,
        newAllowance,
        reviewAllowance,
        reviewsToday,
        newDoneToday
      }
    }
  };
}

function submitReview(body) {
  const { wordId, rating, durationMs } = body || {};
  if (!wordId || !rating) return { status: 400, body: { error: '缺少 wordId 或 rating' } };
  const row = get('SELECT * FROM words WHERE id = ?', [wordId]);
  if (!row) return { status: 404, body: { error: '没有这个词条' } };
  const state = ensureReviewState(wordId);
  const next = schedule(state, Number(rating), config.srs);
  const rev = nextRev();
  const now = nowIso();

  run(
    `UPDATE review_states SET state = ?, step = ?, due_at = ?, interval_days = ?, ease = ?,
       reps = ?, lapses = ?, last_review_at = ?, updated_at = ?, rev = ?
     WHERE word_id = ?`,
    [
      next.state,
      next.step,
      next.due_at,
      next.interval_days,
      next.ease,
      next.reps,
      next.lapses,
      next.last_review_at,
      next.updated_at,
      rev,
      wordId
    ]
  );
  run(
    `INSERT INTO review_logs(id, word_id, rating, prev_state, next_state, prev_interval_days,
       next_interval_days, duration_ms, reviewed_at, day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId('log_'),
      wordId,
      Number(rating),
      state.state,
      next.state,
      state.interval_days,
      next.interval_days,
      durationMs ? Math.round(Number(durationMs)) : 0,
      now,
      todayKey()
    ]
  );

  return {
    body: {
      ok: true,
      next: {
        state: next.state,
        dueAt: next.due_at,
        intervalDays: next.interval_days,
        ease: next.ease,
        reps: next.reps,
        lapses: next.lapses
      },
      preview: previewIntervals(get('SELECT * FROM review_states WHERE word_id = ?', [wordId]), config.srs)
    }
  };
}

function stats() {
  const day = todayKey();
  const byState = all('SELECT state, COUNT(*) AS n FROM review_states GROUP BY state');
  const stateMap = Object.fromEntries(byState.map((r) => [r.state, Number(r.n)]));
  const totalWords = Number(get('SELECT COUNT(*) AS n FROM words WHERE deleted = 0').n || 0);
  const dueNow = Number(
    get(
      `SELECT COUNT(*) AS n FROM words w JOIN review_states s ON s.word_id = w.id
       WHERE w.deleted = 0 AND s.state IN ('learning','review','relearning') AND s.due_at <= ?`,
      [nowIso()]
    ).n || 0
  );
  const reviewsToday = Number(get('SELECT COUNT(*) AS n FROM review_logs WHERE day = ?', [day]).n || 0);
  const addedToday = Number(
    get('SELECT COUNT(*) AS n FROM words WHERE substr(created_at, 1, 10) = ? AND deleted = 0', [day])
      .n || 0
  );

  const days = all('SELECT DISTINCT day FROM review_logs ORDER BY day DESC LIMIT 400').map((r) => r.day);
  let streak = 0;
  let cursor = new Date();
  const daySet = new Set(days);
  if (!daySet.has(todayKey(cursor))) cursor = addDays(cursor, -1);
  while (daySet.has(todayKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  const history = all(
    `SELECT day,
            COUNT(*) AS reviews,
            SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS again
     FROM review_logs WHERE day >= ? GROUP BY day ORDER BY day ASC`,
    [todayKey(addDays(new Date(), -29))]
  );

  const tagRows = all("SELECT tags FROM words WHERE deleted = 0 AND tags IS NOT NULL AND tags != '[]'");
  const tagCount = {};
  for (const row of tagRows) {
    for (const tag of tagsFromJson(row.tags)) tagCount[tag] = (tagCount[tag] || 0) + 1;
  }

  const flagged = hydrate(
    all(
      `SELECT w.* FROM words w JOIN review_states s ON s.word_id = w.id
       WHERE w.deleted = 0 AND w.lookup_count >= ? AND (s.state != 'review' OR s.lapses > 0)
       ORDER BY w.lookup_count DESC LIMIT 30`,
      [config.srs.flagLookupCount || 3]
    )
  );

  return {
    body: {
      totalWords,
      byState: {
        new: stateMap.new || 0,
        learning: (stateMap.learning || 0) + (stateMap.relearning || 0),
        review: stateMap.review || 0
      },
      dueNow,
      reviewsToday,
      addedToday,
      streak,
      history: history.map((r) => ({
        day: r.day,
        reviews: Number(r.reviews),
        again: Number(r.again || 0)
      })),
      tags: Object.entries(tagCount)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([tag, count]) => ({ tag, count })),
      flagged,
      audio: audioCacheStats(),
      providers: {
        llm: config.providers.llm.enabled && Boolean(config.providers.llm.apiKey),
        dict: config.providers.dict.enabled,
        offline: offlineStatus(config.providers.offline).installed
      },
      availableProviders: PROVIDER_NAMES
    }
  };
}

function syncPull(query) {
  const since = Number(query.get('since') || 0);
  const words = all('SELECT * FROM words WHERE rev > ? ORDER BY rev ASC', [since]);
  const ids = words.map((w) => w.id);
  const defsMap = definitionsFor(ids);
  const statesMap = statesFor(ids);
  const deletedIds = words.filter((w) => w.deleted).map((w) => w.id);
  const items = words
    .filter((w) => !w.deleted)
    .map((row) => {
      const defs = defsMap.get(row.id) || {};
      return {
        ...serializeWord(row, null, statesMap.get(row.id)),
        definitions: defs,
        definition: preferredDefinition(defs)
      };
    });
  return { body: { rev: currentRev(), since, items, deletedIds } };
}

async function syncPush(body) {
  const incoming = Array.isArray(body?.words) ? body.words : [];
  const results = [];
  for (const raw of incoming) {
    const text = normalizeText(raw?.text);
    if (!text) continue;
    const key = lookupKey(text);
    const existing = findWordByKey(key);
    if (existing) {
      results.push({ text, status: 'exists', id: existing.id });
      continue;
    }
    const created = await createWord({ ...raw, text, lookup: raw.lookup !== false });
    results.push({
      text,
      status: created.status === 200 ? 'created' : 'created-no-definition',
      id: created.body?.item?.id
    });
  }
  return { body: { ok: true, results, rev: currentRev() } };
}

function clearAudio() {
  const result = clearAudioCache();
  return { body: { ok: true, ...result } };
}

function setPassword(body) {
  const { currentPassword, newPassword } = body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return { status: 400, body: { error: '新密码至少 6 位' } };
  }
  const ok = verifyPassword(String(currentPassword || ''), config.auth.salt, config.auth.passwordHash);
  if (!ok) return { status: 401, body: { error: '当前密码不正确' } };
  const { salt, hash } = hashPassword(String(newPassword));
  config.auth.salt = salt;
  config.auth.passwordHash = hash;
  writeConfig(config);
  return { body: { ok: true } };
}

// --- router -----------------------------------------------------------------

export async function handleApi(req, url, body) {
  const pathname = url.pathname;
  const method = req.method || 'GET';
  const query = url.searchParams;
  const segment = pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');
  const [head, tail] = segment.split('/');

  if (pathname === '/api/health') {
    return { body: { ok: true, name: 'english-learn', rev: currentRev() } };
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    return handleLogin(body);
  }
  if (head === 'auth' && tail === 'check') {
    return { body: { ok: true } };
  }
  if (head === 'auth' && tail === 'password' && method === 'POST') {
    return setPassword(body);
  }
  if (head === 'config') {
    if (method === 'GET') return { body: { config: publicConfig() } };
    if (method === 'PUT' || method === 'PATCH') {
      applyConfigPatch(body || {});
      return { body: { config: publicConfig() } };
    }
  }
  if (head === 'lookup' && method === 'POST') {
    const text = normalizeText(body?.text);
    if (!text) return { status: 400, body: { error: '内容为空' } };
    const result = await lookupAndCache(text, {
      wordId: body.wordId,
      provider: body.provider,
      kind: body.kind,
      sourceDoc: body.sourceDoc,
      sourceSentence: body.sourceSentence,
      force: body.force !== false
    });
    if (!result.ok) logMiss(text);
    return { status: result.ok ? 200 : 502, body: result };
  }
  if (head === 'spellcheck' && method === 'POST') {
    const text = normalizeText(body?.text);
    if (!text) return { status: 400, body: { error: '内容为空' } };
    return { body: await checkSpelling(text, config) };
  }
  if (head === 'tts' && method === 'GET') {
    const text = normalizeText(query.get('text') || '');
    if (!text) return { status: 400, body: { error: '缺少 text 参数' } };
    const result = await runTts(text, config, query.get('accent'));
    if (!result.ok) return { status: 502, body: { error: result.error } };
    return { raw: result };
  }
  if (head === 'words') {
    if (tail === 'missing' && method === 'GET') {
      return { body: { items: all('SELECT * FROM search_misses ORDER BY created_at DESC LIMIT 50') } };
    }
    if (tail === 'bulk' && method === 'POST') {
      const items = Array.isArray(body?.items) ? body.items : [];
      const created = [];
      for (const item of items) {
        const result = await createWord(item);
        created.push(result.body?.item);
      }
      return { body: { items: created.filter(Boolean) } };
    }
    if (!tail && method === 'GET') return listWords(query);
    if (!tail && method === 'POST') return createWord(body || {});
    if (tail && method === 'GET') return wordDetail(tail);
    if (tail && (method === 'PATCH' || method === 'PUT')) return updateWord(tail, body || {});
    if (tail && method === 'DELETE') return deleteWord(tail);
  }
  if (head === 'review') {
    if (tail === 'queue' && method === 'GET') return reviewQueue(query);
    if (!tail && method === 'POST') return submitReview(body || {});
  }
  if (head === 'stats' && method === 'GET') return stats();
  if (head === 'sync') {
    if (!tail && method === 'GET') return syncPull(query);
    if (tail === 'push' && method === 'POST') return syncPush(body || {});
  }
  if (head === 'audio' && tail === 'clear' && method === 'POST') return clearAudio();
  return { status: 404, body: { error: `未知接口 ${method} ${pathname}` } };
}

export function isPublic(pathname) {
  return !authRequired(pathname);
}

export function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return verifyToken(token, config.auth.secret);
}

export function requireAuth(req, url) {
  if (!authRequired(url.pathname)) return null;
  const session = authenticate(req);
  if (!session) return { status: 401, body: { error: '未登录或登录已过期' } };
  return null;
}

export function currentConfig() {
  return config;
}
