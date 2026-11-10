import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { DefinitionView, IconPencil, IconTrash, Spinner, SpellingBanner } from '../components';
import type { AppConfig, LookupResult, Word } from '../types';
import { formatDate, providerOptions, providerLabel, splitTags } from '../util';

export function Capture({
  config,
  notify,
  onSaved,
  prefill
}: {
  config: AppConfig | null;
  notify: (text: string, kind?: 'ok' | 'error' | 'info') => void;
  onSaved: () => void;
  prefill?: string;
}) {
  const [text, setText] = useState(prefill || '');
  const [sourceDoc, setSourceDoc] = useState('');
  const [sourceSentence, setSourceSentence] = useState('');
  const [tagText, setTagText] = useState('');
  const [provider, setProvider] = useState(config?.lookup.defaultProvider || 'auto');
  const [showContext, setShowContext] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [saved, setSaved] = useState<Word | null>(null);
  const [activeProvider, setActiveProvider] = useState<string>('');
  const [spellHint, setSpellHint] = useState<{ suggestion: string; reason: string } | null>(null);
  const [fixing, setFixing] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      inputRef.current?.focus();
    }
  }, [prefill]);

  function considerSpelling(
    spelling: { isCorrect: boolean; suggestion: string; note: string } | undefined,
    dismissed: boolean
  ) {
    if (dismissed || !spelling || spelling.isCorrect || !spelling.suggestion) return;
    setSpellHint({ suggestion: spelling.suggestion, reason: spelling.note || '' });
  }

  async function suggestSpelling(value: string, dismissed = false) {
    if (dismissed) return;
    try {
      const check = await api.spellcheck(value);
      if (check.checked && !check.isCorrect && check.suggestion) {
        setSpellHint({ suggestion: check.suggestion, reason: check.reason || '' });
      }
    } catch {
      /* a failed spelling check must never block saving */
    }
  }

  async function save(lookup: boolean) {
    const value = text.trim();
    if (!value) {
      notify('先输入要收录的内容', 'error');
      return;
    }
    setBusy(true);
    setResult(null);
    setSaved(null);
    setSpellHint(null);
    try {
      if (!lookup) {
        const lookupResult = await api.lookup({ text: value, provider, sourceDoc, sourceSentence });
        setResult(lookupResult);
        setActiveProvider(lookupResult.provider || '');
        if (!lookupResult.ok) {
          notify('没有查到释义，看下面的原因', 'error');
          await suggestSpelling(value);
        } else {
          considerSpelling(lookupResult.card?.spelling, false);
        }
        return;
      }
      const response = await api.createWord({
        text: value,
        provider,
        sourceDoc,
        sourceSentence,
        tags: splitTags(tagText)
      });
      setSaved(response.item);
      setResult(response.lookup);
      setActiveProvider(response.lookup?.provider || '');
      if (response.lookup?.ok) {
        notify('已收录，并加入复习队列', 'ok');
        const spelling = response.item.definition?.spelling;
        if (spelling) {
          considerSpelling(spelling, response.item.spellingDismissed);
        } else {
          // Legacy cached card from before the spelling feature existed.
          await suggestSpelling(value, response.item.spellingDismissed);
        }
      } else {
        notify('已收录，但这次没查到释义', 'error');
        await suggestSpelling(value, response.item.spellingDismissed);
      }
      setText('');
      setSourceSentence('');
      setTagText('');
      onSaved();
      inputRef.current?.focus();
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function applySpellingFix() {
    if (!spellHint) return;
    const target = spellHint.suggestion;
    if (!saved) {
      setText(target);
      setResult(null);
      setSpellHint(null);
      notify(`已改为 ${target}，再点一次查词`, 'ok');
      return;
    }
    setFixing(true);
    try {
      const patched = await api.patchWord(saved.id, { text: target });
      const wordId = patched.item.id;
      const lookup = await api.lookup({
        text: target,
        wordId,
        provider,
        force: true,
        sourceDoc,
        sourceSentence
      });
      const detail = await api.getWord(wordId);
      setSaved({ ...detail.item, preview: detail.preview });
      setResult(lookup);
      setActiveProvider(lookup.ok ? lookup.provider || '' : '');
      setSpellHint(null);
      if (lookup.ok) {
        notify(patched.merged ? `已合并到已有的「${target}」` : `已改为「${target}」`, 'ok');
      } else {
        notify(`已改为「${target}」，但没有查到释义`, 'error');
      }
      onSaved();
    } catch (err) {
      notify(err instanceof Error ? err.message : '替换失败', 'error');
    } finally {
      setFixing(false);
    }
  }

  async function keepOriginalSpelling() {
    setSpellHint(null);
    if (!saved) return;
    try {
      const patched = await api.patchWord(saved.id, { spellingDismissed: true });
      setSaved(patched.item);
      notify('已保留原拼写，不再提示');
    } catch {
      /* keep the UI responsive even if the flag fails to save */
    }
  }

  const shownWord = saved || null;
  const shownCard = shownWord
    ? activeProvider && shownWord.definitions?.[activeProvider]
      ? shownWord.definitions[activeProvider]
      : shownWord.definition
    : result?.card || null;
  const alternatives = shownWord
    ? Object.entries(shownWord.definitions || {}).filter(([key]) => key !== shownCard?.provider)
    : [];

  return (
    <div className="container">
      <div className="card stack">
        <div className="row between">
          <h1>收录生词</h1>
          <span className="chip">{providerOptions(config).length - 2} 个可用来源</span>
        </div>

        <div>
          <label className="label" htmlFor="word-input">
            单词 / 短语 / 整句（Ctrl + Enter 直接查）
          </label>
          <textarea
            id="word-input"
            ref={inputRef}
            className="textarea"
            rows={2}
            value={text}
            placeholder="例如 register、power cycle、unless otherwise specified"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                event.preventDefault();
                void save(true);
              }
            }}
          />
        </div>

        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary" disabled={busy} onClick={() => void save(true)}>
            {busy ? <Spinner /> : null}
            查词并收录
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void save(false)}>
            只查一下
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              try {
                const clip = await navigator.clipboard.readText();
                if (clip) {
                  setText(clip.trim().slice(0, 500));
                  notify('已从剪贴板粘贴');
                }
              } catch {
                notify('浏览器不允许读取剪贴板，请手动粘贴', 'error');
              }
            }}
          >
            从剪贴板
          </button>
          <select className="select" style={{ width: 'auto' }} value={provider} onChange={(event) => setProvider(event.target.value)}>
            {providerOptions(config).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <details
          open={showContext}
          onToggle={(event) => setShowContext((event.target as HTMLDetailsElement).open)}
        >
          <summary>补充上下文（原句能让释义贴合你读到的实际含义）</summary>
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="grid2">
              <div>
                <label className="label" htmlFor="doc">
                  来源文档
                </label>
                <input
                  id="doc"
                  className="input"
                  value={sourceDoc}
                  placeholder="LM75 datasheet / Zephyr issue #123"
                  onChange={(event) => setSourceDoc(event.target.value)}
                />
              </div>
              <div>
                <label className="label" htmlFor="tags">
                  标签
                </label>
                <input
                  id="tags"
                  className="input"
                  value={tagText}
                  placeholder="I2C, 电源, RTOS"
                  onChange={(event) => setTagText(event.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="sentence">
                我遇到它的原句
              </label>
              <textarea
                id="sentence"
                className="textarea"
                rows={2}
                value={sourceSentence}
                placeholder="The output is asserted low when the temperature exceeds T_OS."
                onChange={(event) => setSourceSentence(event.target.value)}
              />
            </div>
          </div>
        </details>
      </div>

      {result && !result.ok && (
        <div className="card stack">
          <h3 className="err">没有查到释义</h3>
          <div className="small muted">
            {result.attempts?.map((attempt) => (
              <div key={attempt.provider}>
                · {providerLabel(attempt.provider)}：{attempt.error}
              </div>
            )) || result.error}
          </div>
          {!config?.providers.llm.hasKey && (
            <div className="banner">
              还没有配置大模型 API Key，去「设置」里填一个即可获得最好的解释效果。
            </div>
          )}
        </div>
      )}

      {spellHint && (
        <SpellingBanner
          suggestion={spellHint.suggestion}
          reason={spellHint.reason}
          busy={fixing}
          onReplace={() => void applySpellingFix()}
          onKeep={() => void keepOriginalSpelling()}
        />
      )}

      {shownCard && (
        <div className="card stack">
          <div className="row between wrap">
            <div>
              <div className="word small">{shownWord?.text || text.trim()}</div>
              {shownWord && (
                <div className="tiny faint">
                  收录于 {formatDate(shownWord.createdAt, true)}
                  {shownWord.review && ` · ${shownWord.lookupCount} 次查询`}
                </div>
              )}
            </div>
            {shownWord && (
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="iconbtn"
                  title="删除这个词条"
                  onClick={async () => {
                    if (!confirm(`删除「${shownWord.text}」？`)) return;
                    await api.deleteWord(shownWord.id);
                    setSaved(null);
                    setResult(null);
                    notify('已删除', 'ok');
                    onSaved();
                  }}
                >
                  <IconTrash />
                </button>
              </div>
            )}
          </div>
          {shownWord && (
            <DefinitionView
              word={shownWord}
              card={shownCard}
              accent={config?.tts.accent || 'us'}
              onNotify={notify}
              providerSwitcher={
                alternatives.length > 0 ? (
                  <div className="scroll-x">
                    <button
                      className={`chip ${!activeProvider || activeProvider === shownCard.provider ? 'accent' : ''}`}
                      onClick={() => setActiveProvider(shownCard.provider)}
                    >
                      {providerLabel(shownCard.provider)}
                    </button>
                    {alternatives.map(([key]) => (
                      <button key={key} className="chip" onClick={() => setActiveProvider(key)}>
                        {providerLabel(key)}
                      </button>
                    ))}
                  </div>
                ) : undefined
              }
            />
          )}
          {!shownWord && <DefinitionView word={{ text: text.trim() }} card={shownCard} accent={config?.tts.accent || 'us'} onNotify={notify} />}
        </div>
      )}

      {!shownCard && !result && (
        <div className="card">
          <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
            <span className="iconbtn" style={{ pointerEvents: 'none' }}>
              <IconPencil />
            </span>
            <div className="small muted">
              查词会同时把词条和时间戳存进你的词库，并自动排进复习队列。填上「原句」效果最好——
              大模型会按你实际读到的语境来解释，而不是给通用词典释义。
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
