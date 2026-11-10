import crypto from 'node:crypto';
import { truncate } from '../util.js';

function emptyCard(provider, extra = {}) {
  return {
    provider,
    translation: '',
    pos: [],
    phonetics: { us: '', uk: '' },
    senses: [],
    domainNote: '',
    abbreviations: [],
    collocations: [],
    examples: [],
    synonymNotes: [],
    writingExamples: [],
    memoryHook: '',
    ...extra
  };
}

function splitTranslations(text) {
  return String(text || '')
    .split(/\n|;|；/)
    .map((line) => line.trim())
    .filter(Boolean);
}

// --- 有道智云 ---------------------------------------------------------------
async function lookupYoudao(text, cfg) {
  if (!cfg.appKey || !cfg.appSecret) {
    return { ok: false, provider: 'dict:youdao', error: '未配置有道 appKey / appSecret' };
  }
  const salt = crypto.randomUUID();
  const curtime = Math.floor(Date.now() / 1000).toString();
  const truncated = text.length <= 20 ? text : `${text.slice(0, 10)}${text.length}${text.slice(-10)}`;
  const sign = crypto
    .createHash('sha256')
    .update(cfg.appKey + truncated + salt + curtime + cfg.appSecret)
    .digest('hex');

  const params = new URLSearchParams({
    q: text,
    from: 'en',
    to: 'zh-CHS',
    appKey: cfg.appKey,
    salt,
    sign,
    signType: 'v3',
    curtime
  });

  const response = await fetch('https://openapi.youdao.com/api', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (data.errorCode !== '0') {
    return { ok: false, provider: 'dict:youdao', error: `有道返回错误码 ${data.errorCode}` };
  }
  const card = emptyCard('dict:youdao');
  card.translation = (data.translation || []).join('；');

  const basic = data.basic;
  if (basic) {
    if (basic['us-phonetic']) card.phonetics.us = `/${basic['us-phonetic']}/`;
    if (basic['uk-phonetic']) card.phonetics.uk = `/${basic['uk-phonetic']}/`;
    else if (basic.phonetic) card.phonetics.uk = `/${basic.phonetic}/`;
    card.senses = (basic.explains || []).map((line) => {
      const match = String(line).match(/^([a-z]+\.)\s*(.*)$/i);
      return { pos: match ? match[1] : '', meaning: match ? match[2] : String(line), note: '' };
    });
    card.pos = [...new Set(card.senses.map((s) => s.pos).filter(Boolean))];
    card.collocations = (basic.wfs || [])
      .map((w) => ({ en: w.wf?.name || '', zh: w.wf?.value || '' }))
      .filter((c) => c.en);
  }
  card.examples = (data.web || [])
    .slice(0, 4)
    .map((entry) => ({ en: entry.key || '', zh: (entry.value || []).join('；') }))
    .filter((e) => e.en);

  if (!card.translation && card.senses.length === 0) {
    return { ok: false, provider: 'dict:youdao', error: '有道没有返回释义' };
  }
  return { ok: true, payload: card };
}

// --- 百度翻译开放平台 -------------------------------------------------------
async function lookupBaidu(text, cfg) {
  if (!cfg.appId || !cfg.secretKey) {
    return { ok: false, provider: 'dict:baidu', error: '未配置百度 appId / secretKey' };
  }
  const salt = Math.floor(Math.random() * 1e9).toString();
  const sign = crypto
    .createHash('md5')
    .update(cfg.appId + text + salt + cfg.secretKey)
    .digest('hex');
  const params = new URLSearchParams({
    q: text,
    from: 'en',
    to: 'zh',
    appid: cfg.appId,
    salt,
    sign
  });
  const response = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (data.error_code) {
    return { ok: false, provider: 'dict:baidu', error: `百度返回错误码 ${data.error_code}` };
  }
  const card = emptyCard('dict:baidu');
  const parts = (data.trans_result || []).map((r) => r.dst);
  card.translation = parts.join(' ');
  card.senses = splitTranslations(parts.join('\n')).map((meaning) => ({
    pos: '',
    meaning,
    note: ''
  }));
  return { ok: true, payload: card };
}

// --- dictionaryapi.dev（免费、无需 Key，只提供英文释义） ----------------------
async function lookupFreeDict(text, cfg) {
  const base = (cfg.baseUrl || 'https://api.dictionaryapi.dev/api/v2/entries/en').replace(/\/+$/, '');
  let response;
  try {
    response = await fetch(`${base}/${encodeURIComponent(text)}`, {
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    return { ok: false, provider: 'dict:freedict', error: `请求失败：${err.message}` };
  }
  if (!response.ok) {
    return { ok: false, provider: 'dict:freedict', error: `返回 ${response.status}` };
  }
  const data = await response.json();
  if (!Array.isArray(data) || !data.length) {
    return { ok: false, provider: 'dict:freedict', error: '没有查到该词' };
  }
  const card = emptyCard('dict:freedict');
  for (const entry of data.slice(0, 2)) {
    if (!card.phonetics.us && entry.phonetic) card.phonetics.us = entry.phonetic;
    for (const meaning of entry.meanings || []) {
      card.pos.push(meaning.partOfSpeech || '');
      for (const def of (meaning.definitions || []).slice(0, 2)) {
        card.senses.push({
          pos: meaning.partOfSpeech || '',
          meaning: def.definition || '',
          note: def.example ? `例：${def.example}` : ''
        });
      }
    }
  }
  card.pos = [...new Set(card.pos.filter(Boolean))];
  card.domainNote = '免费词典只提供英文释义，没有中文翻译。';
  return card.senses.length
    ? { ok: true, payload: card }
    : { ok: false, provider: 'dict:freedict', error: '没有可用释义' };
}

export async function lookupWithDict(text, cfg) {
  try {
    switch (cfg.engine) {
      case 'baidu':
        return await lookupBaidu(text, cfg.baidu || {});
      case 'freedict':
        return await lookupFreeDict(text, cfg.freedict || {});
      case 'youdao':
      default:
        return await lookupYoudao(text, cfg.youdao || {});
    }
  } catch (err) {
    return { ok: false, provider: `dict:${cfg.engine}`, error: truncate(err.message, 200) };
  }
}
