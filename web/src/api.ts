import type {
  AppConfig,
  DefinitionCard,
  LookupResult,
  QueueStats,
  ReviewLog,
  SpellCheckResult,
  Stats,
  Word
} from './types';

const TOKEN_KEY = 'el.token';
const API_BASE_KEY = 'el.apiBase';
const QUEUE_KEY = 'el.pendingReviews';

export interface PendingReview {
  wordId: string;
  rating: number;
  durationMs: number;
  queuedAt: string;
}

export function getApiBase(): string {
  const stored = localStorage.getItem(API_BASE_KEY);
  if (stored !== null) return stored.replace(/\/+$/, '');
  const envBase = (import.meta.env.VITE_API_BASE as string | undefined) || '';
  return envBase.replace(/\/+$/, '');
}

export function setApiBase(value: string) {
  if (value) localStorage.setItem(API_BASE_KEY, value.replace(/\/+$/, ''));
  else localStorage.removeItem(API_BASE_KEY);
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}${path}`, { ...options, headers });
  } catch {
    throw new ApiError('网络不可用，请检查连接或服务器地址', 0);
  }

  if (response.status === 401) {
    setToken(null);
    window.dispatchEvent(new CustomEvent('el:unauthorized'));
    throw new ApiError('登录已过期，请重新登录', 401);
  }
  if (!response.ok && response.status !== 207) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data?.error || '';
    } catch {
      /* ignore */
    }
    throw new ApiError(detail || `请求失败（${response.status}）`, response.status);
  }
  return (await response.json()) as T;
}

export const api = {
  login: (password: string) =>
    request<{ token: string; expiresInDays: number }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    }),

  health: () => request<{ ok: boolean }>('/api/health'),

  getConfig: () => request<{ config: AppConfig }>('/api/config').then((r) => r.config),

  updateConfig: (patch: Record<string, unknown>) =>
    request<{ config: AppConfig }>('/api/config', {
      method: 'PUT',
      body: JSON.stringify(patch)
    }).then((r) => r.config),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword })
    }),

  listWords: (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const qs = search.toString();
    return request<{ total: number; items: Word[] }>(`/api/words${qs ? `?${qs}` : ''}`);
  },

  createWord: (payload: Record<string, unknown>) =>
    request<{ item: Word; lookup: LookupResult }>('/api/words', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  getWord: (id: string) =>
    request<{ item: Word; logs: ReviewLog[]; preview: Record<string, string> }>(`/api/words/${id}`),

  patchWord: (id: string, payload: Record<string, unknown>) =>
    request<{ item: Word; merged?: boolean }>(`/api/words/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload)
    }),

  deleteWord: (id: string) =>
    request<{ ok: boolean }>(`/api/words/${id}`, { method: 'DELETE' }),

  lookup: (payload: Record<string, unknown>) =>
    request<LookupResult>('/api/lookup', { method: 'POST', body: JSON.stringify(payload) }),

  spellcheck: (text: string) =>
    request<SpellCheckResult>('/api/spellcheck', {
      method: 'POST',
      body: JSON.stringify({ text })
    }),

  reviewQueue: (limit: number, includeNew = true) =>
    request<{ items: Word[]; stats: QueueStats }>(
      `/api/review/queue?limit=${limit}&new=${includeNew ? 1 : 0}`
    ),

  submitReview: (wordId: string, rating: number, durationMs = 0) =>
    request<{ ok: boolean; next: Word['review']; preview: Record<string, string> }>('/api/review', {
      method: 'POST',
      body: JSON.stringify({ wordId, rating, durationMs })
    }),

  stats: () => request<Stats>('/api/stats'),

  syncPull: (since = 0) =>
    request<{ rev: number; items: Word[]; deletedIds: string[] }>(`/api/sync?since=${since}`),

  syncPush: (words: Record<string, unknown>[]) =>
    request<{ ok: boolean; results: unknown[]; rev: number }>('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ words })
    }),

  clearAudio: () => request<{ ok: boolean; removed: number }>('/api/audio/clear', { method: 'POST' })
};

export async function fetchAudio(text: string, accent: string): Promise<Blob | null> {
  const url = `${getApiBase()}/api/tts?text=${encodeURIComponent(text)}&accent=${accent}`;
  try {
    const response = await fetch(url, {
      headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {}
    });
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

// --- offline review queue ---------------------------------------------------

export function pendingReviews(): PendingReview[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as PendingReview[]) : [];
  } catch {
    return [];
  }
}

function savePending(items: PendingReview[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('el:queue', { detail: items.length }));
}

export function enqueueReview(item: PendingReview) {
  savePending([...pendingReviews(), item]);
}

export async function flushPendingReviews(): Promise<number> {
  const items = pendingReviews();
  if (!items.length) return 0;
  const remaining: PendingReview[] = [];
  let sent = 0;
  for (const item of items) {
    try {
      await api.submitReview(item.wordId, item.rating, item.durationMs);
      sent += 1;
    } catch {
      remaining.push(item);
    }
  }
  savePending(remaining);
  return sent;
}

export type { DefinitionCard };
