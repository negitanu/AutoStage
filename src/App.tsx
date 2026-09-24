import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FileCheck2,
  FlaskConical,
  Globe,
  History,
  Layers3,
  Loader2,
  Maximize2,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Type,
  X,
  XCircle,
  AlertCircle,
  WandSparkles,
  PanelLeftClose,
} from 'lucide-react';
import {
  labels,
  modelLabel,
  type CredentialStatus,
  type SettingsUpdate,
  stepTypes,
  type Scenario,
  type ScenarioInput,
  type Run,
  type Settings,
  type Health,
  type Step,
} from '../shared/schema';

type State = {
  scenarios: Scenario[];
  runs: Run[];
  settings: Settings;
  credentials: CredentialStatus;
};
type Modal =
  | { type: 'edit'; scenario?: Scenario; initial?: ScenarioInput }
  | { type: 'generate' }
  | { type: 'settings' }
  | { type: 'image'; url: string }
  | { type: 'delete'; scenario: Scenario }
  | null;
const statusLabels: Record<string, string> = {
  passed: '成功',
  failed: '失敗',
  running: '実行中',
  queued: '待機中',
  review: '要確認',
  cancelled: '停止',
  pending: '未実行',
  skipped: 'スキップ',
};
const icons = {
  navigate: Globe,
  click: MousePointer2,
  fill: Type,
  act: WandSparkles,
  assertText: FileCheck2,
  assertUrl: Globe,
  assertVisible: CheckCheck,
  semantic: Sparkles,
};
const duration = (ms?: number) => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)}s`);
const date = (iso: string) =>
  new Date(iso).toLocaleString('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const isActive = (run?: Run) => !!run && ['queued', 'running'].includes(run.status);
const scenarioEntryUrl = (scenario?: Scenario) => {
  if (!scenario) return window.location.origin;
  try {
    return new URL(
      scenario.steps.find((step) => step.type === 'navigate')?.target || '',
      scenario.baseUrl,
    ).href;
  } catch {
    return scenario.baseUrl;
  }
};
const connectionError = 'ローカルサーバーとの接続を確認しています。起動後に自動で再接続します。';
async function api<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => {
    throw new Error(connectionError);
  });
  if (!response.ok) throw new Error(data.error || 'リクエストに失敗しました');
  return data as T;
}
function StatusIcon({ status, size = 16 }: { status: string; size?: number }) {
  const Icon =
    status === 'passed'
      ? CheckCircle2
      : status === 'failed'
        ? XCircle
        : status === 'review'
          ? AlertCircle
          : status === 'running'
            ? Loader2
            : status === 'cancelled'
              ? Square
              : Circle;
  return (
    <Icon size={size} className={`status-icon ${status} ${status === 'running' ? 'spin' : ''}`} />
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${status}`}>
      <StatusIcon status={status} size={13} />
      {statusLabels[status]}
    </span>
  );
}
function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? 'dialog wide' : 'dialog'}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="閉じる" onClick={onClose}>
          <X size={19} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export default function App() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [runId, setRunId] = useState('');
  const [stepIndex, setStepIndex] = useState(0);
  const [view, setView] = useState<'workspace' | 'history'>('workspace');
  const [tab, setTab] = useState<'logs' | 'evidence'>('logs');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [health, setHealth] = useState<Health>();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [connected, setConnected] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const seq = ++refreshSequence.current;
    try {
      const data = await api<State>('/state');
      if (seq === refreshSequence.current) {
        setState(data);
        setError((previous) => (previous === connectionError ? '' : previous));
      }
    } catch {
      if (seq === refreshSequence.current) setError(connectionError);
    }
  }, []);
  const checkHealth = useCallback(async () => {
    try {
      setHealth(await api<Health>('/health'));
    } catch {
      setHealth(undefined);
    }
  }, []);
  useEffect(() => {
    void refresh();
    void checkHealth();
    const events = new EventSource('/api/events');
    events.addEventListener('refresh', () => {
      setConnected(true);
      void refresh();
    });
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    const timer = setInterval(() => {
      if (events.readyState !== EventSource.OPEN) void refresh();
    }, 5000);
    return () => {
      events.close();
      clearInterval(timer);
    };
  }, [refresh, checkHealth]);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 3500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const scenario =
    state?.scenarios.find((s) => s.id === selectedId) ||
    state?.runs.find((r) => r.id === runId)?.scenario ||
    state?.scenarios[0];
  const archived = !!scenario && !state?.scenarios.some((s) => s.id === scenario.id);
  const scenarioRuns = state?.runs.filter((r) => r.scenarioId === scenario?.id) || [];
  const run = scenarioRuns.find((r) => r.id === runId) || scenarioRuns[0];
  const displayScenario = run ? run.scenario : scenario;
  const activeForScenario = scenarioRuns.find(isActive);
  const step = displayScenario?.steps[Math.min(stepIndex, displayScenario.steps.length - 1)];
  const result = run?.results.find((r) => r.stepId === step?.id);
  const latestScreenshot = result?.screenshot;
  const finished =
    state?.runs.filter((r) => ['passed', 'failed', 'review'].includes(r.status)) || [];
  const passed = finished.filter((r) => r.status === 'passed').length;
  const totalDuration = run?.finishedAt
    ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    : undefined;
  const visibleScenarios =
    state?.scenarios.filter((s) =>
      `${s.name} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()),
    ) || [];
  const chooseScenario = (s: Scenario) => {
    setSelectedId(s.id);
    setRunId('');
    setStepIndex(0);
    setSidebar(false);
  };
  const chooseRun = (r: Run) => {
    setSelectedId(r.scenarioId);
    setRunId(r.id);
    setStepIndex(
      Math.max(
        0,
        r.results.findLastIndex((s) => s.screenshot),
      ),
    );
    setView('workspace');
  };
  const startRun = useCallback(async () => {
    if (!scenario || archived || busy || activeForScenario) return;
    setBusy(true);
    setError('');
    try {
      const next = await api<Run>('/runs', 'POST', { scenarioId: scenario.id });
      setRunId(next.id);
      setStepIndex(0);
      setView('workspace');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [scenario, archived, busy, activeForScenario, refresh]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !modal) {
        e.preventDefault();
        void startRun();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setModal({ type: 'settings' });
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [startRun, modal]);
  useEffect(() => {
    if (run && isActive(run)) {
      const idx = run.results.findIndex((r) => r.status === 'running');
      if (idx >= 0) setStepIndex(idx);
    }
  }, [run?.id, run?.results.filter((r) => r.status !== 'pending').length]);
  const mutate = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await refresh();
      setToast(message);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!state)
    return (
      <div className="boot">
        <div className="brandmark">A</div>
        <h1>AutoStage</h1>
        {error ? (
          <>
            <p>{error}</p>
            <button className="button" onClick={refresh}>
              再接続
            </button>
          </>
        ) : (
          <Loader2 className="spin" />
        )}
      </div>
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebar ? 'open' : ''}`}>
        <a className="brand" href="/" aria-label="AutoStage ホーム">
          <div className="brandmark">
            <Layers3 size={21} strokeWidth={2.5} />
          </div>
          <span>
            AutoStage<span className="brand-dot">.</span>
          </span>
          <span className="version">BETA</span>
        </a>
        <div className="workspace-picker">
          <div className="workspace-avatar">L</div>
          <div>
            <strong>Local workspace</strong>
            <span>このデバイス</span>
          </div>
          <span className="local-dot" title="ローカル実行" />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="main-nav">
          <button
            className={view === 'workspace' ? 'active' : ''}
            onClick={() => {
              setView('workspace');
              setSidebar(false);
            }}
          >
            <FlaskConical size={18} />
            テストシナリオ<span className="nav-count">{state.scenarios.length}</span>
          </button>
          <button
            className={view === 'history' ? 'active' : ''}
            onClick={() => {
              setView('history');
              setSidebar(false);
            }}
          >
            <History size={18} />
            実行履歴<span className="nav-count">{state.runs.length}</span>
          </button>
        </nav>
        <div className="sidebar-rule" />
        <div className="nav-label scenario-label">
          SCENARIOS
          <button
            className="icon-button"
            aria-label="シナリオを追加"
            onClick={() => setModal({ type: 'edit' })}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="sidebar-search">
          <Search size={14} />
          <input
            ref={searchRef}
            aria-label="シナリオ検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="シナリオを検索"
          />
          <kbd>⌘ K</kbd>
        </div>
        <div className="scenario-nav">
          {visibleScenarios.map((s) => {
            const last = state.runs.find((r) => r.scenarioId === s.id);
            return (
              <button
                key={s.id}
                className={scenario?.id === s.id && view === 'workspace' ? 'selected' : ''}
                onClick={() => {
                  chooseScenario(s);
                  setView('workspace');
                }}
              >
                <StatusIcon status={last?.status || 'pending'} size={15} />
                <span>{s.name}</span>
                {s.tags.includes('AI') && <Sparkles size={12} className="muted" />}
              </button>
            );
          })}
          {!visibleScenarios.length && <p className="search-empty">該当するシナリオはありません</p>}
        </div>
        <div className="sidebar-bottom">
          <div className="engine-card">
            <div className="engine-title">
              <span className="tiny-square" />
              AI ENGINES
              <ShieldCheck size={14} />
            </div>
            <div>
              <span>
                <Bot size={14} />
                {modelLabel(state.settings)}
              </span>
              <span
                className={`engine-dot ${health?.model.ok ? 'online' : 'offline'}`}
                title={health?.model.message || '確認中'}
              />
            </div>
            <div>
              <span>
                <Sparkles size={14} />
                Laya
              </span>
              <span
                className={`engine-dot ${health?.laya.ok ? 'online' : 'offline'}`}
                title={health?.laya.message || '確認中'}
              />
            </div>
            <button onClick={() => setModal({ type: 'settings' })}>
              接続を設定
              <ArrowUpRight size={13} />
            </button>
          </div>
          <button className="settings-nav" onClick={() => setModal({ type: 'settings' })}>
            <Settings2 size={17} />
            設定<span>⌘ ,</span>
          </button>
          <div className="sidebar-foot">
            <span>
              {state.settings.modelProvider === 'openrouter'
                ? 'OpenRouter + Local Laya'
                : '推論はローカルで実行'}
            </span>
            <ShieldCheck size={13} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="メニュー"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeftClose size={18} />
            </button>
            <Layers3 size={15} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{view === 'workspace' ? 'テストシナリオ' : '実行履歴'}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-chip">
              <span />
              {state.settings.modelProvider === 'openrouter' ? 'OpenRouter' : 'Local only'}
            </span>
            <span className="divider" />
            <a href="/demo/" target="_blank" rel="noreferrer">
              サンプルアプリ
              <ExternalLink size={13} />
            </a>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR REGRESSION WORKBENCH</div>
              <h1>
                {view === 'workspace' ? 'Test workspace' : 'Run history'}
                <span className="heading-dot" />
              </h1>
              <p>
                {view === 'workspace'
                  ? 'いつもの操作を、確かな品質に。'
                  : 'すべての実行と、その根拠をひとつの場所に。'}
              </p>
            </div>
            <div className="heading-actions">
              <button className="button secondary" onClick={() => setModal({ type: 'edit' })}>
                <Plus size={16} />
                新規シナリオ
              </button>
              <button className="button primary" onClick={() => setModal({ type: 'generate' })}>
                <WandSparkles size={16} />
                AI でシナリオ作成
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="エラーを閉じる"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!connected && (
            <div className="connection-banner">
              <Loader2 size={14} className="spin" />
              リアルタイム接続を復旧中です。5 秒ごとに更新します。
            </div>
          )}
          <div className="metrics">
            <div className="metric">
              <span>
                テストシナリオ
                <Layers3 size={15} />
              </span>
              <strong>
                {state.scenarios.length.toString().padStart(2, '0')}
                <small>scenarios</small>
              </strong>
            </div>
            <div className="metric">
              <span>
                累計成功率
                <Activity size={15} />
              </span>
              <strong className="mint">
                {finished.length ? Math.round((passed / finished.length) * 100) : '—'}
                <small>{finished.length ? '%' : 'まだ実行がありません'}</small>
              </strong>
            </div>
            <div className="metric">
              <span>
                要確認・失敗
                <AlertCircle size={15} />
              </span>
              <strong>
                {finished
                  .filter((r) => r.status !== 'passed')
                  .length.toString()
                  .padStart(2, '0')}
                <small>runs</small>
              </strong>
            </div>
            <div className="metric">
              <span>
                実行エンジン
                <Code2 size={15} />
              </span>
              <strong className="engine-name">
                Stagehand <span className="version-pill">v4</span>
                <small>LOCAL CHROME</small>
              </strong>
            </div>
          </div>
          {view === 'history' ? (
            <section className="history-panel">
              <div className="panel-heading">
                <h2>
                  すべての実行<span>{state.runs.length}</span>
                </h2>
                <button className="icon-button" aria-label="履歴を更新" onClick={refresh}>
                  <RefreshCw size={15} />
                </button>
              </div>
              {!state.runs.length ? (
                <div className="empty-state">
                  <History size={30} />
                  <h3>最初の実行を待っています</h3>
                  <p>シナリオを実行すると、結果とスクリーンショットが保存されます。</p>
                  <button className="button" onClick={() => setView('workspace')}>
                    ワークスペースへ
                    <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <div className="history-list">
                  <div className="history-row history-head">
                    <span>シナリオ / 実行 ID</span>
                    <span>結果</span>
                    <span>開始日時</span>
                    <span>所要時間</span>
                    <span />
                  </div>
                  {state.runs.map((r) => (
                    <button className="history-row" key={r.id} onClick={() => chooseRun(r)}>
                      <span>
                        <strong>{r.scenario.name}</strong>
                        <small className="mono">#{r.id.slice(0, 8)}</small>
                      </span>
                      <Badge status={r.status} />
                      <span>{date(r.startedAt)}</span>
                      <span className="mono">
                        {duration(
                          r.finishedAt
                            ? Date.parse(r.finishedAt) - Date.parse(r.startedAt)
                            : undefined,
                        )}
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : scenario && displayScenario ? (
            <>
              <section className="workbench">
                <div className="scenario-header">
                  <div className="scenario-heading">
                    <div className="scenario-symbol">
                      <FlaskConical size={22} />
                    </div>
                    <div>
                      <div className="scenario-title">
                        <h2>{scenario.name}</h2>
                        {scenario.tags.map((t) => (
                          <span key={t} className="tag">
                            {t}
                          </span>
                        ))}
                      </div>
                      <div className="scenario-meta">
                        <Globe size={12} />
                        <span>{scenario.baseUrl}</span>
                        <span className="meta-dot">·</span>
                        <span>{scenario.steps.length} steps</span>
                      </div>
                    </div>
                  </div>
                  <div className="scenario-actions">
                    <button
                      className="button ghost"
                      disabled={archived}
                      onClick={() => setModal({ type: 'edit', scenario })}
                    >
                      <Settings2 size={14} />
                      編集
                    </button>
                    {activeForScenario ? (
                      <button
                        className="button stop"
                        onClick={() =>
                          mutate(
                            () => api(`/runs/${activeForScenario.id}/cancel`, 'POST'),
                            '実行を停止しました',
                          )
                        }
                      >
                        <Square size={14} />
                        停止
                      </button>
                    ) : (
                      <button
                        className="button primary"
                        onClick={startRun}
                        disabled={busy || archived}
                      >
                        <Play size={14} fill="currentColor" />
                        {archived ? '削除済みシナリオ' : busy ? '開始中…' : 'テストを実行'}
                        <kbd>⌘ ↵</kbd>
                      </button>
                    )}
                  </div>
                </div>
                <div className="bench-toolbar">
                  <div className="bench-tabs">
                    <span className="bench-tab">
                      <Layers3 size={14} />
                      シナリオ
                    </span>
                    <span className="step-count">{displayScenario.steps.length} steps</span>
                  </div>
                  <div className="run-selector">
                    {run && <Badge status={run.status} />}
                    <select
                      aria-label="表示する実行"
                      value={run?.id || ''}
                      onChange={(e) => {
                        const r = scenarioRuns.find((r) => r.id === e.target.value);
                        if (r) chooseRun(r);
                      }}
                      disabled={!scenarioRuns.length}
                    >
                      {scenarioRuns.length ? (
                        scenarioRuns.map((r) => (
                          <option key={r.id} value={r.id}>
                            #{r.id.slice(0, 6)} · {date(r.startedAt)}
                          </option>
                        ))
                      ) : (
                        <option value="">未実行</option>
                      )}
                    </select>
                  </div>
                </div>
                <div className="bench-body">
                  <div className="steps-panel">
                    <div className="steps-caption">
                      <span>TEST STEPS</span>
                      <span>
                        {run
                          ? `${run.results.filter((s) => s.status === 'passed').length} / ${run.results.length} passed`
                          : 'READY TO RUN'}
                      </span>
                    </div>
                    <div className="steps-list">
                      {displayScenario.steps.map((s, i) => {
                        const sr = run?.results.find((r) => r.stepId === s.id);
                        const Icon = icons[s.type];
                        return (
                          <button
                            key={s.id}
                            className={`step-row ${i === stepIndex ? 'selected' : ''} ${sr?.status === 'running' ? 'executing' : ''}`}
                            onClick={() => setStepIndex(i)}
                          >
                            <div className="step-line" />
                            <div className={`step-number ${sr?.status || ''}`}>
                              {sr?.status === 'passed' ? (
                                <Check size={14} />
                              ) : sr?.status === 'failed' ? (
                                <X size={14} />
                              ) : sr?.status === 'running' ? (
                                <Loader2 size={14} className="spin" />
                              ) : (
                                String(i + 1).padStart(2, '0')
                              )}
                            </div>
                            <div className="step-copy">
                              <strong>{s.title}</strong>
                              <span>
                                <Icon size={12} />
                                {labels[s.type]}
                                {s.type === 'act' && <span className="ai-label">AI</span>}
                                {s.type === 'semantic' && <span className="ai-label">LAYA</span>}
                              </span>
                            </div>
                            <span className="step-time mono">{duration(sr?.durationMs)}</span>
                            <ChevronRight size={13} className="step-arrow" />
                          </button>
                        );
                      })}
                    </div>
                    <div className="step-bottom">
                      <ShieldCheck size={14} />
                      <span>実行ごとに独立したブラウザで検証</span>
                    </div>
                    <div className="scenario-tools">
                      <button
                        onClick={() =>
                          mutate(async () => {
                            const cloned = await api<Scenario>('/scenarios', 'POST', {
                              ...scenario,
                              name: `${scenario.name} のコピー`,
                            });
                            chooseScenario(cloned);
                          }, 'シナリオを複製しました')
                        }
                      >
                        <Copy size={13} />
                        複製
                      </button>
                      <button onClick={() => setModal({ type: 'delete', scenario })}>
                        <Trash2 size={13} />
                        削除
                      </button>
                    </div>
                  </div>
                  <div className="preview-panel">
                    <div className="preview-heading">
                      <div>
                        <Monitor size={15} />
                        <span>ブラウザプレビュー</span>
                      </div>
                      <div>
                        <span className="mono viewport">
                          {run?.settings.viewportWidth || state.settings.viewportWidth} ×{' '}
                          {run?.settings.viewportHeight || state.settings.viewportHeight}
                        </span>
                        <button
                          className="icon-button"
                          aria-label="スクリーンショットを拡大"
                          disabled={!latestScreenshot}
                          onClick={() =>
                            latestScreenshot && setModal({ type: 'image', url: latestScreenshot })
                          }
                        >
                          <Maximize2 size={14} />
                        </button>
                      </div>
                    </div>
                    <div className="browser-frame">
                      <div className="browser-bar">
                        <div className="traffic">
                          <i />
                          <i />
                          <i />
                        </div>
                        <div className="address">
                          <Globe size={10} />
                          {new URL(displayScenario.baseUrl).host}
                          <span>/</span>
                          {step?.type === 'navigate' ? step.target.replace(/^\//, '') : '…'}
                        </div>
                        <MoreHorizontal size={13} />
                      </div>
                      <div className={`browser-content ${latestScreenshot ? 'has-image' : ''}`}>
                        {latestScreenshot ? (
                          <button
                            className="screenshot-button"
                            onClick={() => setModal({ type: 'image', url: latestScreenshot })}
                          >
                            <img
                              src={latestScreenshot}
                              alt={`${step?.title} の実行後スクリーンショット`}
                            />
                          </button>
                        ) : (
                          <div className="preview-empty">
                            <div className="preview-orbit">
                              <Monitor size={30} />
                              <span>
                                <MousePointer2 size={15} />
                              </span>
                            </div>
                            <h3>
                              {isActive(run)
                                ? 'ブラウザで検証しています'
                                : '操作の結果を、ここで確認'}
                            </h3>
                            <p>
                              {isActive(run)
                                ? 'ステップ完了後にスクリーンショットが表示されます。'
                                : 'テストを実行すると、各ステップの画面を確認できます。'}
                            </p>
                            {!run && (
                              <button className="text-button" onClick={startRun}>
                                最初のテストを実行
                                <ArrowRight size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="capture-caption">
                        <span>
                          <span className={`capture-dot ${latestScreenshot ? 'captured' : ''}`} />
                          {latestScreenshot
                            ? `STEP ${String(stepIndex + 1).padStart(2, '0')} · キャプチャ済み`
                            : 'スクリーンショット待機中'}
                        </span>
                        <span>
                          {result?.startedAt
                            ? new Date(result.startedAt).toLocaleTimeString('ja-JP')
                            : '—'}
                        </span>
                      </div>
                    </div>
                    <div className="result-strip">
                      <div>
                        <StatusIcon status={result?.status || 'pending'} />
                        <strong>{result ? statusLabels[result.status] : '準備完了'}</strong>
                        <span>
                          {result?.durationMs !== undefined
                            ? duration(result.durationMs)
                            : 'ステップを選択して詳細を確認'}
                        </span>
                      </div>
                      {run && <span className="mono">#{run.id.slice(0, 6)}</span>}
                    </div>
                    <div className="details-panel">
                      <div className="detail-tabs">
                        <button
                          className={tab === 'logs' ? 'active' : ''}
                          onClick={() => setTab('logs')}
                        >
                          <Terminal size={13} />
                          実行ログ<span>{run?.logs.length || 0}</span>
                        </button>
                        <button
                          className={tab === 'evidence' ? 'active' : ''}
                          onClick={() => setTab('evidence')}
                        >
                          <FileCheck2 size={13} />
                          検証の詳細
                        </button>
                        {run && (
                          <a
                            href={`/api/runs/${run.id}/export`}
                            className="export-button"
                            aria-label="実行レポートを保存"
                          >
                            <Download size={14} />
                          </a>
                        )}
                      </div>
                      <div className="logs" role="log" aria-label="実行ログ">
                        {tab === 'logs' ? (
                          run?.logs.length ? (
                            run.logs.map((log, i) => (
                              <div className={`log-line ${log.level}`} key={i}>
                                <time>
                                  {new Date(log.time).toLocaleTimeString('ja-JP', {
                                    hour12: false,
                                  })}
                                </time>
                                <span className="log-level">
                                  {log.level === 'error' ? 'ERR' : 'INFO'}
                                </span>
                                <span>{log.message}</span>
                              </div>
                            ))
                          ) : (
                            <div className="log-placeholder">
                              <span className="prompt-symbol">❯</span>実行ログはここに表示されます
                              <span className="cursor-blink" />
                            </div>
                          )
                        ) : (
                          <div className="evidence">
                            <div>
                              <span>操作対象 / 指示</span>
                              <code>{step?.target}</code>
                            </div>
                            {step?.type === 'assertText' && (
                              <div>
                                <span>期待するテキスト</span>
                                <code>{step.value}</code>
                              </div>
                            )}
                            {result?.message && (
                              <div>
                                <span>結果</span>
                                <p className={result.status === 'failed' ? 'red' : ''}>
                                  {result.message}
                                </p>
                              </div>
                            )}
                            {result?.probability !== undefined && (
                              <div>
                                <span>Laya · 条件が真である確率</span>
                                <strong className="mint">
                                  {(result.probability * 100).toFixed(1)}%
                                </strong>
                                <p>
                                  成功 ≥ {(run!.settings.confidenceThreshold * 100).toFixed(0)}% /
                                  失敗 ≤{' '}
                                  {((1 - run!.settings.confidenceThreshold) * 100).toFixed(0)}% /
                                  中間は要確認
                                </p>
                              </div>
                            )}
                            {result?.evidence && (
                              <div>
                                <span>観測したテキスト</span>
                                <pre>{result.evidence}</pre>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <footer className="bench-footer">
                  <span>
                    <Clock3 size={13} />
                    {run
                      ? `所要時間 ${duration(totalDuration)}${isActive(run) ? ' · 実行中' : ''}`
                      : 'シナリオを実行する準備ができています'}
                  </span>
                  <span>
                    {run
                      ? `実行時のシナリオを表示 · ${date(run.startedAt)}`
                      : `更新 ${date(scenario.updatedAt)}`}
                  </span>
                </footer>
              </section>
              <div className="workbench-note">
                <span>
                  <Sparkles size={14} />
                  自然言語の操作は選択した生成モデル、意味の検証は Laya。
                </span>
                <button onClick={() => setModal({ type: 'settings' })}>
                  モデル設定
                  <ArrowUpRight size={13} />
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <FlaskConical size={32} />
              <h3>最初のシナリオを作成</h3>
              <p>検証したい URL と操作手順を登録してください。</p>
              <button className="button primary" onClick={() => setModal({ type: 'edit' })}>
                <Plus size={15} />
                シナリオを作成
              </button>
            </div>
          )}
          <footer className="page-footer">
            <span>
              AUTOSTAGE<span className="footer-dot">/</span>LOCAL FIRST. CONFIDENCE ALWAYS.
            </span>
            <span>Stagehand v4 + Laya</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
      {modal?.type === 'edit' && (
        <ScenarioEditor
          scenario={modal.scenario}
          initial={modal.initial}
          onClose={() => setModal(null)}
          onSave={async (input) => {
            const saved = await api<Scenario>(
              modal.scenario ? `/scenarios/${modal.scenario.id}` : '/scenarios',
              modal.scenario ? 'PUT' : 'POST',
              input,
            );
            await refresh();
            chooseScenario(saved);
            setModal(null);
            setToast('シナリオを保存しました');
          }}
        />
      )}
      {modal?.type === 'generate' && (
        <GenerateDialog
          initialUrl={scenarioEntryUrl(scenario)}
          modelName={modelLabel(state.settings)}
          cloud={state.settings.modelProvider === 'openrouter'}
          onClose={() => setModal(null)}
          onGenerated={(initial) => setModal({ type: 'edit', initial })}
        />
      )}
      {modal?.type === 'settings' && (
        <SettingsDialog
          settings={state.settings}
          credentials={state.credentials}
          health={health}
          checkHealth={checkHealth}
          onClose={() => setModal(null)}
          onSave={async (settings) => {
            await api('/settings', 'PUT', settings);
            await refresh();
            await checkHealth();
            setToast('設定を保存しました');
          }}
        />
      )}
      {modal?.type === 'image' && (
        <Dialog title="ステップのスクリーンショット" wide onClose={() => setModal(null)}>
          <div className="image-dialog">
            <img src={modal.url} alt="スクリーンショットの拡大表示" />
            <a className="button secondary" href={modal.url} download>
              画像を保存
              <Download size={15} />
            </a>
          </div>
        </Dialog>
      )}
      {modal?.type === 'delete' && (
        <Dialog title="シナリオを削除" onClose={() => setModal(null)}>
          <div className="dialog-body">
            <p>「{modal.scenario.name}」を削除します。実行履歴は保持されます。</p>
            <div className="dialog-actions">
              <button className="button secondary" onClick={() => setModal(null)}>
                キャンセル
              </button>
              <button
                className="button danger"
                onClick={() =>
                  mutate(async () => {
                    await api(`/scenarios/${modal.scenario.id}`, 'DELETE');
                    setModal(null);
                  }, 'シナリオを削除しました')
                }
              >
                削除する
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function GenerateDialog({
  initialUrl,
  modelName,
  cloud,
  onClose,
  onGenerated,
}: {
  initialUrl: string;
  modelName: string;
  cloud: boolean;
  onClose: () => void;
  onGenerated: (initial: ScenarioInput) => void;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog title="ページからシナリオを作成" onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setLoading(true);
          setError('');
          try {
            onGenerated(await api<ScenarioInput>('/scenarios/generate', 'POST', { url, prompt }));
          } catch (reason) {
            setError((reason as Error).message);
          } finally {
            setLoading(false);
          }
        }}
      >
        <div className="dialog-body generate-body">
          <div className="generate-intro">
            <div className="generate-icon">
              <WandSparkles size={22} />
            </div>
            <div>
              <strong>ページを見て、試験手順を提案</strong>
              <p>対象ページをブラウザで分析し、操作と検証の下書きを作ります。</p>
            </div>
          </div>
          <label>
            対象ページの URL
            <input
              type="url"
              required
              maxLength={2048}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/login"
            />
          </label>
          <label>
            行いたい試験
            <textarea
              required
              minLength={10}
              maxLength={4000}
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例: ログインフォームにメールアドレスとパスワードを入力し、ログイン後にダッシュボードが表示されることを確認する"
            />
          </label>
          <div className="generate-model">
            <Bot size={15} />
            <span>生成モデル</span>
            <strong>{modelName}</strong>
          </div>
          {cloud && (
            <p className="field-hint">
              ページの内容と試験指示を OpenRouter に送信します。API 利用料が発生する場合があります。
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <span>生成後に編集できます</span>
          <div>
            <button type="button" className="button secondary" onClick={onClose}>
              キャンセル
            </button>
            <button className="button primary" disabled={loading}>
              {loading ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
              {loading ? 'ページを分析中…' : 'シナリオを生成'}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}

function ScenarioEditor({
  scenario,
  initial,
  onClose,
  onSave,
}: {
  scenario?: Scenario;
  initial?: ScenarioInput;
  onClose: () => void;
  onSave: (input: ScenarioInput) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ScenarioInput>(
    scenario ||
      initial || {
        name: '',
        description: '',
        baseUrl: 'http://127.0.0.1:4310',
        tags: [],
        steps: [
          {
            id: crypto.randomUUID(),
            type: 'navigate',
            title: 'ページを開く',
            target: '/demo/',
            value: '',
          },
        ],
      },
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const updateStep = (index: number, patch: Partial<Step>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    }));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[from], steps[to]] = [steps[to], steps[from]];
    setDraft({ ...draft, steps });
  };
  return (
    <Dialog
      title={scenario ? 'シナリオを編集' : initial ? '生成されたシナリオを確認' : '新しいシナリオ'}
      wide
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError('');
          try {
            await onSave(draft);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="dialog-body editor-body">
          {initial && (
            <div className="provider-notice">
              <Sparkles size={17} />
              <p>
                ページの観測結果から作成した下書きです。操作対象と期待結果を確認してから保存してください。
              </p>
            </div>
          )}
          <div className="form-grid">
            <label>
              シナリオ名
              <input
                required
                maxLength={120}
                placeholder="例: 商品をカートに追加"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              ベース URL
              <input
                required
                type="url"
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </label>
          </div>
          <label>
            説明
            <input
              maxLength={500}
              placeholder="このテストで保証すること"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <div className="editor-section-title">
            <h3>操作と検証</h3>
            <span>{draft.steps.length} steps</span>
          </div>
          <div className="editor-steps">
            {draft.steps.map((step, i) => (
              <div className="editor-step" key={step.id}>
                <div className="editor-step-head">
                  <span className="mono">{String(i + 1).padStart(2, '0')}</span>
                  <select
                    aria-label={`ステップ ${i + 1} の種類`}
                    value={step.type}
                    onChange={(e) => {
                      const type = e.target.value as Step['type'];
                      updateStep(i, { type, title: labels[type], target: '', value: '' });
                    }}
                  >
                    {stepTypes.map((t) => (
                      <option key={t} value={t}>
                        {labels[t]}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`ステップ ${i + 1} の名前`}
                    required
                    value={step.title}
                    onChange={(e) => updateStep(i, { title: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    disabled={i === 0}
                    aria-label="上に移動"
                    onClick={() => move(i, i - 1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={i === draft.steps.length - 1}
                    aria-label="下に移動"
                    onClick={() => move(i, i + 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={draft.steps.length === 1}
                    aria-label="ステップを削除"
                    onClick={() =>
                      setDraft({ ...draft, steps: draft.steps.filter((s) => s.id !== step.id) })
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="editor-step-fields">
                  <label>
                    {step.type === 'act'
                      ? '自然言語の操作指示'
                      : step.type === 'semantic'
                        ? '期待する状態'
                        : ['navigate', 'assertUrl'].includes(step.type)
                          ? 'URL または相対パス'
                          : 'CSS セレクター'}
                    <input
                      required
                      value={step.target}
                      placeholder={
                        step.type === 'act'
                          ? '検索欄に「ワイヤレス」と入力する'
                          : step.type === 'semantic'
                            ? '検索結果にワイヤレス製品が表示されている'
                            : step.type === 'navigate'
                              ? '/login'
                              : '[data-testid="submit"]'
                      }
                      onChange={(e) => updateStep(i, { target: e.target.value })}
                    />
                  </label>
                  {['fill', 'assertText', 'semantic'].includes(step.type) && (
                    <label>
                      {step.type === 'fill'
                        ? '入力する値'
                        : step.type === 'assertText'
                          ? '含まれるべきテキスト'
                          : '判定対象の CSS セレクター（省略時 body）'}
                      <input
                        required={step.type === 'assertText'}
                        value={step.value}
                        onChange={(e) => updateStep(i, { value: e.target.value })}
                        placeholder={step.type === 'semantic' ? 'main' : ''}
                      />
                    </label>
                  )}
                </div>
                {step.type === 'semantic' && (
                  <p className="field-hint">
                    Laya の文脈長には上限があります。判定対象は必要な要素に絞ってください。
                  </p>
                )}
              </div>
            ))}
          </div>
          <button
            type="button"
            className="add-step"
            disabled={draft.steps.length >= 50}
            onClick={() =>
              setDraft({
                ...draft,
                steps: [
                  ...draft.steps,
                  {
                    id: crypto.randomUUID(),
                    type: 'click',
                    title: 'クリック',
                    target: '',
                    value: '',
                  },
                ],
              })
            }
          >
            <Plus size={15} />
            ステップを追加
          </button>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <span>変更は次の実行から適用されます</span>
          <div>
            <button type="button" className="button secondary" onClick={onClose}>
              キャンセル
            </button>
            <button className="button primary" disabled={saving}>
              <Save size={15} />
              {saving ? '保存中…' : 'シナリオを保存'}
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}

function SettingsDialog({
  settings,
  credentials,
  health,
  checkHealth,
  onClose,
  onSave,
}: {
  settings: Settings;
  credentials: CredentialStatus;
  health?: Health;
  checkHealth: () => Promise<void>;
  onClose: () => void;
  onSave: (s: SettingsUpdate) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const remote = draft.modelProvider === 'openrouter';
  const sameConnection =
    draft.modelProvider === settings.modelProvider &&
    modelLabel(draft) === modelLabel(settings) &&
    draft.modelBaseUrl === settings.modelBaseUrl &&
    !apiKey &&
    !clearKey;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog title="ワークスペース設定" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onSave({ ...draft, openRouterApiKey: apiKey, clearOpenRouterApiKey: clearKey });
            setApiKey('');
            setClearKey(false);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-body settings-body">
          <div className="settings-section">
            <div className="settings-section-head">
              <div>
                <Bot size={19} />
                <h3>生成モデル</h3>
              </div>
              <span
                className={`connection-status ${sameConnection && health?.model.ok ? 'mint' : ''}`}
              >
                {!sameConnection ? '未確認' : health?.model.ok ? '接続済み' : '未接続'}
              </span>
            </div>
            <p>Stagehand の自然言語操作に使うモデルを選択します。</p>
            <label>
              接続先
              <select
                value={draft.modelProvider}
                onChange={(e) =>
                  setDraft({ ...draft, modelProvider: e.target.value as Settings['modelProvider'] })
                }
              >
                <option value="local">ローカル · Ollama / LM Studio</option>
                <option value="openrouter">OpenRouter · Cloud API</option>
              </select>
            </label>
            {remote ? (
              <>
                <div className="provider-notice">
                  <Globe size={17} />
                  <p>
                    AI 操作時、ページの内容と操作指示を OpenRouter
                    経由でモデル提供者に送信します。API 利用料が発生します。ブラウザと Laya
                    の判定はローカルで実行します。
                  </p>
                </div>
                <label>
                  モデル ID
                  <input
                    required
                    list="remote-models"
                    value={draft.openRouterModel}
                    onChange={(e) => setDraft({ ...draft, openRouterModel: e.target.value })}
                    placeholder="openai/gpt-4o-mini"
                  />
                  <datalist id="remote-models">
                    {(settings.modelProvider === 'openrouter'
                      ? health?.model.models || []
                      : []
                    ).map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </datalist>
                </label>
                <p className="field-hint">
                  JSON Schema による構造化出力に対応するモデル ID を指定してください。
                </p>
                <label>
                  OpenRouter API キー
                  <input
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={apiKey}
                    disabled={credentials.openRouterKeySource === 'environment' || clearKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      credentials.openRouterKeySource === 'none'
                        ? 'sk-or-v1-…'
                        : '設定済み · 空欄で現在のキーを保持'
                    }
                  />
                </label>
                <p className="field-hint">
                  {credentials.openRouterKeySource === 'environment'
                    ? '環境変数 OPENROUTER_API_KEY を使用中。変更はサーバー側で行ってください。'
                    : credentials.openRouterKeySource === 'saved'
                      ? 'API キーはサーバーに保存済みです。履歴・レポートには含まれません。'
                      : 'API キーを入力して設定を保存してください。キーはサーバー側だけに保存します。'}
                </p>
                {credentials.openRouterKeySource === 'saved' && (
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(e) => {
                        setClearKey(e.target.checked);
                        setApiKey('');
                      }}
                    />
                    保存時に API キーを削除
                  </label>
                )}
                <div className="code-hint">
                  <ShieldCheck size={13} />
                  <code>openrouter.ai/api/v1</code>
                </div>
              </>
            ) : (
              <>
                <label>
                  API ベース URL
                  <input
                    type="url"
                    required
                    value={draft.modelBaseUrl}
                    onChange={(e) => setDraft({ ...draft, modelBaseUrl: e.target.value })}
                  />
                </label>
                <label>
                  モデル名
                  <input
                    required
                    list="models"
                    value={draft.modelName}
                    onChange={(e) => setDraft({ ...draft, modelName: e.target.value })}
                  />
                  <datalist id="models">
                    {[
                      ...new Set([
                        ...(settings.modelProvider === 'local' ? health?.model.models || [] : []),
                        'qwen3:8b',
                        'gemma3:12b',
                      ]),
                    ].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </datalist>
                </label>
                <div className="code-hint">
                  <Terminal size={13} />
                  <code>ollama pull {draft.modelName}</code>
                </div>
                <p className="field-hint">
                  Ollama: http://127.0.0.1:11434/v1 · LM Studio: http://127.0.0.1:1234/v1
                  <br />
                  モデルには JSON Schema による構造化出力が必要です。
                </p>
              </>
            )}
          </div>
          <div className="settings-section">
            <div className="settings-section-head">
              <div>
                <Sparkles size={18} />
                <h3>Laya 判定サービス</h3>
              </div>
              <span className={`connection-status ${health?.laya.ok ? 'mint' : ''}`}>
                {health?.laya.ok ? '接続済み' : '未接続'}
              </span>
            </div>
            <label>
              サービス URL
              <input
                required
                type="url"
                value={draft.layaBaseUrl}
                onChange={(e) => setDraft({ ...draft, layaBaseUrl: e.target.value })}
              />
            </label>
            <label>
              判定のしきい値{' '}
              <strong className="mint">{Math.round(draft.confidenceThreshold * 100)}%</strong>
              <input
                type="range"
                min={55}
                max={99}
                value={Math.round(draft.confidenceThreshold * 100)}
                onChange={(e) =>
                  setDraft({ ...draft, confidenceThreshold: Number(e.target.value) / 100 })
                }
              />
            </label>
            <p className="field-hint">
              成功 ≥ {Math.round(draft.confidenceThreshold * 100)}% ／ 失敗 ≤{' '}
              {Math.round((1 - draft.confidenceThreshold) * 100)}%<br />
              中間の確率は「要確認」として記録します。
            </p>
            <code className="block-code">
              .venv/bin/uvicorn services.laya.app:app --host 127.0.0.1 --port 8001
            </code>
          </div>
          <div className="settings-section">
            <div className="settings-section-head">
              <div>
                <Monitor size={18} />
                <h3>ブラウザと実行</h3>
              </div>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.headless}
                onChange={(e) => setDraft({ ...draft, headless: e.target.checked })}
              />
              バックグラウンドでブラウザを実行
            </label>
            <div className="form-grid">
              <label>
                画面の幅
                <input
                  type="number"
                  min={800}
                  max={2560}
                  required
                  value={draft.viewportWidth}
                  onChange={(e) => setDraft({ ...draft, viewportWidth: Number(e.target.value) })}
                />
              </label>
              <label>
                画面の高さ
                <input
                  type="number"
                  min={600}
                  max={1600}
                  required
                  value={draft.viewportHeight}
                  onChange={(e) => setDraft({ ...draft, viewportHeight: Number(e.target.value) })}
                />
              </label>
            </div>
            <label>
              ステップのタイムアウト（秒）
              <input
                type="number"
                min={5}
                max={300}
                required
                value={draft.stepTimeoutMs / 1000}
                onChange={(e) =>
                  setDraft({ ...draft, stepTimeoutMs: Number(e.target.value) * 1000 })
                }
              />
            </label>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="button ghost"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await checkHealth();
              setBusy(false);
            }}
          >
            <RefreshCw size={14} className={busy ? 'spin' : ''} />
            保存済みの設定で接続確認
          </button>
          {health && (
            <div className="health-details">
              <p>生成モデル: {health.model.message}</p>
              <p>Laya: {health.laya.message}</p>
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <span>
            <ShieldCheck size={13} />
            API キーはレポートに含めません
          </span>
          <button className="button primary" disabled={busy}>
            <Save size={15} />
            {busy ? '確認中…' : '設定を保存'}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}
