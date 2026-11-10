import { extractJsonObject, normalizeText, truncate } from '../util.js';
import { suggestFromOffline } from './offline.js';

const SINGLE_WORD = /^[A-Za-z][A-Za-z'’-]{1,29}$/;

const SYSTEM_PROMPT = `你是英文拼写检查器，服务对象是阅读芯片手册和英文技术文档的中国工程师。
判断用户给出的内容是否是拼写正确、真实存在的英文单词。

规则：
1. 只判断单个英文单词。短语、整句、缩写（DMA/NVIC）、型号、变量名一律视为正确。
2. 英式/美式拼写差异（behaviour/behavior）不算错误。
3. 技术术语、专有名词、常见缩写（datasheet、debounce、errata、localhost）不算错误。
4. 只有明显是打字错误时才给建议，建议必须是真实存在的常用词；没有把握时认为正确。
5. 只输出 JSON：{"isCorrect":true,"suggestion":"","reason":"一句话依据"}`;

async function askLlm(clean, llm) {
  if (!llm.enabled || !llm.apiKey) return null;
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: llm.model,
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `需要检查的词：${clean}` }
    ]
  };
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${llm.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(llm.timeoutMs || 60000, 30000))
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    if (response.status === 400) {
      delete body.response_format;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${llm.apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000)
        });
      } catch {
        return null;
      }
      if (!response.ok) return null;
    } else {
      return null;
    }
  }
  try {
    const data = await response.json();
    const parsed = extractJsonObject(data?.choices?.[0]?.message?.content);
    if (!parsed) return null;
    const suggestion = String(parsed.suggestion || '').trim();
    const isCorrect = parsed.isCorrect !== false || !suggestion;
    return {
      checked: true,
      isCorrect,
      suggestion: isCorrect ? '' : suggestion,
      source: 'llm',
      reason: truncate(String(parsed.reason || '').trim(), 160)
    };
  } catch {
    return null;
  }
}

/**
 * Check a single word's spelling.
 * Offline dictionary first (free, instant), then the model if configured.
 * Conservative by design: when nothing can be verified we report "correct" so the
 * user is never nagged with a guess.
 */
export async function checkSpelling(text, config) {
  const clean = normalizeText(text);
  if (!clean) {
    return { checked: false, isCorrect: true, suggestion: '', source: 'none', reason: '内容为空' };
  }
  if (!SINGLE_WORD.test(clean)) {
    return {
      checked: true,
      isCorrect: true,
      suggestion: '',
      source: 'rule',
      reason: '不是单个英文单词，跳过拼写检查'
    };
  }

  const offline = suggestFromOffline(clean, config.providers.offline);
  if (offline) return offline;

  const fromLlm = await askLlm(clean, config.providers.llm);
  if (fromLlm) return fromLlm;

  return {
    checked: false,
    isCorrect: true,
    suggestion: '',
    source: 'none',
    reason: '没有可用的拼写检查来源（装离线词库或配置大模型即可开启）'
  };
}
