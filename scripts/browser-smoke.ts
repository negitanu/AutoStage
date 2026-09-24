// Runs actual Stagehand v4 browsers against an isolated API and sample app.
// AI transport tests use a labelled fixture service, never a simulated pass in the product.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Run, Scenario, Settings } from '../shared/schema.js';

const dir = await mkdtemp(path.join(tmpdir(), 'autostage-smoke-'));
const base = 'http://127.0.0.1:4312';
let log = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: {
    ...process.env,
    PORT: '4312',
    AUTOSTAGE_DATA_DIR: dir,
    OPENROUTER_API_KEY: '',
    AZURE_OPENAI_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (b) => (log += String(b)));
child.stderr.on('data', (b) => (log += String(b)));
const fixture = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/chat/completions') {
    const request = JSON.parse(body) as {
      messages: { content: string }[];
      response_format: { type: string; json_schema: { name: string } };
    };
    const prompt = request.messages.map((m) => m.content).join('\n');
    if (request.response_format.json_schema.name === 'ScenarioDraft') {
      assert.match(prompt, /Forma — Sample workspace/);
      assert.match(prompt, /email/);
      assert.match(prompt, /Sign in/);
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  name: '生成したログインテスト',
                  description: 'フォームとログイン後の表示を確認',
                  steps: [
                    {
                      type: 'fill',
                      title: 'メールを入力',
                      target: '[name="email"]',
                      value: 'demo@autostage.dev',
                    },
                    {
                      type: 'fill',
                      title: 'パスワードを入力',
                      target: '[name="password"]',
                      value: 'stagehand-demo',
                    },
                    {
                      type: 'click',
                      title: 'ログイン',
                      target: 'button[type="submit"]',
                      value: '',
                    },
                    {
                      type: 'assertVisible',
                      title: 'ダッシュボードを確認',
                      target: '[data-testid="dashboard"]',
                      value: '',
                    },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    const line = prompt
      .split('\n')
      .find((l) => /\[\d+-\d+\]/.test(l) && /button/i.test(l) && /Sign in/i.test(l));
    const elementId = line?.match(/\[(\d+-\d+)\]/)?.[1];
    if (!elementId || request.response_format.type !== 'json_schema') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Fixture could not identify the observed sign-in button' }));
      return;
    }
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                action: {
                  elementId,
                  description: 'Fixture: sign-in button',
                  method: 'click',
                  arguments: [],
                },
                twoStep: false,
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.end(JSON.stringify({ probability: 0.6 }));
});
await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
async function request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data as T;
}
const state = () => request<{ scenarios: Scenario[]; runs: Run[]; settings: Settings }>('/state');
async function waitRun(id: string) {
  for (let i = 0; i < 180; i++) {
    const run = (await state()).runs.find((r) => r.id === id)!;
    if (!['queued', 'running'].includes(run.status)) return run;
    await delay(500);
  }
  throw new Error('Run did not finish within 90 seconds');
}
const start = (scenarioId: string) => request<Run>('/runs', 'POST', { scenarioId });
try {
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      await state();
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  assert.ok(ready, log);
  const initial = await state();
  const secret = 'test-integration-key-never-send';
  const saved = await request('/settings', 'PUT', {
    ...initial.settings,
    openRouterApiKey: secret,
  });
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(JSON.stringify(await state()).includes(secret), false);

  await request('/settings', 'PUT', {
    ...initial.settings,
    stepTimeoutMs: 5000,
    modelBaseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`,
    modelName: 'fixture-qwen',
    layaBaseUrl: `http://127.0.0.1:${(fixture.address() as { port: number }).port}`,
  });
  const beforeGeneration = (await state()).scenarios.length;
  const generated = await request<Scenario>('/scenarios/generate', 'POST', {
    url: `${base}/demo/`,
    prompt: 'メールとパスワードでログインし、ダッシュボードの表示を確認する',
  });
  assert.equal(generated.name, '生成したログインテスト');
  assert.equal(generated.steps[0].type, 'navigate');
  assert.equal(generated.steps[0].target, `${base}/demo/`);
  assert.equal(generated.steps.length, 5);
  assert.equal((await state()).scenarios.length, beforeGeneration);
  const savedGenerated = await request<Scenario>('/scenarios', 'POST', generated);
  assert.equal((await waitRun((await start(savedGenerated.id)).id)).status, 'passed');
  console.log('PASS Stagehand page analysis → model draft → explicit save → actual browser run');
  const login = initial.scenarios.find((s) => s.name === 'ログインフロー')!;
  const run = await waitRun((await start(login.id)).id);
  assert.equal(run.status, 'passed', JSON.stringify(run.logs));
  assert.equal(run.results.length, 6);
  assert.ok(run.finishedAt);
  for (const result of run.results) {
    assert.equal(result.status, 'passed');
    assert.ok(result.screenshot);
    const image = await fetch(base + result.screenshot);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.ok((await image.arrayBuffer()).byteLength > 1000);
  }
  console.log('PASS actual login · six steps and PNG artifacts');
  const search = initial.scenarios.find((s) => s.name === 'プロジェクト検索')!;
  assert.equal((await waitRun((await start(search.id)).id)).status, 'passed');
  console.log('PASS actual project search');
  const aiScenario = await request<Scenario>('/scenarios', 'POST', {
    ...login,
    name: 'Fixture: Stagehand model callback',
    steps: [
      ...login.steps.slice(0, 3),
      { id: 'act', type: 'act', title: 'AI click', target: 'Click the Sign in button.', value: '' },
      ...login.steps.slice(4),
    ],
  });
  const aiRun = await waitRun((await start(aiScenario.id)).id);
  assert.equal(aiRun.status, 'passed', JSON.stringify(aiRun.logs));
  console.log(
    'PASS Stagehand act → local OpenAI-compatible callback → actual browser click (fixture model)',
  );
  const failedScenario = await request<Scenario>('/scenarios', 'POST', {
    ...login,
    name: 'Fixture: failure',
    steps: [
      login.steps[0],
      {
        id: 'fail',
        type: 'assertText',
        title: 'Must fail',
        target: 'body',
        value: 'THIS TEXT DOES NOT EXIST',
      },
      { id: 'skip', type: 'click', title: 'Must skip', target: 'button', value: '' },
    ],
  });
  const failed = await waitRun((await start(failedScenario.id)).id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.results[1].status, 'failed');
  assert.equal(failed.results[2].status, 'skipped');
  assert.ok(failed.results[1].screenshot);
  assert.ok(failed.finishedAt);
  console.log('PASS failed assertion, timeout, failure capture, downstream skip');
  const reviewScenario = await request<Scenario>('/scenarios', 'POST', {
    ...login,
    name: 'Fixture: uncertain Laya transport',
    steps: [
      login.steps[0],
      {
        id: 'semantic',
        type: 'semantic',
        title: 'Uncertain fixture',
        target: 'User is signed in',
        value: 'main',
      },
    ],
  });
  const review = await waitRun((await start(reviewScenario.id)).id);
  assert.equal(review.status, 'review');
  assert.equal(review.results[1].probability, 0.6);
  console.log('PASS Laya transport and uncertainty gating (fixture probability)');
  const cancelled = await start(failedScenario.id);
  await request(`/runs/${cancelled.id}/cancel`, 'POST');
  assert.equal((await waitRun(cancelled.id)).status, 'cancelled');
  await request(`/scenarios/${login.id}`, 'PUT', { ...login, name: 'Updated scenario' });
  assert.equal((await state()).runs.find((r) => r.id === run.id)!.scenario.name, 'ログインフロー');
  const exported = await fetch(`${base}/api/runs/${run.id}/export`);
  const report = (await exported.json()) as Run;
  assert.equal(report.id, run.id);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.ok(exported.headers.get('content-disposition')?.includes('.json'));
  const blocked = await fetch(`${base}/api/runs`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenarioId: login.id }),
  });
  assert.equal(blocked.status, 403);
  console.log('PASS cancellation, immutable history, export, cross-origin protection');
  const privateState = await request<{ credentials: { openRouterKeySource: string } }>('/state');
  assert.equal(privateState.credentials.openRouterKeySource, 'saved');
  assert.equal(JSON.stringify(privateState).includes(secret), false);
  await request('/settings', 'PUT', {
    ...initial.settings,
    modelProvider: 'openrouter',
    openRouterModel: 'test/structured',
    clearOpenRouterApiKey: true,
  });
  const cleared = await request<{
    credentials: { openRouterKeySource: string };
    settings: Settings;
  }>('/state');
  assert.equal(cleared.credentials.openRouterKeySource, 'none');
  assert.equal(cleared.settings.modelProvider, 'openrouter');
  assert.equal(cleared.settings.openRouterModel, 'test/structured');
  const health = await request<{ model: { ok: boolean; message: string } }>('/health');
  assert.equal(health.model.ok, false);
  assert.match(health.model.message, /API キー/);
  console.log(
    'PASS OpenRouter settings round-trip, blank-key retention, key deletion, missing-key health and secret-free export',
  );
  const azureSecret = 'test-azure-key-never-send';
  await request('/settings', 'PUT', {
    ...initial.settings,
    modelProvider: 'azure',
    azureEndpoint: 'https://sample.openai.azure.com',
    azureDeployment: 'smoke-deployment',
    azureApiKey: azureSecret,
  });
  const azureState = await state();
  assert.equal(azureState.settings.modelProvider, 'azure');
  assert.equal(azureState.settings.azureDeployment, 'smoke-deployment');
  assert.equal(JSON.stringify(azureState).includes(azureSecret), false);
  await request('/settings', 'PUT', { ...azureState.settings, azureApiKey: '' });
  const azureKept = await request<{ credentials: { azureKeySource: string } }>('/state');
  assert.equal(azureKept.credentials.azureKeySource, 'saved');
  await request('/settings', 'PUT', { ...azureState.settings, clearAzureApiKey: true });
  const azureCleared = await request<{ credentials: { azureKeySource: string } }>('/state');
  assert.equal(azureCleared.credentials.azureKeySource, 'none');
  console.log(
    'PASS Azure settings round-trip, key retention and deletion without exposing secrets',
  );
} finally {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
