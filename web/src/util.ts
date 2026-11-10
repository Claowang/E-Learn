import { fetchAudio } from './api';
import type { ReviewSnapshot } from './types';

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${base} ${pad(date.getHours())}:${pad(date.getMinutes())}` : base;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(iso);
}

export function dueLabel(review: ReviewSnapshot | null): string {
  if (!review) return '未排程';
  if (review.state === 'new') return '待学习';
  if (!review.dueAt) return '待学习';
  const diff = new Date(review.dueAt).getTime() - Date.now();
  if (diff <= 0) return review.state === 'relearning' ? '重学中' : '待复习';
  const minutes = diff / 60000;
  if (minutes < 60) return `${Math.round(minutes)} 分钟后`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

export function stateLabel(state: string | undefined): string {
  switch (state) {
    case 'new':
      return '新词';
    case 'learning':
      return '学习中';
    case 'relearning':
      return '重学中';
    case 'review':
      return '复习中';
    default:
      return '—';
  }
}

export function providerLabel(provider: string): string {
  if (!provider) return '未知';
  if (provider.startsWith('dict:youdao')) return '有道词典';
  if (provider.startsWith('dict:baidu')) return '百度翻译';
  if (provider.startsWith('dict:freedict')) return '免费词典';
  if (provider.startsWith('dict')) return '在线词典';
  if (provider === 'llm') return '大模型';
  if (provider === 'offline') return '离线词库';
  return provider;
}

export function providerOptions(config: { providers: { llm: { hasKey: boolean }; dict: { enabled: boolean }; offline: { status: { installed: boolean } } } } | null) {
  const options: { value: string; label: string }[] = [{ value: 'auto', label: '自动（推荐顺序）' }];
  if (config?.providers.llm.hasKey) options.push({ value: 'llm', label: '大模型解释' });
  if (config?.providers.dict.enabled) options.push({ value: 'dict', label: '在线词典' });
  if (config?.providers.offline.status.installed) options.push({ value: 'offline', label: '离线词库' });
  options.push({ value: 'all', label: '全部（依次尝试）' });
  return options;
}

export function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  ];
}

export function bytesLabel(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// --- pronunciation ----------------------------------------------------------

const audioUrls = new Map<string, string>();
let activeAudio: HTMLAudioElement | null = null;

export function speakWithBrowser(text: string, accent: string): boolean {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  const lang = accent === 'uk' ? 'en-GB' : 'en-US';
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang;
  utter.rate = 0.95;
  const voices = synth.getVoices();
  const voice =
    voices.find((v) => v.lang.replace('_', '-') === lang) ||
    voices.find((v) => v.lang.startsWith('en'));
  if (voice) utter.voice = voice;
  synth.cancel();
  synth.speak(utter);
  return true;
}

/**
 * Prefer the server cached audio (real dictionary pronunciation), fall back to the
 * browser's built-in voice when the network or the TTS provider is unavailable.
 */
export async function pronounce(text: string, accent: string): Promise<'server' | 'browser' | 'failed'> {
  const clean = text.trim();
  if (!clean) return 'failed';
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }

  const key = `${accent}:${clean.toLowerCase()}`;
  let url = audioUrls.get(key);
  if (!url) {
    const blob = await fetchAudio(clean, accent);
    if (blob && blob.size > 0) {
      url = URL.createObjectURL(blob);
      audioUrls.set(key, url);
    }
  }

  if (url) {
    const audio = new Audio(url);
    activeAudio = audio;
    try {
      await audio.play();
      return 'server';
    } catch {
      /* fall through to the browser voice */
    }
  }
  return speakWithBrowser(clean, accent) ? 'browser' : 'failed';
}
