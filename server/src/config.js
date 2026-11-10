import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.EL_DATA_DIR
  ? path.resolve(process.env.EL_DATA_DIR)
  : path.join(SERVER_ROOT, 'data');

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  port: Number(process.env.EL_PORT || 8787),
  host: process.env.EL_HOST || '0.0.0.0',
  // Public URL of this server, used by the web client to talk to the API.
  publicUrl: '',
  auth: {
    passwordHash: '',
    salt: '',
    secret: '',
    tokenDays: 90
  },
  lookup: {
    // llm | dict | offline | auto
    // auto walks `chain` in order and returns the first provider that has an answer.
    defaultProvider: 'llm',
    chain: ['llm', 'dict', 'offline'],
    cacheDays: 365,
    enrichWithOffline: false
  },
  providers: {
    llm: {
      enabled: true,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.2,
      timeoutMs: 60000
    },
    dict: {
      enabled: false,
      // youdao | baidu | freedict
      engine: 'youdao',
      youdao: { appKey: '', appSecret: '' },
      baidu: { appId: '', secretKey: '' },
      freedict: { baseUrl: 'https://api.dictionaryapi.dev/api/v2/entries/en' }
    },
    offline: {
      enabled: true,
      dbPath: 'ecdict.db',
      csvPath: 'ecdict.csv',
      autoDownload: false
    }
  },
  tts: {
    // youdao | none
    engine: 'youdao',
    accent: 'us',
    baseUrl: 'https://dict.youdao.com/dictvoice',
    cache: true
  },
  srs: {
    algorithm: 'sm2',
    learningSteps: [1, 10],
    graduatingInterval: 1,
    easyInterval: 4,
    relearnSteps: [10],
    minEase: 1.3,
    maxIntervalDays: 3650,
    newPerDay: 20,
    reviewsPerDay: 200,
    // A word looked up this many times without being mastered gets flagged.
    flagLookupCount: 3
  }
};

function deepMerge(base, override) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'audio'), { recursive: true });
}

export function loadConfig() {
  ensureDataDir();
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }
  const config = deepMerge(DEFAULTS, stored);
  let dirty = !fs.existsSync(CONFIG_PATH);
  if (!config.auth.secret) {
    config.auth.secret = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (dirty) writeConfig(config);
  return config;
}

export function writeConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export { CONFIG_PATH, DEFAULTS };
