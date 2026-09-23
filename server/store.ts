import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  settingsSchema,
  type ScenarioInput,
  type Scenario,
  type Run,
  type Settings,
} from '../shared/schema.js';

export const dataDir = path.resolve(process.env.AUTOSTAGE_DATA_DIR || '.data');
mkdirSync(path.join(dataDir, 'artifacts'), { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'autostage.sqlite'));
db.exec(
  `PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS scenarios (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
);
function all<T>(table: 'scenarios' | 'runs'): T[] {
  return (
    db.prepare(`SELECT body FROM ${table} ORDER BY rowid DESC`).all() as { body: string }[]
  ).map((r) => JSON.parse(r.body));
}
export function listScenarios() {
  return all<Scenario>('scenarios');
}
export function getScenario(id: string) {
  const row = db.prepare('SELECT body FROM scenarios WHERE id = ?').get(id) as
    { body: string } | undefined;
  return row ? (JSON.parse(row.body) as Scenario) : undefined;
}
export function saveScenario(input: ScenarioInput, id: string = randomUUID()): Scenario {
  const old = getScenario(id);
  const now = new Date().toISOString();
  const scenario = { ...input, id, createdAt: old?.createdAt || now, updatedAt: now };
  db.prepare(
    'INSERT INTO scenarios (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
  ).run(id, JSON.stringify(scenario));
  return scenario;
}
export function deleteScenario(id: string) {
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
}
export function listRuns() {
  return all<Run>('runs');
}
export function getRun(id: string) {
  const row = db.prepare('SELECT body FROM runs WHERE id = ?').get(id) as
    { body: string } | undefined;
  return row ? (JSON.parse(row.body) as Run) : undefined;
}
export function saveRun(run: Run) {
  db.prepare(
    'INSERT INTO runs (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
  ).run(run.id, JSON.stringify(run));
}
export function getSettings(): Settings {
  const row = db.prepare('SELECT body FROM settings WHERE id=1').get() as
    { body: string } | undefined;
  return settingsSchema.parse(
    row
      ? JSON.parse(row.body)
      : {
          modelBaseUrl: process.env.AUTOSTAGE_MODEL_BASE_URL,
          layaBaseUrl: process.env.AUTOSTAGE_LAYA_BASE_URL,
        },
  );
}
export function saveSettings(settings: Settings) {
  db.prepare(
    'INSERT INTO settings (id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
  ).run(JSON.stringify(settings));
}

export function seedScenarios(baseUrl: string) {
  if (db.prepare("SELECT value FROM metadata WHERE key='seeded'").get()) return;
  db.prepare("INSERT INTO metadata (key, value) VALUES ('seeded', '1')").run();
  if (listScenarios().length) return;
  const s = (
    type: Scenario['steps'][number]['type'],
    title: string,
    target: string,
    value = '',
  ) => ({ id: randomUUID(), type, title, target, value });
  saveScenario({
    name: 'AI でログインを検証',
    description: 'ローカル生成モデルが操作し、Laya がログイン後の状態を評価します。',
    baseUrl,
    tags: ['AI', 'Laya'],
    steps: [
      s('navigate', 'サンプルアプリを開く', '/demo/'),
      s('act', 'メールアドレスを入力', 'Enter demo@autostage.dev into the email field.'),
      s('act', 'パスワードを入力', 'Enter stagehand-demo into the password field.'),
      s('act', 'ログインする', 'Click the Sign in button.'),
      s('assertVisible', 'ダッシュボードの表示を確認', '[data-testid="dashboard"]'),
      s(
        'semantic',
        'ログイン成功を意味から判定',
        'The user is signed in and can see their workspace with a welcome message.',
        '[data-testid="dashboard"]',
      ),
    ],
  });
  saveScenario({
    name: 'プロジェクト検索',
    description: 'ワークスペース内の検索結果が入力に応じて絞り込まれることを確認します。',
    baseUrl,
    tags: ['検索', 'サンプル'],
    steps: [
      s('navigate', 'ワークスペースを開く', '/demo/?workspace=1'),
      s('fill', 'プロジェクト名を検索', '[data-testid="search"]', 'Website'),
      s('assertText', '検索結果を確認', '[data-testid="projects"]', 'Website redesign'),
      s('assertText', '一致した件数を確認', '[data-testid="count"]', '1 project'),
    ],
  });
  saveScenario({
    name: 'ログインフロー',
    description: 'メールアドレスでログインし、ワークスペースが正しく表示されることを検証します。',
    baseUrl,
    tags: ['認証', 'サンプル'],
    steps: [
      s('navigate', 'ログインページを開く', '/demo/'),
      s('fill', 'メールアドレスを入力', '[name="email"]', 'demo@autostage.dev'),
      s('fill', 'パスワードを入力', '[name="password"]', 'stagehand-demo'),
      s('click', 'サインインボタンをクリック', 'button[type="submit"]'),
      s('assertVisible', 'ワークスペースの表示を確認', '[data-testid="dashboard"]'),
      s(
        'assertText',
        'ウェルカムメッセージを検証',
        '[data-testid="welcome"]',
        'Welcome back, Alex',
      ),
    ],
  });
}

for (const run of listRuns()) {
  if (run.status === 'running' || run.status === 'queued') {
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    for (const step of run.results)
      if (step.status === 'running' || step.status === 'pending') {
        step.status = 'skipped';
        step.message = 'サーバーが再起動したため中断されました';
      }
    run.logs.push({
      time: run.finishedAt,
      level: 'error',
      message: 'サーバー再起動により実行が中断されました。再実行してください。',
    });
    saveRun(run);
  }
}
