import { lookupWithLlm } from './llm.js';
import { lookupWithDict } from './dict.js';
import { lookupWithOffline } from './offline.js';
import { synthesize } from './tts.js';

const NAMES = ['llm', 'dict', 'offline'];

function enabled(name, providers) {
  const cfg = providers[name];
  if (!cfg?.enabled) return false;
  if (name === 'llm') return Boolean(cfg.apiKey);
  return true;
}

function resolveChain(requested, config) {
  const providers = config.providers;
  const all = NAMES.filter((name) => enabled(name, providers));
  if (!requested || requested === 'auto') {
    const ordered = (config.lookup.chain || NAMES).filter((name) => all.includes(name));
    return ordered.length ? ordered : all;
  }
  if (requested === 'all') return all;
  return all.includes(requested) ? [requested] : all;
}

/**
 * Look a word up through one or more providers.
 * Returns { ok, card, provider, attempts } where attempts records every failure so the
 * UI can tell you *why* nothing came back (missing key, offline db not installed, ...).
 */
export async function lookup(text, { provider, kind, sourceDoc, sourceSentence, config }) {
  const chain = resolveChain(provider, config);
  if (!chain.length) {
    return {
      ok: false,
      attempts: [],
      error: '没有任何可用的释义来源：请先在设置里配置大模型 API Key，或启用在线词典 / 离线词库。'
    };
  }

  const attempts = [];
  const input = { text, kind, sourceDoc, sourceSentence };
  for (const name of chain) {
    let result;
    if (name === 'llm') {
      result = await lookupWithLlm(input, config.providers.llm);
    } else if (name === 'dict') {
      result = await lookupWithDict(text, config.providers.dict);
    } else {
      result = lookupWithOffline(text, config.providers.offline);
    }

    if (result.ok && result.payload) {
      return {
        ok: true,
        provider: result.payload.provider || name,
        card: result.payload,
        usage: result.usage || null,
        attempts
      };
    }
    attempts.push({ provider: result.provider || name, error: result.error || '未知错误' });
  }

  return {
    ok: false,
    attempts,
    error: attempts.map((a) => `${a.provider}: ${a.error}`).join('；') || '查询失败'
  };
}

export async function tts(text, config, accentOverride) {
  return synthesize(text, {
    engine: config.tts.engine,
    accent: accentOverride || config.tts.accent || 'us',
    baseUrl: config.tts.baseUrl,
    cache: config.tts.cache !== false
  });
}

export { NAMES as PROVIDER_NAMES };
