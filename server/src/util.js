import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

export function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, useSalt, 32).toString('hex');
  return { salt: useSalt, hash: derived };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function signToken(payload, secret, days) {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + Math.round(days * 86400)
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

export function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'\u201c\u201d()[\]{},.;:!?]+/, '')
    .replace(/[\s,.;:!?"'\u201c\u201d()[\]{}]+$/, '')
    .trim();
}

export function lookupKey(text) {
  return normalizeText(text).toLowerCase();
}

export function classifyKind(text) {
  const clean = normalizeText(text);
  const words = clean.split(/[\s-]+/).filter(Boolean);
  if (words.length === 1 && !/[.?!]/.test(clean)) return 'word';
  if (words.length <= 5 && !/[.?!]/.test(clean)) return 'phrase';
  return 'sentence';
}

export function randomPassword(length = 12) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

export function maskSecret(value) {
  if (!value) return '';
  const str = String(value);
  if (str.length <= 6) return '****';
  return `${str.slice(0, 3)}****${str.slice(-3)}`;
}

export function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pull the first JSON object out of a model response that may be fenced or chatty. */
export function extractJsonObject(text) {
  if (!text) return null;
  const direct = safeJsonParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const parsed = safeJsonParse(fence[1].trim());
    if (parsed) return parsed;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = safeJsonParse(text.slice(start, end + 1));
    if (parsed) return parsed;
  }
  return null;
}

export function truncate(text, max = 400) {
  const str = String(text || '');
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

export function stableHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}
