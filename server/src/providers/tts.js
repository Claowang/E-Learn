import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { stableHash } from '../util.js';

const AUDIO_DIR = path.join(DATA_DIR, 'audio');

function extFor(contentType) {
  if (!contentType) return 'mp3';
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('ogg')) return 'ogg';
  return 'mp3';
}

/**
 * Free text-to-speech providers.
 *
 * Default is 有道词典的公开发音接口：type=1 英音, type=2 美音。
 * It needs no key and is reachable from mainland China. Set tts.engine to "none"
 * to make the client fall back to the browser's built-in speechSynthesis.
 */
export async function synthesize(text, { engine, accent, baseUrl, cache }) {
  if (engine === 'none') {
    return { ok: false, error: 'TTS 已关闭，请使用浏览器内置发音' };
  }

  const type = accent === 'uk' ? '1' : '2';
  const url = `${baseUrl || 'https://dict.youdao.com/dictvoice'}?audio=${encodeURIComponent(
    text
  )}&type=${type}`;

  if (cache) {
    const file = path.join(AUDIO_DIR, `${stableHash(`${engine}:${accent}:${text}`)}.mp3`);
    if (fs.existsSync(file)) {
      return { ok: true, file, contentType: 'audio/mpeg', bytes: fs.statSync(file).size, cached: true };
    }
  }

  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (english-learn-vocab-tool)' },
      signal: AbortSignal.timeout(15000)
    });
  } catch (err) {
    return { ok: false, error: `发音请求失败：${err.message}` };
  }
  if (!response.ok) {
    return { ok: false, error: `发音接口返回 ${response.status}` };
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 512) {
    return { ok: false, error: '发音接口返回了空音频' };
  }

  if (cache) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const file = path.join(
      AUDIO_DIR,
      `${stableHash(`${engine}:${accent}:${text}`)}.${extFor(response.headers.get('content-type'))}`
    );
    fs.writeFileSync(file, buffer);
    return { ok: true, file, contentType: 'audio/mpeg', bytes: buffer.length, cached: false };
  }

  return {
    ok: true,
    buffer,
    contentType: response.headers.get('content-type') || 'audio/mpeg',
    bytes: buffer.length,
    cached: false
  };
}

export function audioCacheStats() {
  try {
    const files = fs.readdirSync(AUDIO_DIR);
    let bytes = 0;
    for (const name of files) {
      bytes += fs.statSync(path.join(AUDIO_DIR, name)).size;
    }
    return { files: files.length, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export function clearAudioCache() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(AUDIO_DIR)) {
      fs.unlinkSync(path.join(AUDIO_DIR, name));
      removed += 1;
    }
  } catch {
    /* nothing to clear */
  }
  return { removed };
}
