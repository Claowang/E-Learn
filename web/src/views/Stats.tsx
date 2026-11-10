import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Spinner } from '../components';
import type { Stats as StatsData } from '../types';
import { bytesLabel, dueLabel, formatDate } from '../util';

function lastNDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const pad = (value: number) => String(value).padStart(2, '0');
    out.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`);
  }
  return out;
}

export function Stats({
  notify,
  refreshKey
}: {
  notify: (text: string, kind?: 'ok' | 'error' | 'info') => void;
  refreshKey: number;
}) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.stats());
    } catch (err) {
      notify(err instanceof Error ? err.message : '加载统计失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (loading && !data) {
    return (
      <div className="container">
        <div className="card center muted">
          <Spinner /> 正在统计
        </div>
      </div>
    );
  }
  if (!data) return null;

  const days = lastNDays(30);
  const byDay = new Map(data.history.map((row) => [row.day, row]));
  const max = Math.max(1, ...data.history.map((row) => row.reviews));

  return (
    <div className="container">
      <div className="card stack">
        <div className="row between">
          <h1>学习统计</h1>
          <button className="btn ghost sm" onClick={() => void load()}>
            刷新
          </button>
        </div>
        <div className="kpi">
          <div className="cell">
            <div className="n">{data.totalWords}</div>
            <div className="tiny muted">收录词条</div>
          </div>
          <div className="cell">
            <div className="n" style={{ color: data.dueNow ? 'var(--accent)' : undefined }}>
              {data.dueNow}
            </div>
            <div className="tiny muted">待复习</div>
          </div>
          <div className="cell">
            <div className="n">{data.reviewsToday}</div>
            <div className="tiny muted">今日复习</div>
          </div>
          <div className="cell">
            <div className="n" style={{ color: data.streak ? 'var(--ok)' : undefined }}>
              {data.streak}
            </div>
            <div className="tiny muted">连续天数</div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip">新词 {data.byState.new}</span>
          <span className="chip">学习中 {data.byState.learning}</span>
          <span className="chip ok">复习中 {data.byState.review}</span>
          <span className="chip">今日新增 {data.addedToday}</span>
        </div>
      </div>

      <div className="card stack">
        <h2>最近 30 天复习量</h2>
        <div className="bars">
          {days.map((day) => {
            const row = byDay.get(day);
            const reviews = row?.reviews || 0;
            const again = row?.again || 0;
            return (
              <div className="col" key={day} title={`${day}：${reviews} 张，其中重来 ${again} 张`}>
                {reviews === 0 ? (
                  <div className="empty" />
                ) : (
                  <>
                    <div
                      className="b"
                      style={{
                        height: `${Math.max((reviews / max) * 100 - (again / reviews) * 100, 4)}%`
                      }}
                    />
                    {again > 0 && (
                      <div className="b again" style={{ height: `${(again / reviews) * 100}%` }} />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="row between tiny faint">
          <span>{days[0]}</span>
          <span>蓝色＝记住，红色＝重来</span>
          <span>{days[days.length - 1]}</span>
        </div>
      </div>

      <div className="card stack">
        <h2>查了很多次还没记住</h2>
        {data.flagged.length === 0 ? (
          <p className="small muted">暂时没有。同一个词查到 {`${3}`} 次以上就会出现在这里。</p>
        ) : (
          <div className="stack tight">
            {data.flagged.map((word) => (
              <div className="kv" key={word.id}>
                <span className="k">
                  <strong style={{ color: 'var(--text)' }}>{word.text}</strong>{' '}
                  {word.definition?.translation && (
                    <span className="muted small">· {word.definition.translation}</span>
                  )}
                </span>
                <span className="chip warn">{word.lookupCount} 次</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {data.tags.length > 0 && (
        <div className="card stack">
          <h2>标签分布</h2>
          <div className="row wrap" style={{ gap: 6 }}>
            {data.tags.map((item) => (
              <span className="chip" key={item.tag}>
                {item.tag} <span className="faint">{item.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card stack">
        <h2>运行状态</h2>
        <div className="kv">
          <span className="k">大模型释义</span>
          <span className={data.providers.llm ? 'chip ok' : 'chip warn'}>
            {data.providers.llm ? '已配置' : '未配置'}
          </span>
        </div>
        <div className="kv">
          <span className="k">在线词典</span>
          <span className={data.providers.dict ? 'chip ok' : 'chip'}>
            {data.providers.dict ? '已启用' : '未启用'}
          </span>
        </div>
        <div className="kv">
          <span className="k">离线词库</span>
          <span className={data.providers.offline ? 'chip ok' : 'chip'}>
            {data.providers.offline ? '已安装' : '未安装'}
          </span>
        </div>
        <div className="kv">
          <span className="k">发音缓存</span>
          <span className="muted">
            {data.audio.files} 个文件 · {bytesLabel(data.audio.bytes)}
          </span>
        </div>
        {data.flagged[0] && (
          <div className="tiny faint">最近需要重点关注的词：{dueLabel(data.flagged[0].review)}</div>
        )}
        <div className="tiny faint">统计时间 {formatDate(new Date().toISOString(), true)}</div>
      </div>
    </div>
  );
}
