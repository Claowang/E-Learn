import { extractJsonObject, truncate } from '../util.js';

const SYSTEM_PROMPT = `你是一位专门帮助中国嵌入式软件工程师阅读英文技术文档的词汇助手。
你熟悉芯片 Datasheet、Reference Manual、Errata、应用笔记、通信协议标准和开源项目的英文表达习惯。

你的任务是解释用户遇到的单词、短语或句子。要求：
1. 用简体中文解释，简明准确，不要空话。
2. 必须结合嵌入式/电子/计算机领域语境：如果这个词在技术文档里有不同于日常英语的含义，一定要指出。
3. 例句要像真实技术文档或工程交流里的句子，不要写文学化的句子。
4. 只输出一个 JSON 对象，不要输出 Markdown 代码块、不要任何解释性前后缀文字。
5. 拼写检查只针对单个英文单词：短语、整句、缩写、型号、变量名、公司/产品名一律视为拼写正确。
   英式/美式拼写差异（behaviour/behavior）不算错误，领域术语（datasheet、debounce、errata）也不算错误。
   只有在明显是打字错误时才给出建议，并保证建议是真实存在的常用词。

JSON 字段定义（严格遵守，缺失内容用空字符串或空数组，不要省略字段）：
{
  "translation": "最直接的中文意思，一行以内",
  "pos": ["n.", "v."],
  "phonetics": { "us": "/美式音标/", "uk": "/英式音标/" },
  "senses": [
    { "pos": "词性缩写", "meaning": "中文释义", "note": "什么场景下用这个义项，语域或限制" }
  ],
  "domainNote": "该词在嵌入式/电子/协议/软件工程语境下的特殊含义、常见误译或坑点；若与通用含义一致则写清",
  "abbreviations": [
    { "term": "缩写原文", "full": "English full form", "zh": "中文全称" }
  ],
  "collocations": ["高频搭配或固定表达，附中文"],
  "examples": [ { "en": "英文例句", "zh": "中文翻译" } ],
  "synonymNotes": [ { "word": "近义词", "distinction": "和本词的技术语感差异" } ],
  "writingExamples": ["3 条可直接用于邮件/commit message/issue/文档的英文句子"],
  "memoryHook": "记忆方法：词根词缀、联想、易混点，一到两句",
  "spelling": {
    "isCorrect": true,
    "suggestion": "如果拼写有误，给出正确拼写；否则空字符串",
    "note": "判断依据，一句话；没有把握时把 isCorrect 设为 true"
  }
}`;

function buildUserPrompt({ text, kind, sourceDoc, sourceSentence }) {
  const lines = [`需要解释的内容：${text}`, `类型：${kind}`];
  if (sourceDoc) lines.push(`来源文档：${sourceDoc}`);
  if (sourceSentence) {
    lines.push(`我遇到它时的原句：${sourceSentence}`);
    lines.push('请让释义贴合这句话中的实际含义。');
  }
  if (kind === 'sentence') {
    lines.push(
      '这是一整句：请给出整句翻译、句子结构拆解要点、其中的关键短语，并把它放进 examples 与 collocations。'
    );
  }
  lines.push(
    'examples 给 2 到 3 条，writingExamples 必须给满 3 条，collocations 至少 3 条（不足则给最接近的固定表达）。'
  );
  return lines.join('\n');
}

function normalize(raw, meta) {
  const phonetics = raw.phonetics && typeof raw.phonetics === 'object' ? raw.phonetics : {};
  const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : value ? [value] : []);
  return {
    provider: 'llm',
    model: meta.model,
    translation: String(raw.translation || '').trim(),
    pos: asArray(raw.pos).map(String),
    phonetics: {
      us: String(phonetics.us || '').trim(),
      uk: String(phonetics.uk || '').trim()
    },
    senses: asArray(raw.senses).map((s) => ({
      pos: String(s?.pos || '').trim(),
      meaning: String(s?.meaning || '').trim(),
      note: String(s?.note || '').trim()
    })),
    domainNote: String(raw.domainNote || '').trim(),
    abbreviations: asArray(raw.abbreviations).map((a) => ({
      term: String(a?.term || '').trim(),
      full: String(a?.full || '').trim(),
      zh: String(a?.zh || '').trim()
    })),
    collocations: asArray(raw.collocations).map((c) =>
      typeof c === 'string' ? { en: c, zh: '' } : { en: String(c?.en || ''), zh: String(c?.zh || '') }
    ),
    examples: asArray(raw.examples).map((e) => ({
      en: String(e?.en || '').trim(),
      zh: String(e?.zh || '').trim()
    })),
    synonymNotes: asArray(raw.synonymNotes).map((s) => ({
      word: String(s?.word || '').trim(),
      distinction: String(s?.distinction || '').trim()
    })),
    writingExamples: asArray(raw.writingExamples).map(String),
    memoryHook: String(raw.memoryHook || '').trim(),
    spelling: {
      // Be conservative: only flag when the model explicitly says it is wrong and
      // actually proposes a replacement.
      isCorrect:
        raw.spelling?.isCorrect === false && String(raw.spelling?.suggestion || '').trim()
          ? false
          : true,
      suggestion: String(raw.spelling?.suggestion || '').trim(),
      note: String(raw.spelling?.note || '').trim()
    }
  };
}

async function requestCompletion(url, settings, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(settings.timeoutMs ?? 60000)
  });
}

export async function lookupWithLlm(input, settings) {
  if (!settings.apiKey) {
    return { ok: false, provider: 'llm', error: '未配置大模型 API Key' };
  }
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model: settings.model,
    temperature: settings.temperature ?? 0.2,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) }
    ]
  };

  let response;
  try {
    response = await requestCompletion(url, settings, body);
  } catch (err) {
    return { ok: false, provider: 'llm', error: `请求大模型失败：${err.message}` };
  }

  if (!response.ok) {
    const detail = truncate(await response.text().catch(() => ''), 300);
    if (response.status === 400 && /response_format/i.test(detail)) {
      // Some OpenAI-compatible gateways reject response_format; retry once without it.
      delete body.response_format;
      try {
        const retry = await requestCompletion(url, settings, body);
        if (retry.ok) {
          const data = await retry.json();
          const parsed = extractJsonObject(data?.choices?.[0]?.message?.content);
          if (parsed) {
            return {
              ok: true,
              payload: normalize(parsed, { model: settings.model }),
              usage: data?.usage || null
            };
          }
        }
      } catch {
        /* fall through to the original error */
      }
    }
    return { ok: false, provider: 'llm', error: `大模型返回 ${response.status}：${detail}` };
  }

  const data = await response.json();
  const parsed = extractJsonObject(data?.choices?.[0]?.message?.content);
  if (!parsed) {
    return { ok: false, provider: 'llm', error: '无法解析大模型返回的 JSON' };
  }
  return { ok: true, payload: normalize(parsed, { model: settings.model }), usage: data?.usage || null };
}
