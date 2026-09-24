import { modelLabel, type Settings, type ServiceHealth } from '../shared/schema.js';
import type { ClientLLM } from '@browserbasehq/stagehand';
import { z } from 'zod';

export type ModelRequest = Parameters<ClientLLM['generate']>[0];
export function parseModelJson(content: string) {
  const cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    return z.record(z.string(), z.json()).parse(JSON.parse(cleaned));
  } catch {
    throw new Error(
      '生成モデルの応答が有効な JSON オブジェクトではありません。JSON Schema による構造化出力に対応するモデルを設定してください。',
    );
  }
}
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
type ConnectionOptions = { apiKey?: string; fetch?: typeof fetch };
const azureUnsupportedSchemaKeywords = new Set([
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'multipleOf',
  'patternProperties',
  'unevaluatedProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
  'unevaluatedItems',
  'contains',
  'minContains',
  'maxContains',
  'minItems',
  'maxItems',
  'uniqueItems',
]);
function azureJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(azureJsonSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      if (azureUnsupportedSchemaKeywords.has(key)) return [];
      if (key === 'properties' || key === '$defs' || key === 'definitions')
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(child as Record<string, unknown>).map(([name, schema]) => [
                name,
                azureJsonSchema(schema),
              ]),
            ),
          ],
        ];
      return [[key, azureJsonSchema(child)]];
    }),
  );
}
function connection(settings: Settings, options: ConnectionOptions) {
  const openRouter = settings.modelProvider === 'openrouter';
  const azure = settings.modelProvider === 'azure';
  if ((openRouter || azure) && !options.apiKey)
    throw new Error(`${openRouter ? 'OpenRouter' : 'Azure OpenAI'} API キーを設定してください`);
  const azureEndpoint = settings.azureEndpoint.replace(/\/$/, '');
  return {
    openRouter,
    azure,
    baseUrl: openRouter
      ? OPENROUTER_BASE_URL
      : azure
        ? azureEndpoint.endsWith('/openai/v1')
          ? azureEndpoint
          : `${azureEndpoint}/openai/v1`
        : settings.modelBaseUrl.replace(/\/$/, ''),
    headers: {
      'Content-Type': 'application/json',
      ...(openRouter ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...(azure ? { 'api-key': options.apiKey! } : {}),
    },
    label: openRouter ? 'OpenRouter' : azure ? 'Azure OpenAI' : 'ローカル生成モデル',
  };
}
function apiError(label: string, status: number, upstreamMessage?: string) {
  const detail =
    status === 401 || status === 403
      ? 'API キーとアクセス権を確認してください'
      : status === 402
        ? `${label} の残高・利用上限を確認してください`
        : status === 429
          ? '利用制限に達しました。時間をおいて再実行してください'
          : status === 404 &&
              upstreamMessage?.includes(
                'No endpoints found that can handle the requested parameters',
              )
            ? '選択モデルの提供元が要求されたパラメータに対応していません。JSON Schema に対応するモデルと提供元を確認してください'
            : label === 'Azure OpenAI'
              ? 'リソース URL、デプロイ名と構造化出力の対応を確認してください'
              : 'モデル名と構造化出力の対応を確認してください';
  return new Error(`${label}: HTTP ${status}。${detail}。`);
}
export function createModel(
  settings: Settings,
  signal: AbortSignal,
  options: ConnectionOptions = {},
): ClientLLM['generate'] {
  return async (params: ModelRequest) => {
    const config = connection(settings, options);
    const messages: unknown[] = [];
    if (params.systemPrompt) messages.push({ role: 'system', content: params.systemPrompt });
    for (const msg of params.messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
      if (blocks.some((b) => b.type !== 'text'))
        throw new Error(
          'この接続はテキストによる構造化出力専用です。画像入力・ツール呼び出しには対応していません。',
        );
      messages.push({
        role: msg.role,
        content: blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n'),
      });
    }
    const format = params.responseFormat;
    const response = await (options.fetch ?? fetch)(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: config.headers,
      body: JSON.stringify({
        model: modelLabel(settings),
        ...(config.openRouter ? { provider: { require_parameters: true } } : {}),
        messages,
        // Reasoning models may reject temperature; OpenRouter's strict routing
        // can also exclude every compatible endpoint when it is present.
        ...(!config.openRouter && !config.azure ? { temperature: params.temperature ?? 0 } : {}),
        ...(config.azure ? { max_completion_tokens: 4096 } : { max_tokens: 4096 }),
        stream: false,
        ...(format?.type === 'json_schema'
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: format.name,
                  strict: true,
                  schema: config.azure ? azureJsonSchema(format.schema) : format.schema,
                },
              },
            }
          : {}),
      }),
    }).catch((error: unknown) => {
      if (signal.aborted) throw error;
      throw new Error(
        `${config.label} に接続できません。ネットワークと接続設定を確認してください。`,
      );
    });
    if (!response.ok) {
      const errorBody = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw apiError(config.label, response.status, errorBody?.error?.message);
    }
    const body = (await response.json().catch(() => {
      throw new Error(`${config.label} から不正な応答を受信しました`);
    })) as {
      error?: { code?: number };
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    if (body.error) throw apiError(config.label, Number(body.error.code) || 502);
    const choice = body.choices?.[0];
    const text = choice?.message?.content;
    if (choice?.finish_reason === 'length')
      throw new Error('モデルの応答が上限で途切れました。より簡潔な操作に分割してください。');
    if (typeof text !== 'string' || !text)
      throw new Error(`${config.label} から空の応答を受信しました`);
    if (format?.type === 'json_schema')
      return {
        role: 'assistant',
        content: { type: 'text', text },
        outputFormat: 'json_schema',
        structuredContent: parseModelJson(text),
      };
    return { role: 'assistant', content: { type: 'text', text }, outputFormat: 'text' };
  };
}

export function verdict(probability: number, threshold: number): 'passed' | 'failed' | 'review' {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1)
    throw new Error('Laya が不正な確率を返しました');
  return probability >= threshold ? 'passed' : probability <= 1 - threshold ? 'failed' : 'review';
}

export async function checkModelHealth(
  settings: Settings,
  options: ConnectionOptions = {},
): Promise<ServiceHealth> {
  try {
    const config = connection(settings, options);
    const request = (suffix: string) =>
      (options.fetch ?? fetch)(`${config.baseUrl}/${suffix}`, {
        headers: config.headers,
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    if (config.openRouter) {
      const key = await request('key');
      if (!key.ok) throw apiError(config.label, key.status);
    }
    const response = await request('models');
    if (!response.ok) throw apiError(config.label, response.status);
    const body = (await response.json()) as {
      data?: { id: string; supported_parameters?: string[] }[];
    };
    const models = (body.data ?? [])
      .filter((m) => !config.openRouter || m.supported_parameters?.includes('structured_outputs'))
      .map((m) => m.id);
    const model = modelLabel(settings);
    // Azure lists model offerings, while inference addresses deployment names.
    const ok = config.azure || models.includes(model);
    return {
      ok,
      models: config.azure ? undefined : models,
      message: ok
        ? `${model} · ${config.azure ? '接続確認済み（デプロイ・推論は未実行）' : config.openRouter ? 'キー確認済み（推論は未実行）' : '準備完了'}`
        : `モデル ${model} が見つからないか、JSON Schema に対応していません`,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && /API キー|HTTP/.test(error.message)
          ? error.message
          : '生成モデルに接続できません。接続設定を確認してください',
    };
  }
}
