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
function connection(settings: Settings, options: ConnectionOptions) {
  const remote = settings.modelProvider === 'openrouter';
  if (remote && !options.apiKey) throw new Error('OpenRouter API キーを設定してください');
  return {
    remote,
    baseUrl: remote ? OPENROUTER_BASE_URL : settings.modelBaseUrl.replace(/\/$/, ''),
    headers: {
      'Content-Type': 'application/json',
      ...(remote ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    },
    label: remote ? 'OpenRouter' : 'ローカル生成モデル',
  };
}
function apiError(label: string, status: number, upstreamMessage?: string) {
  const detail =
    status === 401 || status === 403
      ? 'API キーとアクセス権を確認してください'
      : status === 402
        ? 'OpenRouter の残高・利用上限を確認してください'
        : status === 429
          ? '利用制限に達しました。時間をおいて再実行してください'
          : status === 404 &&
              upstreamMessage?.includes(
                'No endpoints found that can handle the requested parameters',
              )
            ? '選択モデルの提供元が要求されたパラメータに対応していません。JSON Schema に対応するモデルと提供元を確認してください'
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
        ...(config.remote ? { provider: { require_parameters: true } } : {}),
        messages,
        // Some OpenRouter models reject temperature entirely. With strict provider
        // routing, including it would exclude every otherwise compatible endpoint.
        ...(!config.remote ? { temperature: params.temperature ?? 0 } : {}),
        max_tokens: 4096,
        stream: false,
        ...(format?.type === 'json_schema'
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: format.name, strict: true, schema: format.schema },
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
    if (config.remote) {
      const key = await request('key');
      if (!key.ok) throw apiError(config.label, key.status);
    }
    const response = await request('models');
    if (!response.ok) throw apiError(config.label, response.status);
    const body = (await response.json()) as {
      data?: { id: string; supported_parameters?: string[] }[];
    };
    const models = (body.data ?? [])
      .filter((m) => !config.remote || m.supported_parameters?.includes('structured_outputs'))
      .map((m) => m.id);
    const model = modelLabel(settings);
    const ok = models.includes(model);
    return {
      ok,
      models,
      message: ok
        ? `${model} · ${config.remote ? 'キー確認済み（推論は未実行）' : '準備完了'}`
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
