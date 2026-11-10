import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, enqueueReview } from '../api';
import { DefinitionView, PronounceButton, Spinner } from '../components';
import type { AppConfig, QueueStats, Word } from '../types';
import { formatDate } from '../util';

const RATING_KEYS = ['1', '2', '3', '4'];
const RATING_LABELS = ['重来', '困难', '良好', '容易'];

export function Review({
  config,
  notify,
  onProgress,
  online
}: {
  config: AppConfig | null;
  notify: (text: string, kind?: 'ok' | 'error' | 'info') => void;
  onProgress: () => void;
  online: boolean;
}) {
  const [items, setItems] = useState<Word[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [includeNew, setIncludeNew] = useState(true);
  const [session, setSession] = useState({ count: 0, again: 0, startedAt: Date.now() });
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());

  const current = items[index] || null;

  const load = useCallback(
    async (withNew = includeNew) => {
      setLoading(true);
      try {
        const response = await api.reviewQueue(40, withNew);
        setItems(response.items);
        setStats(response.stats);
        setIndex(0);
        setRevealed(false);
        shownAt.current = Date.now();
      } catch (err) {
        notify(err instanceof Error ? err.message : '加载复习队列失败', 'error');
      } finally {
        setLoading(false);
      }
    },
    [includeNew, notify]
  );

  useEffect(() => {
    void load(includeNew);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeNew]);

  const rate = useCallback(
    async (rating: number) => {
      if (!current || busy) return;
      setBusy(true);
      const durationMs = Date.now() - shownAt.current;
      try {
        await api.submitReview(current.id, rating, durationMs);
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) {
          enqueueReview({ wordId: current.id, rating, durationMs, queuedAt: new Date().toISOString() });
          notify('当前离线，复习结果已暂存本地', 'info');
        } else {
          notify(err instanceof Error ? err.message : '提交失败', 'error');
        }
      }
      setSession((prev) => ({
        count: prev.count + 1,
        again: prev.again + (rating === 1 ? 1 : 0),
        startedAt: prev.startedAt
      }));
      setRevealed(false);
      shownAt.current = Date.now();
      setIndex((prev) => prev + 1);
      setBusy(false);
      onProgress();
    },
    [current, busy, notify, onProgress]
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!current) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        event.preventDefault();
        setRevealed(true);
        return;
      }
      if (revealed && RATING_KEYS.includes(event.key)) {
        event.preventDefault();
        void rate(Number(event.key));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, revealed, rate]);

  const finished = !loading && index >= items.length;

  if (loading) {
    return (
      <div className="container">
        <div className="card center muted">
          <Spinner /> 正在准备复习队列
        </div>
      </div>
    );
  }

  if (items.length === 0 || (finished && session.count === 0)) {
    return (
      <div className="container">
        <div className="card stack center" style={{ padding: 30 }}>
          <h1>现在没有要复习的词</h1>
          <p className="muted small">
            {stats && stats.newTotal > 0
              ? `词库里还有 ${stats.newTotal} 个新词可以开始学。`
              : '词库里的词都排在未来的复习计划里了，去收录几个新词吧。'}
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
            {stats && stats.newTotal > 0 && !includeNew && (
              <button className="btn primary" onClick={() => setIncludeNew(true)}>
                学习新词
              </button>
            )}
            <button className="btn ghost" onClick={() => void load(includeNew)}>
              刷新队列
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="container">
        <div className="card stack center" style={{ padding: 30 }}>
          <h1>这一轮复习完成 🎉</h1>
          <p className="muted small">
            本次复习 {session.count} 张，其中「重来」{session.again} 张，用时约{' '}
            {Math.max(1, Math.round((Date.now() - session.startedAt) / 60000))} 分钟。
          </p>
          <div className="row" style={{ justifyContent: 'center', gap: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                setSession({ count: 0, again: 0, startedAt: Date.now() });
                void load(includeNew);
              }}
            >
              再来一轮
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card stack tight">
        <div className="row between">
          <span className="small muted">
            第 {index + 1} / {items.length} 张 · 待复习 {stats?.dueTotal ?? 0} · 新词剩余{' '}
            {stats?.newAllowance ?? 0}
          </span>
          <label className="row small muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={includeNew} onChange={(event) => setIncludeNew(event.target.checked)} />
            含新词
          </label>
        </div>
        <div className="progress">
          <div style={{ width: `${(index / Math.max(1, items.length)) * 100}%` }} />
        </div>
      </div>

      {!online && <div className="banner">当前离线，复习结果会先存在本地，联网后自动上传。</div>}

      <div className="card reviewcard">
        {!revealed ? (
          <div className="reviewfront">
            <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
              <span className="bigword">{current?.text}</span>
              {current && <PronounceButton text={current.text} accent={config?.tts.accent || 'us'} />}
            </div>
            {current?.sourceDoc && <div className="small faint">来源：{current.sourceDoc}</div>}
            {current?.sourceSentence && (
              <div className="small muted" style={{ maxWidth: 560 }}>
                {current.sourceSentence}
              </div>
            )}
            {current?.tags?.length ? (
              <div className="scroll-x" style={{ justifyContent: 'center' }}>
                {current.tags.map((tag) => (
                  <span className="chip" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            ) : null}
            <button className="btn primary lg" onClick={() => setRevealed(true)}>
              显示答案（空格）
            </button>
            {current?.review?.lastReviewAt && (
              <div className="tiny faint">
                上次复习 {formatDate(current.review.lastReviewAt, true)} · 已复习 {current.review.reps} 次
              </div>
            )}
          </div>
        ) : (
          <div className="stack">
            <div className="row between wrap">
              <div className="row" style={{ gap: 10 }}>
                <span className="word">{current?.text}</span>
                {current && <PronounceButton text={current.text} accent={config?.tts.accent || 'us'} />}
              </div>
              {current?.review?.state === 'new' && <span className="chip">新词</span>}
            </div>
            {current?.definition ? (
              <DefinitionView
                word={current}
                card={current.definition}
                accent={config?.tts.accent || 'us'}
                onNotify={notify}
              />
            ) : (
              <div className="banner">这个词条还没有释义，先在「词库」里补一次查询。</div>
            )}
            {current?.note && (
              <div className="notebox">
                <strong className="kw">我的笔记　</strong>
                {current.note}
              </div>
            )}
          </div>
        )}
      </div>

      {revealed && (
        <div className="ratings">
          {RATING_LABELS.map((label, position) => {
            const rating = position + 1;
            return (
              <button
                key={rating}
                className={`rating r${rating}`}
                disabled={busy}
                onClick={() => void rate(rating)}
              >
                <span className="k">{label}</span>
                <span className="v">{current?.preview?.[String(rating)] || `${rating}`}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="center tiny faint">键盘 1 / 2 / 3 / 4 可以直接评分，空格显示答案</div>
    </div>
  );
}
