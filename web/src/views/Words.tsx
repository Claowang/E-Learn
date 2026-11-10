import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  DefinitionView,
  IconRefresh,
  IconSearch,
  IconTrash,
  Modal,
  PronounceButton,
  Spinner,
  SpellingBanner
} from '../components';
import type { AppConfig, Word } from '../types';
import { dueLabel, formatDate, providerLabel, providerOptions, splitTags, stateLabel } from '../util';

const STATE_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'new', label: '新词' },
  { value: 'learning', label: '学习中' },
  { value: 'review', label: '复习中' }
];

/** Session cache so opening the same legacy entry twice doesn't re-run the check. */
const legacySpellCache = new Map<string, { suggestion: string; reason: string } | null>();

export function Words({
  config,
  notify,
  refreshKey
}: {
  config: AppConfig | null;
  notify: (text: string, kind?: 'ok' | 'error' | 'info') => void;
  refreshKey: number;
}) {
  const [items, setItems] = useState<Word[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('all');
  const [sort, setSort] = useState('created');
  const [tag, setTag] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Word | null>(null);
  const [detailLogs, setDetailLogs] = useState<{ reviewed_at: string; rating: number }[]>([]);
  const [activeProvider, setActiveProvider] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [legacySpell, setLegacySpell] = useState<{ suggestion: string; reason: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [relookupBusy, setRelookupBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.listWords({ search, sort, tag, limit: 300 });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      notify(err instanceof Error ? err.message : '加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [search, sort, tag, notify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const visible = useMemo(
    () =>
      stateFilter === 'all'
        ? items
        : items.filter((item) => {
            const state = item.review?.state || 'new';
            if (stateFilter === 'learning') return state === 'learning' || state === 'relearning';
            return state === stateFilter;
          }),
    [items, stateFilter]
  );

  const tags = useMemo(() => {
    const counter = new Map<string, number>();
    for (const item of items) {
      for (const value of item.tags || []) counter.set(value, (counter.get(value) || 0) + 1);
    }
    return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [items]);

  async function openDetail(word: Word) {
    setSelected(word);
    setActiveProvider(word.definition?.provider || '');
    setNoteDraft(word.note || '');
    setTagDraft((word.tags || []).join(', '));
    setTextDraft(word.text);
    setDetailLogs([]);
    setLegacySpell(null);
    try {
      const detail = await api.getWord(word.id);
      setSelected({ ...detail.item, preview: detail.preview });
      setDetailLogs(detail.logs.map((log) => ({ reviewed_at: log.reviewed_at, rating: log.rating })));
      // Entries looked up before the spelling feature have no spelling field yet.
      const item = detail.item;
      if (item.kind === 'word' && item.definition && !item.definition.spelling && !item.spellingDismissed) {
        const key = item.text.toLowerCase();
        let hint = legacySpellCache.get(key);
        if (hint === undefined) {
          const check = await api.spellcheck(item.text).catch(() => null);
          hint =
            check && check.checked && !check.isCorrect && check.suggestion
              ? { suggestion: check.suggestion, reason: check.reason || '' }
              : null;
          legacySpellCache.set(key, hint);
        }
        setLegacySpell(hint);
      }
    } catch {
      /* keep the list version if the detail call fails */
    }
  }

  async function removeWord(word: Word) {
    if (!confirm(`删除「${word.text}」？这个词的复习进度也会一并删除。`)) return;
    try {
      await api.deleteWord(word.id);
      notify(`已删除「${word.text}」`, 'ok');
      if (selected?.id === word.id) setSelected(null);
      void load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败', 'error');
    }
  }

  /** Replace the stored spelling and re-run the lookup on the corrected word. */
  async function renameWord(next: string) {
    if (!selected) return;
    const value = next.trim();
    if (!value || value === selected.text) return;
    setRenaming(true);
    try {
      const patched = await api.patchWord(selected.id, { text: value, spellingDismissed: false });
      const wordId = patched.item.id;
      const result = await api.lookup({
        text: value,
        wordId,
        provider: 'auto',
        force: true,
        sourceDoc: selected.sourceDoc,
        sourceSentence: selected.sourceSentence
      });
      const detail = await api.getWord(wordId);
      setSelected({ ...detail.item, preview: detail.preview });
      setTextDraft(detail.item.text);
      setLegacySpell(null);
      setActiveProvider(result.ok ? result.provider || '' : '');
      setDetailLogs(detail.logs.map((log) => ({ reviewed_at: log.reviewed_at, rating: log.rating })));
      notify(
        patched.merged
          ? `该词已合并到已有的「${value}」`
          : result.ok
            ? `已改为「${value}」`
            : `已改为「${value}」，但没有查到释义`,
        result.ok ? 'ok' : 'error'
      );
      void load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '修改拼写失败', 'error');
    } finally {
      setRenaming(false);
    }
  }

  async function reloadDefinition(provider: string) {
    if (!selected) return;
    setRelookupBusy(true);
    try {
      const result = await api.lookup({
        text: selected.text,
        wordId: selected.id,
        provider,
        force: true,
        sourceDoc: selected.sourceDoc,
        sourceSentence: selected.sourceSentence
      });
      if (!result.ok) {
        notify(result.error || '重新查询失败', 'error');
        return;
      }
      const detail = await api.getWord(selected.id);
      setSelected({ ...detail.item, preview: detail.preview });
      setLegacySpell(null);
      setActiveProvider(result.provider || provider);
      notify(`已用${providerLabel(result.provider || provider)}更新释义`, 'ok');
      void load();
    } catch (err) {
      notify(err instanceof Error ? err.message : '查询失败', 'error');
    } finally {
      setRelookupBusy(false);
    }
  }

  const card = selected
    ? activeProvider && selected.definitions?.[activeProvider]
      ? selected.definitions[activeProvider]
      : selected.definition
    : null;

  return (
    <div className="container">
      <div className="card stack">
        <div className="row between">
          <h1>词库</h1>
          <span className="chip">{loading ? '加载中' : `${visible.length} / ${total} 条`}</span>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <div className="grow" style={{ position: 'relative' }}>
            <IconSearch className="searchicon" />
            <input
              className="input"
              style={{ paddingLeft: 34 }}
              value={search}
              placeholder="搜索单词、原句、来源文档或笔记"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select className="select" style={{ width: 'auto' }} value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="created">最新</option>
            <option value="alpha">字母</option>
            <option value="lookups">查得最多</option>
          </select>
        </div>

        <div className="scroll-x">
          <div className="seg">
            {STATE_FILTERS.map((option) => (
              <button
                key={option.value}
                className={stateFilter === option.value ? 'active' : ''}
                onClick={() => setStateFilter(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {tags.map(([value, count]) => (
            <button
              key={value}
              className={`chip ${tag === value ? 'accent' : ''}`}
              onClick={() => setTag(tag === value ? '' : value)}
            >
              {value} <span className="faint">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {loading && items.length === 0 && (
        <div className="card center muted">
          <Spinner /> 正在加载词库
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div className="card empty">
          {total === 0 ? '词库还是空的，去「收录」页面添加第一个生词吧。' : '没有符合筛选条件的词条。'}
        </div>
      )}

      <div className="stack tight">
        {visible.map((word) => (
          <div
            key={word.id}
            className="wordrow"
            role="button"
            tabIndex={0}
            onClick={() => void openDetail(word)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void openDetail(word);
              }
            }}
          >
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <PronounceButton text={word.text} accent={config?.tts.accent || 'us'} />
            </div>
            <div className="meta grow">
              <div className="t">
                <span>{word.text}</span>
                {word.kind !== 'word' && <span className="chip tiny">{word.kind === 'phrase' ? '短语' : '整句'}</span>}
                {word.definition?.spelling?.isCorrect === false && !word.spellingDismissed && (
                  <span className="chip warn tiny">拼写?</span>
                )}
                {word.lookupCount >= (config?.srs.flagLookupCount || 3) && (
                  <span className="chip warn tiny">查了 {word.lookupCount} 次</span>
                )}
              </div>
              <div className="d">
                {word.definition?.translation || word.definition?.senses?.[0]?.meaning || (
                  <span className="faint">还没有释义</span>
                )}
              </div>
            </div>
            <div className="right">
              <span className={`chip ${word.review?.dueAt && new Date(word.review.dueAt) <= new Date() ? 'accent' : ''}`}>
                {dueLabel(word.review)}
              </span>
              <span className="tiny faint">{formatDate(word.createdAt)}</span>
            </div>
            <button
              className="iconbtn danger"
              title="删除这个词条"
              aria-label={`删除 ${word.text}`}
              onClick={(event) => {
                event.stopPropagation();
                void removeWord(word);
              }}
            >
              <IconTrash />
            </button>
          </div>
        ))}
      </div>

      <Modal open={!!selected} title={selected?.text || ''} onClose={() => setSelected(null)}>
        {selected && (
          <div className="stack">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="chip">{stateLabel(selected.review?.state)}</span>
              <span className="chip">查询 {selected.lookupCount} 次</span>
              <span className="chip">收录 {formatDate(selected.createdAt, true)}</span>
              {selected.review?.intervalDays ? (
                <span className="chip">间隔 {Math.round(selected.review.intervalDays)} 天</span>
              ) : null}
              {selected.review?.lapses ? <span className="chip warn">忘记 {selected.review.lapses} 次</span> : null}
            </div>

            {(() => {
              const detected = card?.spelling
                ? card.spelling.isCorrect === false && card.spelling.suggestion
                  ? { suggestion: card.spelling.suggestion, reason: card.spelling.note }
                  : null
                : legacySpell;
              if (!detected || selected.spellingDismissed) return null;
              return (
                <SpellingBanner
                  suggestion={detected.suggestion}
                  reason={detected.reason}
                  busy={renaming}
                  onReplace={() => void renameWord(detected.suggestion)}
                  onKeep={() => {
                    api
                      .patchWord(selected.id, { spellingDismissed: true })
                      .then((patched) => {
                        setSelected(patched.item);
                        setLegacySpell(null);
                        legacySpellCache.delete(selected.text.toLowerCase());
                        notify('已保留原拼写，不再提示');
                      })
                      .catch((err) => notify(err instanceof Error ? err.message : '操作失败', 'error'));
                  }}
                />
              );
            })()}

            {(selected.sourceDoc || selected.sourceSentence) && (
              <div className="card flat tight stack tight">
                {selected.sourceDoc && <div className="small muted">来源：{selected.sourceDoc}</div>}
                {selected.sourceSentence && <div className="small">{selected.sourceSentence}</div>}
              </div>
            )}

            {card ? (
              <DefinitionView
                word={selected}
                card={card}
                accent={config?.tts.accent || 'us'}
                onNotify={notify}
                providerSwitcher={
                  <div className="scroll-x">
                    {Object.entries(selected.definitions || {})
                      .filter(([key]) => key !== card.provider)
                      .map(([key]) => (
                        <button key={key} className="chip" onClick={() => setActiveProvider(key)}>
                          {providerLabel(key)}
                        </button>
                      ))}
                    {relookupBusy && <Spinner />}
                  </div>
                }
              />
            ) : (
              <div className="banner">这个词条还没有释义，可以用下面的按钮查一次。</div>
            )}

            <div className="divider" />

            <div>
              <label className="label">拼写（改完会自动用新拼写重新查询）</label>
              <div className="row" style={{ gap: 8 }}>
                <input
                  className="input mono"
                  value={textDraft}
                  onChange={(event) => setTextDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void renameWord(textDraft);
                  }}
                />
                <button
                  className="btn sm"
                  disabled={renaming || !textDraft.trim() || textDraft.trim() === selected.text}
                  onClick={() => void renameWord(textDraft)}
                >
                  {renaming ? <Spinner /> : null}
                  保存
                </button>
              </div>
            </div>

            <div>
              <label className="label">笔记（自己的理解、踩过的坑）</label>
              <textarea className="textarea" rows={2} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} />
            </div>
            <div>
              <label className="label">标签</label>
              <input className="input" value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} />
            </div>

            <div className="row wrap" style={{ gap: 8 }}>
              <button
                className="btn primary"
                onClick={async () => {
                  await api.patchWord(selected.id, { note: noteDraft, tags: splitTags(tagDraft) });
                  notify('已保存', 'ok');
                  setSelected(null);
                  void load();
                }}
              >
                保存修改
              </button>
              <select
                className="select"
                style={{ width: 'auto' }}
                value=""
                onChange={(event) => {
                  if (event.target.value) void reloadDefinition(event.target.value);
                }}
              >
                <option value="">用其它来源重新查询…</option>
                {providerOptions(config).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button className="btn ghost" onClick={() => void reloadDefinition(activeProvider || 'auto')}>
                <IconRefresh /> 刷新释义
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  if (!confirm(`删除「${selected.text}」？`)) return;
                  await api.deleteWord(selected.id);
                  notify('已删除', 'ok');
                  setSelected(null);
                  void load();
                }}
              >
                <IconTrash /> 删除
              </button>
            </div>

            {detailLogs.length > 0 && (
              <details>
                <summary>复习记录（最近 {detailLogs.length} 次）</summary>
                <div className="stack tight" style={{ marginTop: 8 }}>
                  {detailLogs.map((log, index) => (
                    <div className="kv" key={index}>
                      <span className="k">{formatDate(log.reviewed_at, true)}</span>
                      <span>{['', '重来', '困难', '良好', '容易'][log.rating]}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
