import { z } from 'zod';

export const stepTypes = [
  'navigate',
  'click',
  'fill',
  'act',
  'assertText',
  'assertUrl',
  'assertVisible',
  'semantic',
] as const;
export const stepSchema = z
  .object({
    id: z.string().min(1).max(80),
    type: z.enum(stepTypes),
    title: z.string().trim().min(1).max(120),
    target: z.string().max(4000).default(''),
    value: z.string().max(4000).default(''),
  })
  .superRefine((step, ctx) => {
    if (!step.target.trim())
      ctx.addIssue({
        code: 'custom',
        path: ['target'],
        message: '操作対象・指示を入力してください',
      });
    if (step.type === 'assertText' && !step.value.trim())
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: '期待するテキストを入力してください',
      });
  });
export const scenarioSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(500).default(''),
    baseUrl: z
      .url()
      .refine(
        (v) => ['http:', 'https:'].includes(new URL(v).protocol),
        'HTTP(S) URL を指定してください',
      ),
    tags: z.array(z.string().max(30)).max(6).default([]),
    steps: z.array(stepSchema).min(1).max(50),
  })
  .refine(
    (v) => new Set(v.steps.map((s) => s.id)).size === v.steps.length,
    'ステップ ID が重複しています',
  );
const privateUrl = (hosts: string[]) =>
  z.url().refine((v) => {
    const u = new URL(v);
    return (
      ['http:', 'https:'].includes(u.protocol) &&
      ['localhost', '127.0.0.1', '[::1]', ...hosts].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  }, '許可されたローカル / Docker 内の HTTP(S) URL を指定してください');
export const settingsSchema = z.object({
  modelProvider: z.enum(['local', 'openrouter']).default('local'),
  openRouterModel: z.string().trim().min(1).max(120).default('openai/gpt-4o-mini'),
  modelBaseUrl: privateUrl(['host.docker.internal']).default('http://127.0.0.1:11434/v1'),
  modelName: z.string().trim().min(1).max(120).default('qwen3:8b'),
  layaBaseUrl: privateUrl(['laya']).default('http://127.0.0.1:8001'),
  confidenceThreshold: z.number().min(0.55).max(0.99).default(0.85),
  headless: z.boolean().default(true),
  stepTimeoutMs: z.number().int().min(5000).max(300000).default(90000),
  viewportWidth: z.number().int().min(800).max(2560).default(1440),
  viewportHeight: z.number().int().min(600).max(1600).default(900),
});
export const settingsUpdateSchema = settingsSchema
  .extend({
    openRouterApiKey: z
      .string()
      .trim()
      .max(512)
      .regex(/^\S*$/, 'API キーに空白は使用できません')
      .optional(),
    clearOpenRouterApiKey: z.boolean().optional(),
  })
  .refine(
    (v) => !(v.openRouterApiKey && v.clearOpenRouterApiKey),
    'キーの更新と削除は同時にできません',
  );
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type CredentialStatus = { openRouterKeySource: 'environment' | 'saved' | 'none' };
export const modelLabel = (settings: Settings) =>
  settings.modelProvider === 'openrouter' ? settings.openRouterModel : settings.modelName;
export type Step = z.infer<typeof stepSchema>;
export type ScenarioInput = z.infer<typeof scenarioSchema>;
export type Scenario = ScenarioInput & { id: string; createdAt: string; updatedAt: string };
export type Settings = z.infer<typeof settingsSchema>;
export type Status = 'queued' | 'running' | 'passed' | 'failed' | 'review' | 'cancelled';
export type StepResult = {
  stepId: string;
  status: Status | 'pending' | 'skipped';
  startedAt?: string;
  durationMs?: number;
  message?: string;
  screenshot?: string;
  probability?: number;
  evidence?: string;
};
export type Run = {
  id: string;
  scenarioId: string;
  scenario: Scenario;
  settings: Settings;
  status: Status;
  startedAt: string;
  finishedAt?: string;
  results: StepResult[];
  logs: { time: string; level: 'info' | 'error'; message: string }[];
};
export type ServiceHealth = { ok: boolean; message: string; models?: string[] };
export type Health = { model: ServiceHealth; laya: ServiceHealth };
export const labels: Record<Step['type'], string> = {
  navigate: 'ページを開く',
  click: 'クリック',
  fill: '入力',
  act: 'AI 操作',
  assertText: 'テキスト検証',
  assertUrl: 'URL 検証',
  assertVisible: '表示検証',
  semantic: 'Laya 意味判定',
};
