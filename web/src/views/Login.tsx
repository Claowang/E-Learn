import { useState } from 'react';
import { api, getApiBase, setApiBase, setToken } from '../api';
import { Spinner } from '../components';

export function Login({ onDone, notify }: { onDone: () => void; notify: (text: string, kind?: 'ok' | 'error' | 'info') => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showApi, setShowApi] = useState(false);
  const [apiBase, setApiBaseValue] = useState(getApiBase());

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!password.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.login(password.trim());
      setToken(result.token);
      notify('登录成功', 'ok');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centerbox">
      <form className="loginbox card stack" onSubmit={submit}>
        <div className="brand" style={{ paddingBottom: 0 }}>
          <img src="/icons/icon.svg" alt="" />
          <strong>技术英语生词本</strong>
        </div>
        <p className="small muted">
          输入服务端密码登录。密码在首次启动服务端时打印在控制台里，也可以用
          <code className="inline">npm run set-password</code> 重置。
        </p>
        <div>
          <label className="label" htmlFor="pw">
            密码
          </label>
          <input
            id="pw"
            className="input big"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="登录密码"
          />
        </div>
        {error && <div className="err">{error}</div>}
        <button className="btn primary block lg" type="submit" disabled={busy || !password.trim()}>
          {busy ? <Spinner /> : null}
          登录
        </button>

        <details open={showApi} onToggle={(event) => setShowApi((event.target as HTMLDetailsElement).open)}>
          <summary>服务器地址（默认同源，网页和 API 不在同一个地址时才需要改）</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="input"
              value={apiBase}
              placeholder="例如 http://192.168.1.10:8787"
              onChange={(event) => setApiBaseValue(event.target.value)}
            />
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                setApiBase(apiBase.trim());
                notify('服务器地址已保存', 'ok');
              }}
            >
              保存
            </button>
          </div>
        </details>
      </form>
    </div>
  );
}
