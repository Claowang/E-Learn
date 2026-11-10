import { useEffect, useState, type ReactNode } from 'react';
import type { DefinitionCard } from './types';
import { copyText, pronounce, providerLabel } from './util';

// --- icons ------------------------------------------------------------------

type IconProps = { className?: string };
const svg = (path: ReactNode, extra: Record<string, unknown> = {}) =>
  function Icon({ className }: IconProps) {
    return (
      <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...extra}
      >
        {path}
      </svg>
    );
  };

export const IconPlus = svg(<path d="M12 5v14M5 12h14" />);
export const IconList = svg(<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />);
export const IconReview = svg(
  <>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
  </>
);
export const IconChart = svg(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />);
export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.7-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21.4 11a2 2 0 1 1 0 4z" />
  </>
);
export const IconVolume = svg(
  <>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
  </>
);
export const IconSearch = svg(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>
);
export const IconTrash = svg(<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6" />);
export const IconRefresh = svg(
  <>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 3v6h-6" />
  </>
);
export const IconClose = svg(<path d="M6 6l12 12M18 6 6 18" />);
export const IconCopy = svg(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h8" />
  </>
);
export const IconBook = svg(
  <>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
  </>
);
export const IconPencil = svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />);
export const IconDownload = svg(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />);
export const IconCheck = svg(<path d="M20 6 9 17l-5-5" />);
export const IconChevron = svg(<path d="m9 18 6-6-6-6" />);

// --- small pieces -----------------------------------------------------------

export function Spinner({ className }: IconProps) {
  return <span className={`spin ${className || ''}`} />;
}

export function PronounceButton({
  text,
  accent,
  label,
  onResult
}: {
  text: string;
  accent: string;
  label?: string;
  onResult?: (how: 'server' | 'browser' | 'failed') => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="iconbtn"
      title={`播放发音（${accent === 'uk' ? '英音' : '美音'}）`}
      aria-label="播放发音"
      onClick={async (event) => {
        event.stopPropagation();
        setBusy(true);
        const how = await pronounce(text, accent);
        setBusy(false);
        onResult?.(how);
      }}
    >
      {busy ? <Spinner /> : label ? <span className="small">{label}</span> : <IconVolume />}
    </button>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <h2>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="关闭">
            <IconClose />
          </button>
        </div>
        {children}
        {footer && <div style={{ marginTop: 14 }}>{footer}</div>}
      </div>
    </div>
  );
}

export function Toasts({ items }: { items: { id: number; text: string; kind: 'ok' | 'error' | 'info' }[] }) {
  return (
    <div className="toasts">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.kind === 'info' ? '' : item.kind}`}>
          {item.text}
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, onCopied }: { text: string; onCopied?: (ok: boolean) => void }) {
  return (
    <button
      type="button"
      className="iconbtn"
      title="复制"
      onClick={async (event) => {
        event.stopPropagation();
        onCopied?.(await copyText(text));
      }}
    >
      <IconCopy />
    </button>
  );
}

/**
 * Shown when the lookup suspects a typo. The user decides: switch to the suggested
 * spelling (keeping review progress) or keep the original on purpose.
 */
export function SpellingBanner({
  suggestion,
  reason,
  onReplace,
  onKeep,
  busy
}: {
  suggestion: string;
  reason?: string;
  onReplace: () => void;
  onKeep: () => void;
  busy?: boolean;
}) {
  return (
    <div className="spellbox">
      <div className="grow">
        <strong style={{ color: 'var(--warn)' }}>疑似拼写错误</strong>
        <div className="small muted" style={{ marginTop: 2 }}>
          建议改为 <span className="sugg">{suggestion}</span>
          {reason ? ` · ${reason}` : ''}
        </div>
      </div>
      <div className="row" style={{ gap: 8, flex: '0 0 auto' }}>
        <button className="btn primary sm" disabled={busy} onClick={onReplace}>
          {busy ? <Spinner /> : null}
          改用 {suggestion}
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={onKeep}>
          保留原文
        </button>
      </div>
    </div>
  );
}

// --- definition -------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

export function DefinitionView({
  word,
  card,
  accent,
  onNotify,
  providerSwitcher
}: {
  word: { text: string; definitions?: Record<string, DefinitionCard> };
  card: DefinitionCard;
  accent: string;
  onNotify?: (text: string, kind?: 'ok' | 'error' | 'info') => void;
  providerSwitcher?: ReactNode;
}) {
  const has = {
    senses: card.senses?.length > 0,
    abbr: card.abbreviations?.length > 0,
    collocations: card.collocations?.length > 0,
    examples: card.examples?.length > 0,
    synonyms: card.synonymNotes?.length > 0,
    writing: card.writingExamples?.length > 0
  };

  return (
    <div className="stack">
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="chip accent">{providerLabel(card.provider)}</span>
        {providerSwitcher}
      </div>

      {card.translation && <div className="translation">{card.translation}</div>}

      {(card.phonetics?.us || card.phonetics?.uk) && (
        <div className="phon">
          {card.phonetics.uk && (
            <span className="row" style={{ gap: 6 }}>
              <span className="ip">{card.phonetics.uk}</span>
              <PronounceButton text={word.text} accent="uk" />
              <span className="tiny faint">英</span>
            </span>
          )}
          {card.phonetics.us && (
            <span className="row" style={{ gap: 6 }}>
              <span className="ip">{card.phonetics.us}</span>
              <PronounceButton text={word.text} accent="us" />
              <span className="tiny faint">美</span>
            </span>
          )}
        </div>
      )}

      {has.senses && (
        <Section title="释义">
          {card.senses.map((sense, index) => (
            <div className="sense" key={`${sense.pos}-${index}`}>
              {sense.pos && <span className="pos">{sense.pos.replace(/\.$/, '')}.</span>}
              <span>
                {sense.meaning}
                {sense.note && <div className="note">{sense.note}</div>}
              </span>
            </div>
          ))}
        </Section>
      )}

      {card.domainNote && (
        <div className="notebox">
          <strong className="kw">技术语境　</strong>
          {card.domainNote}
        </div>
      )}

      {has.abbr && (
        <Section title="缩写">
          {card.abbreviations.map((item, index) => (
            <div className="listline" key={`${item.term}-${index}`}>
              <span className="k mono">{item.term}</span>
              <span>
                {item.full}
                {item.zh && <span className="muted">（{item.zh}）</span>}
              </span>
            </div>
          ))}
        </Section>
      )}

      {has.collocations && (
        <Section title="常见搭配">
          <div className="scroll-x" style={{ flexWrap: 'wrap' }}>
            {card.collocations.map((item, index) => (
              <span className="chip" key={index} title={item.zh}>
                <span className="mono">{item.en}</span>
                {item.zh && <span className="faint">{item.zh}</span>}
              </span>
            ))}
          </div>
        </Section>
      )}

      {has.examples && (
        <Section title="例句">
          {card.examples.map((item, index) => (
            <div className="ex" key={index}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <div className="grow">
                  <div className="en">{item.en}</div>
                  {item.zh && <div className="zh">{item.zh}</div>}
                </div>
                <PronounceButton text={item.en} accent={accent} />
              </div>
            </div>
          ))}
        </Section>
      )}

      {has.synonyms && (
        <Section title="易混辨析">
          {card.synonymNotes.map((item, index) => (
            <div className="listline" key={index}>
              <span className="k mono">{item.word}</span>
              <span>{item.distinction}</span>
            </div>
          ))}
        </Section>
      )}

      {has.writing && (
        <Section title="可以直接用的句子">
          {card.writingExamples.map((sentence, index) => (
            <div className="ex" key={index}>
              <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
                <div className="grow en">{sentence}</div>
                <CopyButton
                  text={sentence}
                  onCopied={(ok) => onNotify?.(ok ? '已复制' : '复制失败', ok ? 'ok' : 'error')}
                />
              </div>
            </div>
          ))}
        </Section>
      )}

      {card.memoryHook && (
        <div className="notebox purple">
          <strong style={{ color: 'var(--purple)' }}>记忆　</strong>
          {card.memoryHook}
        </div>
      )}

      {card.raw?.englishDefinition && (
        <details>
          <summary>英文原义</summary>
          <p className="small muted" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
            {card.raw.englishDefinition}
          </p>
        </details>
      )}
    </div>
  );
}

