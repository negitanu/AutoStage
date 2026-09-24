import { credentials } from './credentials.js';
import { generateScenario } from './generate.js';
import { checkModelHealth } from './model.js';
import express from 'express';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import {
  scenarioSchema,
  generateScenarioRequestSchema,
  settingsSchema,
  settingsUpdateSchema,
  type Run,
  type Health,
} from '../shared/schema.js';
import {
  dataDir,
  listScenarios,
  getScenario,
  saveScenario,
  deleteScenario,
  listRuns,
  getRun,
  saveRun,
  getSettings,
  saveSettings,
  seedScenarios,
} from './store.js';

const keys = credentials(dataDir);
const port = Number(process.env.PORT || 4310);
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host))
    return void res.status(403).json({ error: 'Local connections only' });
  const origin = req.get('origin');
  if (
    origin &&
    ![
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ].includes(origin)
  )
    return void res.status(403).json({ error: 'Origin is not allowed' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '512kb' }));
seedScenarios(`http://127.0.0.1:${port}`);
const subscribers = new Set<express.Response>();
function broadcast() {
  for (const res of subscribers) res.write('event: refresh\ndata: {}\n\n');
}
let active: { id: string; child: ChildProcess; watchdog: NodeJS.Timeout } | undefined;
let generating = false;

function markStopped(id: string, status: 'failed' | 'cancelled', message: string) {
  const run = getRun(id);
  if (!run || !['queued', 'running'].includes(run.status)) return;
  run.status = status;
  run.finishedAt = new Date().toISOString();
  for (const step of run.results)
    if (['pending', 'running'].includes(step.status))
      step.status = step.status === 'running' && status === 'cancelled' ? 'cancelled' : 'skipped';
  run.logs.push({ time: run.finishedAt, level: 'error', message });
  saveRun(run);
  broadcast();
}
function startNext() {
  if (active) return;
  const run = listRuns()
    .reverse()
    .find((r) => r.status === 'queued');
  if (!run) return;
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  saveRun(run);
  const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const watchdog = setTimeout(
    () => {
      markStopped(run.id, 'failed', '実行の制限時間を超えました');
      child.send({ type: 'cancel' });
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    },
    Math.min(
      30 * 60_000,
      90_000 + run.scenario.steps.length * (run.settings.stepTimeoutMs + 15_000),
    ),
  );
  active = { id: run.id, child, watchdog };
  let workerError = '';
  child.stderr?.on('data', (chunk) => {
    workerError = (workerError + String(chunk)).slice(-4000);
  });
  child.stdout?.on('data', () => {});
  child.on('message', (message: { type: string; run: Run }) => {
    if (message.type !== 'update') return;
    const current = getRun(run.id);
    if (!current || !['queued', 'running'].includes(current.status)) return;
    saveRun(message.run);
    broadcast();
  });
  child.on('error', (error) => markStopped(run.id, 'failed', error.message));
  child.on('exit', () => {
    clearTimeout(watchdog);
    markStopped(run.id, 'failed', workerError || '実行ワーカーが予期せず終了しました');
    active = undefined;
    startNext();
  });
  child.send({
    type: 'start',
    run,
    dataDir,
    modelApiKey: run.settings.modelProvider === 'openrouter' ? keys.get() : undefined,
  });
  broadcast();
}

app.get('/api/state', (_req, res) =>
  res.json({
    scenarios: listScenarios(),
    runs: listRuns(),
    settings: getSettings(),
    credentials: keys.status(),
  }),
);
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write('event: refresh\ndata: {}\n\n');
  subscribers.add(res);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
});
app.post('/api/scenarios/generate', async (req, res) => {
  const { url, prompt } = generateScenarioRequestSchema.parse(req.body);
  if (generating) return void res.status(409).json({ error: '別のシナリオを生成中です' });
  generating = true;
  try {
    const draft = await generateScenario(url, prompt, getSettings(), keys.get());
    res.json(draft);
  } catch (error) {
    res.status(502).json({
      error:
        error instanceof ZodError
          ? '生成された手順がシナリオ形式に合いません。指示を調整して再試行してください'
          : error instanceof Error
            ? error.message
            : 'シナリオを生成できませんでした',
    });
  } finally {
    generating = false;
  }
});
app.post('/api/scenarios', (req, res) => {
  const item = saveScenario(scenarioSchema.parse(req.body));
  broadcast();
  res.status(201).json(item);
});
app.put('/api/scenarios/:id', (req, res) => {
  if (!getScenario(req.params.id))
    return void res.status(404).json({ error: 'シナリオが見つかりません' });
  const item = saveScenario(scenarioSchema.parse(req.body), req.params.id);
  broadcast();
  res.json(item);
});
app.delete('/api/scenarios/:id', (req, res) => {
  deleteScenario(req.params.id);
  broadcast();
  res.json({ ok: true });
});
app.put('/api/settings', (req, res) => {
  const update = settingsUpdateSchema.parse(req.body);
  const settings = settingsSchema.parse(update);
  keys.update(update.openRouterApiKey, update.clearOpenRouterApiKey);
  saveSettings(settings);
  broadcast();
  res.json(settings);
});
app.get('/api/health', async (_req, res) => {
  const settings = getSettings();
  const result: Health = {
    model: { ok: false, message: '未接続' },
    laya: { ok: false, message: '未接続' },
  };
  await Promise.all([
    checkModelHealth(settings, { apiKey: keys.get() }).then((model) => {
      result.model = model;
    }),
    (async () => {
      try {
        const response = await fetch(`${settings.layaBaseUrl.replace(/\/$/, '')}/health`, {
          signal: AbortSignal.timeout(4000),
          redirect: 'error',
        });
        if (!response.ok) throw new Error();
        const body = (await response.json()) as { ready: boolean; error?: string };
        result.laya = {
          ok: body.ready === true,
          message: body.ready ? '判定モデル準備完了' : body.error || 'モデルを読み込み中',
        };
      } catch {
        result.laya.message = 'Laya サービスを起動してください';
      }
    })(),
  ]);
  res.json(result);
});
app.post('/api/runs', (req, res) => {
  const scenario =
    typeof req.body.scenarioId === 'string' ? getScenario(req.body.scenarioId) : undefined;
  if (!scenario) return void res.status(404).json({ error: 'シナリオが見つかりません' });
  if (
    listRuns().some((r) => r.scenarioId === scenario.id && ['queued', 'running'].includes(r.status))
  )
    return void res.status(409).json({ error: 'このシナリオはすでに実行中です' });
  const run: Run = {
    id: randomUUID(),
    scenarioId: scenario.id,
    scenario,
    settings: getSettings(),
    status: 'queued',
    startedAt: new Date().toISOString(),
    results: scenario.steps.map((s) => ({ stepId: s.id, status: 'pending' })),
    logs: [],
  };
  saveRun(run);
  startNext();
  res.status(201).json(getRun(run.id));
});
app.post('/api/runs/:id/cancel', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return void res.status(404).json({ error: '実行が見つかりません' });
  markStopped(run.id, 'cancelled', 'ユーザーが実行を停止しました');
  if (active?.id === run.id) {
    const child = active.child;
    child.send({ type: 'cancel' });
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000).unref();
  }
  res.json(getRun(run.id));
});
app.get('/api/runs/:id/export', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return void res.status(404).json({ error: '実行が見つかりません' });
  res.attachment(`autostage-${run.id.slice(0, 8)}.json`).json(run);
});
app.use('/artifacts', express.static(path.join(dataDir, 'artifacts'), { dotfiles: 'deny' }));
app.use('/demo', express.static(path.resolve('public/demo')));
app.use(express.static(path.resolve('dist')));
app.get('/{*path}', (req, res) => {
  if (req.path.startsWith('/api/')) return void res.status(404).json({ error: 'Not found' });
  res.sendFile(path.resolve('dist/index.html'));
});
app.use(
  (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ZodError ? 400 : 500).json({
      error:
        error instanceof ZodError
          ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')
          : error.message,
    });
  },
);
const server = app.listen(port, process.env.AUTOSTAGE_LISTEN_HOST || '127.0.0.1', () =>
  console.log(`AutoStage API → http://127.0.0.1:${port}`),
);
function shutdown() {
  if (active) {
    markStopped(active.id, 'cancelled', 'サーバーを停止しました');
    active.child.send({ type: 'cancel' });
  }
  for (const res of subscribers) res.end();
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
