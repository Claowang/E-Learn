import { useCallback, useEffect, useState } from 'react';
import { api, flushPendingReviews, getToken, pendingReviews, setToken } from './api';
import {
  IconChart,
  IconList,
  IconPlus,
  IconReview,
  IconSettings,
  Toasts
} from './components';
import type { AppConfig, QueueStats } from './types';
import { Capture } from './views/Capture';
import { Login } from './views/Login';
import { Review } from './views/Review';
import { Settings } from './views/Settings';
import { Stats } from './views/Stats';
import { Words } from './views/Words';

type Tab = 'capture' | 'words' | 'review' | 'stats' | 'settings';

const TABS: { key: Tab; label: string; icon: typeof IconPlus }[] = [
  { key: 'capture', label: '收录', icon: IconPlus },
  { key: 'review', label: '复习', icon: IconReview },
  { key: 'words', label: '词库', icon: IconList },
  { key: 'stats', label: '统计', icon: IconChart },
  { key: 'settings', label: '设置', icon: IconSettings }
];

function readHash(): Tab {
  const value = window.location.hash.replace(/^#\/?/, '');
  return (TABS.find((tab) => tab.key === value)?.key || 'capture') as Tab;
}

export default function App() {
  const [token, setTokenState] = useState(getToken());
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tab, setTab] = useState<Tab>(readHash);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: 'ok' | 'error' | 'info' }[]>([]);
  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingCount, setPendingCount] = useState(() => pendingReviews().length);

  const notify = useCallback((text: string, kind: 'ok' | 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev.slice(-2), { id, text, kind }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((item) => item.id !== id)), 3200);
  }, []);

  const bump = useCallback(() => setRefreshKey((value) => value + 1), []);

  const refreshQueue = useCallback(async () => {
    try {
      const response = await api.reviewQueue(1, false);
      setQueue(response.stats);
    } catch {
      /* offline or logged out */
    }
  }, []);

  // --- session --------------------------------------------------------------

  useEffect(() => {
    const onUnauthorized = () => {
      setTokenState('');
      notify('登录已过期，请重新登录', 'error');
    };
    window.addEventListener('el:unauthorized', onUnauthorized);
    return () => window.removeEventListener('el:unauthorized', onUnauthorized);
  }, [notify]);

  useEffect(() => {
    if (!token) {
      setConfig(null);
      return;
    }
    let cancelled = false;
    api
      .getConfig()
      .then((loaded) => {
        if (!cancelled) setConfig(loaded);
      })
      .catch((err) => {
        if (!cancelled) notify(err instanceof Error ? err.message : '加载设置失败', 'error');
      });
    void refreshQueue();
    return () => {
      cancelled = true;
    };
  }, [token, notify, refreshQueue]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (token) void refreshQueue();
    }, 120000);
    return () => window.clearInterval(interval);
  }, [token, refreshQueue]);

  // --- routing --------------------------------------------------------------

  useEffect(() => {
    const onHash = () => setTab(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (next: Tab) => {
    setTab(next);
    if (window.location.hash !== `#/${next}`) window.location.hash = `#/${next}`;
  };

  // --- connectivity ---------------------------------------------------------

  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      void flushPendingReviews().then((sent) => {
        setPendingCount(pendingReviews().length);
        if (sent > 0) {
          notify(`已补传 ${sent} 条离线复习记录`, 'ok');
          bump();
        }
      });
    };
    const onOffline = () => setOnline(false);
    const onQueue = (event: Event) => {
      const detail = (event as CustomEvent<number>).detail;
      setPendingCount(typeof detail === 'number' ? detail : pendingReviews().length);
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('el:queue', onQueue);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('el:queue', onQueue);
    };
  }, [notify, bump]);

  if (!token) {
    return (
      <>
        <Login
          notify={notify}
          onDone={() => {
            setTokenState(getToken());
            bump();
          }}
        />
        <Toasts items={toasts} />
      </>
    );
  }

  const badge = (queue?.dueTotal || 0) + (queue?.newAllowance || 0);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icons/icon.svg" alt="" />
          <div>
            <strong>技术英语生词本</strong>
            <div className="tiny faint">间隔重复 · 多设备同步</div>
          </div>
        </div>
        {TABS.map((item) => (
          <button key={item.key} className={`navitem ${tab === item.key ? 'active' : ''}`} onClick={() => go(item.key)}>
            <item.icon />
            {item.label}
            {item.key === 'review' && badge > 0 && <span className="count">{badge}</span>}
          </button>
        ))}
        <div className="grow" />
        <div className="tiny faint" style={{ padding: '0 10px' }}>
          {online ? '在线' : '离线'}
          {pendingCount > 0 && ` · ${pendingCount} 条待上传`}
        </div>
      </aside>

      <main className="main">
        {!online && <div className="banner" style={{ marginBottom: 12 }}>当前离线，复习结果会暂存在本机。</div>}
        {pendingCount > 0 && (
          <div className="banner" style={{ marginBottom: 12 }}>
            有 {pendingCount} 条离线复习记录待上传
            <button
              className="btn sm"
              onClick={async () => {
                const sent = await flushPendingReviews();
                setPendingCount(pendingReviews().length);
                notify(sent ? `已补传 ${sent} 条` : '还是没能上传，稍后再试', sent ? 'ok' : 'error');
                bump();
              }}
            >
              立即上传
            </button>
          </div>
        )}

        {tab === 'capture' && <Capture config={config} notify={notify} onSaved={bump} />}
        {tab === 'review' && (
          <Review
            config={config}
            notify={notify}
            online={online}
            onProgress={() => {
              void refreshQueue();
              bump();
            }}
          />
        )}
        {tab === 'words' && <Words config={config} notify={notify} refreshKey={refreshKey} />}
        {tab === 'stats' && <Stats notify={notify} refreshKey={refreshKey} />}
        {tab === 'settings' && (
          <Settings
            config={config}
            notify={notify}
            onConfigChange={(updated) => {
              setConfig(updated);
              bump();
            }}
            onLogout={() => {
              setToken(null);
              setTokenState('');
              notify('已退出登录');
            }}
          />
        )}
      </main>

      <nav className="bottomnav">
        {TABS.map((item) => (
          <button key={item.key} className={`navbtn ${tab === item.key ? 'active' : ''}`} onClick={() => go(item.key)}>
            <item.icon />
            <span>{item.label}</span>
            {item.key === 'review' && badge > 0 && <span className="dot">{badge > 99 ? '99+' : badge}</span>}
          </button>
        ))}
      </nav>

      <Toasts items={toasts} />
    </div>
  );
}
