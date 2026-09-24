import {
  localBrowser,
  Stagehand,
  type StagehandBrowser,
  type Page,
  type ClientLLM,
} from '@browserbasehq/stagehand';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  modelLabel,
  providerLabel,
  type Run,
  type Step,
  type StepResult,
} from '../shared/schema.js';
import { createModel, verdict } from './model.js';

let browser: StagehandBrowser | undefined;
let stagehand: Stagehand | undefined;
const abort = new AbortController();
async function close() {
  await Promise.allSettled([stagehand?.close(), browser?.close()]);
}
process.on(
  'message',
  (message: { type: string; run?: Run; dataDir?: string; modelApiKey?: string }) => {
    if (message.type === 'cancel') {
      abort.abort();
      void close();
    }
    if (message.type === 'start' && message.run && message.dataDir)
      void execute(message.run, message.dataDir, message.modelApiKey);
  },
);
process.on('disconnect', () => {
  abort.abort();
  void close().finally(() => process.exit(1));
});

async function until(check: () => Promise<boolean>, message: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      if (await check()) return;
    } catch {
      signal.throwIfAborted();
    }
    await delay(200, undefined, { signal });
  }
  throw new Error(message);
}

async function perform(
  step: Step,
  page: Page,
  run: Run,
  signal: AbortSignal,
): Promise<Partial<StepResult>> {
  const locator = page.locator(step.target);
  switch (step.type) {
    case 'navigate': {
      const url = new URL(step.target, run.scenario.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol))
        throw new Error('HTTP(S) のページだけを開けます');
      const response = await page.goto(url.href);
      if (response && response.status() >= 400)
        throw new Error(`ページが HTTP ${response.status()} を返しました`);
      return { message: url.href };
    }
    case 'click':
      await locator.click();
      return { message: 'クリックしました' };
    case 'fill':
      await locator.fill(step.value);
      return { message: '入力しました' };
    case 'act': {
      if (!stagehand) throw new Error('Stagehand AI が初期化されていません');
      const result = await stagehand.act(step.target);
      if (!result.data.success)
        throw new Error(result.data.message || 'AI 操作が完了しませんでした');
      return {
        message: `${providerLabel(run.settings.modelProvider)}で操作しました`,
      };
    }
    case 'assertVisible':
      await until(() => locator.isVisible(), '要素が表示されません', signal);
      return { message: '要素の表示を確認しました' };
    case 'assertText': {
      let actual = '';
      await until(
        async () => {
          actual = await locator.innerText();
          return actual.includes(step.value);
        },
        '期待するテキストが見つかりません',
        signal,
      );
      return { message: `「${step.value}」を確認しました`, evidence: actual.slice(0, 12000) };
    }
    case 'assertUrl': {
      const expected = new URL(step.target, run.scenario.baseUrl).href;
      await until(async () => (await page.url()) === expected, 'URL が一致しません', signal);
      return { message: `URL が一致しました: ${expected}` };
    }
    case 'semantic': {
      const text = await page.locator(step.value || 'body').innerText();
      if (!text.trim()) throw new Error('Laya に渡すテキストが空です');
      if (text.length > 12000)
        throw new Error('Laya の判定対象が長すぎます。対象セレクターで範囲を絞ってください。');
      const response = await fetch(`${run.settings.layaBaseUrl.replace(/\/$/, '')}/assert`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, expectation: step.target }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { detail?: string };
        throw new Error(`Laya: ${body.detail || `HTTP ${response.status}`}`);
      }
      const result = (await response.json()) as { probability: number };
      const status = verdict(result.probability, run.settings.confidenceThreshold);
      return {
        status,
        probability: result.probability,
        evidence: text,
        message: `期待条件が真である確率: ${(result.probability * 100).toFixed(1)}%${status === 'review' ? ' — 判定が不確かなため要確認' : ''}`,
      };
    }
  }
}

async function execute(run: Run, dataDir: string, modelApiKey?: string) {
  const send = () => {
    if (process.connected) process.send?.({ type: 'update', run });
  };
  const log = (message: string, level: 'info' | 'error' = 'info') => {
    run.logs.push({ time: new Date().toISOString(), level, message });
    send();
  };
  let page: Page | undefined;
  let currentSignal = abort.signal;
  const folder = path.join(dataDir, 'artifacts', run.id);
  await mkdir(folder, { recursive: true });
  const screenshot = async (index: number) => {
    if (!page || abort.signal.aborted) return undefined;
    try {
      const filename = `${index + 1}.png`;
      const image = await page.screenshot({ type: 'png' });
      await writeFile(path.join(folder, filename), image);
      return `/artifacts/${run.id}/${filename}`;
    } catch {
      log('スクリーンショットを取得できませんでした');
      return undefined;
    }
  };
  try {
    run.status = 'running';
    send();
    log('Stagehand v4 · ローカル Chrome を起動しています');
    browser = await localBrowser.launch({
      headless: run.settings.headless,
      viewport: { width: run.settings.viewportWidth, height: run.settings.viewportHeight },
      ...(process.env.AUTOSTAGE_DISABLE_CHROME_SANDBOX === '1' ? { chromiumSandbox: false } : {}),
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    });
    abort.signal.throwIfAborted();
    const generate: ClientLLM['generate'] = async (params) =>
      createModel(run.settings, currentSignal, { apiKey: modelApiKey })(params);
    stagehand = await Stagehand.create({ browser, model: { generate } });
    [page] = await browser.context.pages();
    if (!page) page = await browser.context.newPage();
    if (run.scenario.steps.some((s) => s.type === 'act')) {
      log(
        `AI 操作: ${modelLabel(run.settings)} · ${run.settings.modelProvider === 'local' ? run.settings.modelBaseUrl : providerLabel(run.settings.modelProvider)}`,
      );
    }
    for (let i = 0; i < run.scenario.steps.length; i++) {
      abort.signal.throwIfAborted();
      const step = run.scenario.steps[i];
      const result = run.results[i];
      const started = Date.now();
      result.status = 'running';
      result.startedAt = new Date().toISOString();
      log(`${String(i + 1).padStart(2, '0')}  ${step.title}`);
      const stepAbort = new AbortController();
      currentSignal = AbortSignal.any([abort.signal, stepAbort.signal]);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          perform(step, page, run, currentSignal),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              reject(
                new Error(
                  `${step.title}: ${run.settings.stepTimeoutMs / 1000} 秒以内に完了しませんでした${step.type === 'assertText' ? `。期待するテキスト:「${step.value}」` : ''}`,
                ),
              );
              stepAbort.abort();
            }, run.settings.stepTimeoutMs);
          }),
          new Promise<never>((_, reject) =>
            currentSignal.addEventListener(
              'abort',
              () => reject(new Error('実行が中断されました')),
              { once: true },
            ),
          ),
        ]);
        Object.assign(result, { status: 'passed', ...value });
      } catch (error) {
        result.status = abort.signal.aborted ? 'cancelled' : 'failed';
        result.message = error instanceof Error ? error.message : String(error);
        log(result.message, 'error');
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      result.durationMs = Date.now() - started;
      result.screenshot = await screenshot(i);
      send();
      if (result.status === 'failed' || result.status === 'cancelled') break;
    }
    run.status = abort.signal.aborted
      ? 'cancelled'
      : run.results.some((s) => s.status === 'failed')
        ? 'failed'
        : run.results.some((s) => s.status === 'review')
          ? 'review'
          : 'passed';
  } catch (error) {
    log(error instanceof Error ? error.message : String(error), 'error');
    run.status = abort.signal.aborted ? 'cancelled' : 'failed';
  } finally {
    for (const result of run.results)
      if (result.status === 'pending' || result.status === 'running') result.status = 'skipped';
    run.finishedAt = new Date().toISOString();
    log(`実行終了 · ${run.status}`);
    await close();
    process.exit(run.status === 'failed' ? 1 : 0);
  }
}
