import { useEffect, useState, type ReactNode } from 'react';
import { api, getApiBase, setApiBase } from '../api';
import { Spinner } from '../components';
import type { AppConfig } from '../types';
import { bytesLabel, pronounce } from '../util';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <div className="tiny faint" style={{ marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="card stack">
      <div className="row between">
        <h2>{title}</h2>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Settings({
  config,
  notify,
  onConfigChange,
  onLogout
}: {
  config: AppConfig | null;
  notify: (text: string, kind?: 'ok' | 'error' | 'info') => void;
  onConfigChange: (config: AppConfig) => void;
  onLogout: () => void;
}) {
  const [form, setForm] = useState(() => buildForm(config));
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [testing, setTesting] = useState('');
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');

  useEffect(() => {
    setForm(buildForm(config));
  }, [config]);

  const set = <K extends keyof ReturnType<typeof buildForm>>(key: K, value: ReturnType<typeof buildForm>[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      const providers: Record<string, unknown> = {
        llm: {
          enabled: form.llmEnabled,
          baseUrl: form.llmBaseUrl.trim(),
          model: form.llmModel.trim()
        },
        dict: {
          enabled: form.dictEnabled,
          engine: form.dictEngine,
          youdao: { appKey: form.youdaoAppKey, appSecret: form.youdaoSecret },
          baidu: { appId: form.baiduAppId, secretKey: form.baiduSecret }
        },
        offline: { enabled: form.offlineEnabled, dbPath: form.offlineDbPath.trim() }
      };
      if (form.llmKey.trim()) (providers.llm as Record<string, unknown>).apiKey = form.llmKey.trim();
      if (!form.youdaoAppKey && !form.youdaoSecret) {
        delete (providers.dict as Record<string, Record<string, unknown>>).youdao;
      }
      if (!form.baiduAppId && !form.baiduSecret) {
        delete (providers.dict as Record<string, Record<string, unknown>>).baidu;
      }

      const updated = await api.updateConfig({
        lookup: {
          defaultProvider: form.defaultProvider,
          chain: form.chain
            .split(/[,，\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
        },
        srs: {
          newPerDay: Number(form.newPerDay) || 0,
          reviewsPerDay: Number(form.reviewsPerDay) || 0,
          learningSteps: form.learningSteps
            .split(/[,，\s]+/)
            .map((item) => Number(item))
            .filter((item) => Number.isFinite(item) && item > 0),
          easyInterval: Number(form.easyInterval) || 4,
          flagLookupCount: Number(form.flagLookupCount) || 3
        },
        tts: { engine: form.ttsEngine, accent: form.ttsAccent },
        providers
      });
      onConfigChange(updated);
      setForm({ ...form, llmKey: '', youdaoAppKey: '', youdaoSecret: '', baiduAppId: '', baiduSecret: '' });
      notify('设置已保存', 'ok');
    } catch (err) {
      notify(err instanceof Error ? err.message : '保存失败', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function test(kind: 'llm' | 'dict' | 'offline' | 'tts') {
    setTesting(kind);
    setTestResult('');
    try {
      if (kind === 'tts') {
        const how = await pronounce('datasheet', form.ttsAccent);
        setTestResult(
          how === 'server'
            ? '已播放服务器抓取的真人发音'
            : how === 'browser'
              ? '服务器发音不可用，已用浏览器内置语音'
              : '发音失败：服务器和浏览器都没能发声'
        );
        return;
      }
      const result = await api.lookup({ text: 'register', provider: kind, force: true });
      setTestResult(
        result.ok
          ? `成功：${result.card?.provider} → ${result.card?.translation || '(无中文释义)'}`
          : `失败：${result.attempts?.map((a) => `${a.provider}: ${a.error}`).join('；') || result.error}`
      );
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : '测试失败');
    } finally {
      setTesting('');
    }
  }

  async function exportAll() {
    try {
      const data = await api.syncPull(0);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `vocab-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      notify(`已导出 ${data.items.length} 个词条`, 'ok');
    } catch (err) {
      notify(err instanceof Error ? err.message : '导出失败', 'error');
    }
  }

  return (
    <div className="container">
      <div className="row between">
        <h1>设置</h1>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? <Spinner /> : null}
          保存设置
        </button>
      </div>

      <Section
        title="释义来源"
        right={
          <select
            className="select"
            style={{ width: 'auto' }}
            value={form.defaultProvider}
            onChange={(event) => set('defaultProvider', event.target.value)}
          >
            <option value="auto">自动</option>
            <option value="llm">大模型</option>
            <option value="dict">在线词典</option>
            <option value="offline">离线词库</option>
          </select>
        }
      >
        <p className="small muted">
          三种来源可以同时启用。「自动」按下面的顺序依次尝试，第一个给出结果的来源胜出；
          每个词条会保留所有来源的释义，随时在详情里切换。
        </p>
        <Field label="自动模式的尝试顺序" hint="用逗号分隔，可选 llm / dict / offline">
          <input className="input mono" value={form.chain} onChange={(event) => set('chain', event.target.value)} />
        </Field>
      </Section>

      <Section
        title="大模型（默认）"
        right={
          <label className="row small muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={form.llmEnabled} onChange={(event) => set('llmEnabled', event.target.checked)} />
            启用
          </label>
        }
      >
        <div className="grid2">
          <Field label="接口地址 Base URL" hint="任何 OpenAI 兼容接口都可以">
            <input className="input mono" value={form.llmBaseUrl} onChange={(event) => set('llmBaseUrl', event.target.value)} />
          </Field>
          <Field label="模型名">
            <input className="input mono" value={form.llmModel} onChange={(event) => set('llmModel', event.target.value)} />
          </Field>
        </div>
        <Field
          label="API Key"
          hint={
            config?.providers.llm.hasKey
              ? `已保存：${config.providers.llm.apiKeyMasked}，留空表示不修改`
              : '还没有配置。推荐 DeepSeek（便宜、中文好、国内直连）'
          }
        >
          <input
            className="input mono"
            type="password"
            value={form.llmKey}
            placeholder={config?.providers.llm.hasKey ? '留空保持不变' : 'sk-...'}
            onChange={(event) => set('llmKey', event.target.value)}
          />
        </Field>
        <div className="row wrap" style={{ gap: 8 }}>
          <button
            className="btn ghost sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={testing === 'llm'}
            onClick={() => void test('llm')}
          >
            {testing === 'llm' ? <Spinner /> : null} 测试大模型
          </button>
          <span className="tiny faint">
            需要先保存设置，测试才会用到新的 Key
          </span>
        </div>
      </Section>

      <Section
        title="在线词典"
        right={
          <label className="row small muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={form.dictEnabled} onChange={(event) => set('dictEnabled', event.target.checked)} />
            启用
          </label>
        }
      >
        <Field label="使用哪个词典服务">
          <select className="select" value={form.dictEngine} onChange={(event) => set('dictEngine', event.target.value)}>
            <option value="youdao">有道智云（需要 appKey / appSecret）</option>
            <option value="baidu">百度翻译开放平台（需要 appId / 密钥）</option>
            <option value="freedict">dictionaryapi.dev（免费无需 Key，只有英文释义）</option>
          </select>
        </Field>
        {form.dictEngine === 'youdao' && (
          <div className="grid2">
            <Field label="有道 App Key">
              <input className="input mono" value={form.youdaoAppKey} onChange={(event) => set('youdaoAppKey', event.target.value)} />
            </Field>
            <Field label="有道 App Secret">
              <input className="input mono" type="password" value={form.youdaoSecret} onChange={(event) => set('youdaoSecret', event.target.value)} />
            </Field>
          </div>
        )}
        {form.dictEngine === 'baidu' && (
          <div className="grid2">
            <Field label="百度 AppID">
              <input className="input mono" value={form.baiduAppId} onChange={(event) => set('baiduAppId', event.target.value)} />
            </Field>
            <Field label="百度密钥">
              <input className="input mono" type="password" value={form.baiduSecret} onChange={(event) => set('baiduSecret', event.target.value)} />
            </Field>
          </div>
        )}
        <div className="row wrap" style={{ gap: 8 }}>
          <button
            className="btn ghost sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={testing === 'dict'}
            onClick={() => void test('dict')}
          >
            {testing === 'dict' ? <Spinner /> : null} 测试在线词典
          </button>
        </div>
      </Section>

      <Section
        title="离线词库"
        right={
          <label className="row small muted" style={{ gap: 6 }}>
            <input type="checkbox" checked={form.offlineEnabled} onChange={(event) => set('offlineEnabled', event.target.checked)} />
            启用
          </label>
        }
      >
        <div className="row between">
          <span className="small">
            {config?.providers.offline.status.installed ? (
              <span className="chip ok">
                已安装 · {config.providers.offline.status.entries} 条 ·{' '}
                {bytesLabel(config.providers.offline.status.sizeBytes || 0)}
              </span>
            ) : (
              <span className="chip warn">未安装</span>
            )}
          </span>
          <button className="btn ghost sm" disabled={testing === 'offline'} onClick={() => void test('offline')}>
            {testing === 'offline' ? <Spinner /> : null} 测试离线查询
          </button>
        </div>
        <Field label="数据库文件名（放在 server/data/ 下）" hint="默认 ecdict.db">
          <input className="input mono" value={form.offlineDbPath} onChange={(event) => set('offlineDbPath', event.target.value)} />
        </Field>
        <details>
          <summary>怎么准备离线词库（无网络也能查）</summary>
          <div className="small muted stack" style={{ marginTop: 8 }}>
            <div>1. 到 GitHub 下载 ECDICT（skywind3000/ECDICT）的 stardict 数据库或 CSV 包。</div>
            <div>2. 把 stardict.db 改名为 ecdict.db 放进 server/data/ 目录；如果是 CSV，运行导入脚本生成数据库。</div>
            <div>
              3. 命令：<code className="inline">cd server &amp;&amp; node src/tools/import-ecdict.js ../ecdict.csv</code>
            </div>
            <div>ECDICT 约 340 万词条，涵盖技术词汇和词形变化，个人使用免费。</div>
          </div>
        </details>
      </Section>

      <Section title="发音">
        <div className="grid2">
          <Field label="发音来源">
            <select className="select" value={form.ttsEngine} onChange={(event) => set('ttsEngine', event.target.value)}>
              <option value="youdao">有道发音接口（免费，需联网）</option>
              <option value="none">关闭，只用浏览器内置语音</option>
            </select>
          </Field>
          <Field label="默认口音">
            <select className="select" value={form.ttsAccent} onChange={(event) => set('ttsAccent', event.target.value)}>
              <option value="us">美音</option>
              <option value="uk">英音</option>
            </select>
          </Field>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          <button
            className="btn ghost sm"
            style={{ alignSelf: 'flex-start' }}
            disabled={testing === 'tts'}
            onClick={() => void test('tts')}
          >
            {testing === 'tts' ? <Spinner /> : null} 试听 datasheet
          </button>
        </div>
      </Section>

      <Section title="复习计划">
        <div className="grid2">
          <Field label="每天新词上限">
            <input className="input" type="number" min={0} value={form.newPerDay} onChange={(event) => set('newPerDay', Number(event.target.value))} />
          </Field>
          <Field label="每天复习上限">
            <input className="input" type="number" min={0} value={form.reviewsPerDay} onChange={(event) => set('reviewsPerDay', Number(event.target.value))} />
          </Field>
          <Field label="学习间隔（分钟，逗号分隔）">
            <input className="input mono" value={form.learningSteps} onChange={(event) => set('learningSteps', event.target.value)} />
          </Field>
          <Field label="按「容易」时的首次间隔（天）">
            <input className="input" type="number" min={1} value={form.easyInterval} onChange={(event) => set('easyInterval', Number(event.target.value))} />
          </Field>
          <Field label="查询多少次后标记为没记住" hint="统计页会用这个阈值提醒你">
            <input className="input" type="number" min={2} value={form.flagLookupCount} onChange={(event) => set('flagLookupCount', Number(event.target.value))} />
          </Field>
        </div>
      </Section>

      <Section title="账号与地址">
        <Field label="修改密码" hint="新密码至少 6 位">
          <div className="row" style={{ gap: 8 }}>
            <input className="input" type="password" placeholder="当前密码" value={pwCurrent} onChange={(event) => setPwCurrent(event.target.value)} />
            <input className="input" type="password" placeholder="新密码" value={pwNew} onChange={(event) => setPwNew(event.target.value)} />
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.changePassword(pwCurrent, pwNew);
                  setPwCurrent('');
                  setPwNew('');
                  notify('密码已修改', 'ok');
                } catch (err) {
                  notify(err instanceof Error ? err.message : '修改失败', 'error');
                }
              }}
            >
              修改
            </button>
          </div>
        </Field>
        <Field label="服务器地址" hint="网页和 API 不在同一个地址时填写，例如 http://192.168.1.10:8787">
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input mono"
              defaultValue={getApiBase()}
              id="api-base-input"
              placeholder="留空表示与网页同源"
            />
            <button
              className="btn"
              onClick={() => {
                const value = (document.getElementById('api-base-input') as HTMLInputElement)?.value || '';
                setApiBase(value.trim());
                notify('地址已保存，刷新后生效', 'ok');
              }}
            >
              保存
            </button>
          </div>
        </Field>
      </Section>

      <Section title="数据">
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={() => void exportAll()}>
            导出全部词条（JSON）
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              try {
                const result = await api.clearAudio();
                notify(`已清理 ${result.removed} 个发音缓存文件`, 'ok');
              } catch (err) {
                notify(err instanceof Error ? err.message : '清理失败', 'error');
              }
            }}
          >
            清理发音缓存
          </button>
          <button className="btn ghost" onClick={() => void test('offline')}>
            自检离线词库
          </button>
          <button className="btn danger" onClick={onLogout}>
            退出登录
          </button>
        </div>
        {config?.audio && (
          <div className="tiny faint">
            发音缓存占用 {bytesLabel(config.audio.bytes)}（{config.audio.files} 个文件）
          </div>
        )}
      </Section>

      {testResult && (
        <div className="card">
          <div className="small">{testResult}</div>
        </div>
      )}
    </div>
  );
}

function buildForm(config: AppConfig | null) {
  return {
    defaultProvider: config?.lookup.defaultProvider || 'llm',
    chain: (config?.lookup.chain || ['llm', 'dict', 'offline']).join(', '),
    llmEnabled: config?.providers.llm.enabled ?? true,
    llmBaseUrl: config?.providers.llm.baseUrl || 'https://api.deepseek.com/v1',
    llmModel: config?.providers.llm.model || 'deepseek-chat',
    llmKey: '',
    dictEnabled: config?.providers.dict.enabled ?? false,
    dictEngine: config?.providers.dict.engine || 'youdao',
    youdaoAppKey: '',
    youdaoSecret: '',
    baiduAppId: '',
    baiduSecret: '',
    offlineEnabled: config?.providers.offline.enabled ?? true,
    offlineDbPath: config?.providers.offline.dbPath || 'ecdict.db',
    ttsEngine: config?.tts.engine || 'youdao',
    ttsAccent: config?.tts.accent || 'us',
    newPerDay: config?.srs.newPerDay ?? 20,
    reviewsPerDay: config?.srs.reviewsPerDay ?? 200,
    learningSteps: (config?.srs.learningSteps || [1, 10]).join(', '),
    easyInterval: config?.srs.easyInterval ?? 4,
    flagLookupCount: config?.srs.flagLookupCount ?? 3
  };
}
