export type Kind = 'word' | 'phrase' | 'sentence';

export interface Sense {
  pos: string;
  meaning: string;
  note: string;
}

export interface DefinitionCard {
  provider: string;
  model?: string;
  translation: string;
  pos: string[];
  phonetics: { us: string; uk: string };
  senses: Sense[];
  domainNote: string;
  abbreviations: { term: string; full: string; zh: string }[];
  collocations: { en: string; zh: string }[];
  examples: { en: string; zh: string }[];
  synonymNotes: { word: string; distinction: string }[];
  writingExamples: string[];
  memoryHook: string;
  spelling?: { isCorrect: boolean; suggestion: string; note: string };
  cachedAt?: string;
  raw?: { englishDefinition?: string };
}

export interface SpellCheckResult {
  checked: boolean;
  isCorrect: boolean;
  suggestion: string;
  source: 'offline' | 'llm' | 'rule' | 'none' | string;
  reason: string;
}

export interface ReviewSnapshot {
  state: 'new' | 'learning' | 'review' | 'relearning';
  step: number;
  dueAt: string | null;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  lastReviewAt: string | null;
}

export interface Word {
  id: string;
  text: string;
  lookupKey: string;
  kind: Kind;
  sourceDoc: string;
  sourceSentence: string;
  note: string;
  tags: string[];
  lookupCount: number;
  lastLookupAt: string | null;
  firstSeenAt: string;
  createdAt: string;
  updatedAt: string;
  rev: number;
  spellingDismissed: boolean;
  definitions: Record<string, DefinitionCard>;
  definition: DefinitionCard | null;
  review: ReviewSnapshot | null;
  preview?: Record<string, string>;
}

export interface ReviewLog {
  id: string;
  word_id: string;
  rating: number;
  prev_state: string;
  next_state: string;
  next_interval_days: number;
  reviewed_at: string;
  day: string;
}

export interface AppConfig {
  publicUrl: string;
  lookup: { defaultProvider: string; chain: string[]; cacheDays: number };
  srs: {
    algorithm: string;
    learningSteps: number[];
    graduatingInterval: number;
    easyInterval: number;
    relearnSteps: number[];
    minEase: number;
    maxIntervalDays: number;
    newPerDay: number;
    reviewsPerDay: number;
    flagLookupCount: number;
  };
  tts: { engine: string; accent: string; baseUrl: string; cache: boolean };
  providers: {
    llm: { enabled: boolean; baseUrl: string; model: string; hasKey: boolean; apiKeyMasked: string };
    dict: {
      enabled: boolean;
      engine: string;
      youdao: { hasKeys: boolean; appKeyMasked: string };
      baidu: { hasKeys: boolean; appIdMasked: string };
      freedict: { baseUrl: string };
    };
    offline: {
      enabled: boolean;
      dbPath: string;
      status: { installed: boolean; path: string; entries?: number; sizeBytes?: number };
    };
  };
  audio: { files: number; bytes: number };
}

export interface QueueStats {
  dueTotal: number;
  newTotal: number;
  newAllowance: number;
  reviewAllowance: number;
  reviewsToday: number;
  newDoneToday: number;
}

export interface Stats {
  totalWords: number;
  byState: { new: number; learning: number; review: number };
  dueNow: number;
  reviewsToday: number;
  addedToday: number;
  streak: number;
  history: { day: string; reviews: number; again: number }[];
  tags: { tag: string; count: number }[];
  flagged: Word[];
  audio: { files: number; bytes: number };
  providers: { llm: boolean; dict: boolean; offline: boolean };
  availableProviders: string[];
}

export interface LookupResult {
  ok: boolean;
  provider?: string;
  card?: DefinitionCard;
  cached?: boolean;
  attempts?: { provider: string; error: string }[];
  error?: string;
}
