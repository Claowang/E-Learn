#!/usr/bin/env node
/**
 * 一个假的 OpenAI 兼容接口，用来在没有 API Key 的情况下验证整条链路
 * （请求格式、JSON 解析、释义入库、网页渲染）是否正常。
 *
 *   node src/tools/mock-llm.js            # 监听 8899
 *   然后在「设置」里把大模型 Base URL 填成 http://localhost:8899/v1，API Key 随便填。
 *
 * 它只返回固定内容，不是真的翻译，不要用它学习。
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8899);

const KNOWN_TYPOS = {
  loaclhost: 'localhost',
  recieve: 'receive',
  seperate: 'separate',
  debouce: 'debounce',
  registr: 'register',
  occured: 'occurred',
  adress: 'address'
};

function card(word) {
  const fix = KNOWN_TYPOS[word.toLowerCase()];
  return {
    translation: `${word}（示例释义）`,
    pos: ['n.', 'v.'],
    phonetics: { us: '/ˈeksæmpəl/', uk: '/ɪɡˈzɑːmpəl/' },
    senses: [
      { pos: 'n.', meaning: '中文义项一，用来说明这个词在文档里的常见含义。', note: '技术手册中常见' },
      { pos: 'v.', meaning: '中文义项二，动作含义。', note: '多用于描述操作' }
    ],
    domainNote:
      '这是假模型返回的占位内容，用来验证链路。真实使用时会由大模型结合你读到的原句给出嵌入式领域的解释。',
    abbreviations: [{ term: 'MOCK', full: 'Mock Object Check Kit', zh: '示例缩写' }],
    collocations: [
      { en: `enable ${word}`, zh: '使能' },
      { en: `${word} cycle`, zh: '循环' },
      { en: `in the event of ${word}`, zh: '在发生时' }
    ],
    examples: [
      { en: `The device enters low-power mode when ${word} is asserted.`, zh: '当相关信号有效时，器件进入低功耗模式。' },
      { en: `Refer to the datasheet for the typical ${word} value.`, zh: '典型值请参考数据手册。' }
    ],
    synonymNotes: [{ word: 'similar-word', distinction: '语感差异示例' }],
    writingExamples: [
      `Please confirm whether ${word} should stay enabled during firmware update.`,
      `I reproduced the issue after a ${word} cycle on the target board.`,
      `The ${word} field is reserved in this revision of the register map.`
    ],
    memoryHook: '示例记忆钩子：把词根拆开记，配合第一次遇到的文档场景。',
    spelling: fix
      ? { isCorrect: false, suggestion: fix, note: `示例假模型：这是 ${fix} 的常见拼写错误` }
      : { isCorrect: true, suggestion: '', note: '' }
  };
}

const server = http.createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let word = 'example';
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const text = [
        ...(body.messages || []).map((message) => message.content),
        ...(Object.prototype.hasOwnProperty.call(body, 'prompt') ? [body.prompt] : [])
      ].join('\n');
      const match = text.match(/需要解释的内容[：:]\s*(.+)/);
      if (match) word = match[1].trim().split('\n')[0];
    } catch {
      /* keep the default */
    }
    const payload = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(card(word)) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

server.listen(PORT, () => console.log(`mock LLM listening on http://localhost:${PORT}/v1`));
