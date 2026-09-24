import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { credentials } from '../server/credentials.js';
import { checkModelHealth, createModel, type ModelRequest } from '../server/model.js';
import { modelLabel, settingsSchema, settingsUpdateSchema } from '../shared/schema.js';

const settings = settingsSchema.parse({
  modelProvider: 'azure',
  azureEndpoint: 'https://sample.openai.azure.com',
  azureDeployment: 'my-gpt-4o-mini',
});
const request: ModelRequest = {
  messages: [{ role: 'user', content: { type: 'text', text: 'Choose the next action' } }],
  responseFormat: {
    type: 'json_schema',
    name: 'action',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        steps: { type: 'array', minItems: 1, maxItems: 11, items: { type: 'string' } },
      },
    },
  },
};
const fakeFetch = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch => ((url, init) => Promise.resolve(handler(String(url), init))) as typeof fetch;

test('Azure v1 sends deployment name, api-key and strict schema without unsupported sampling parameters', async () => {
  const result = await createModel(settings, AbortSignal.timeout(1000), {
    apiKey: 'azure-secret',
    fetch: fakeFetch((url, init) => {
      assert.equal(url, 'https://sample.openai.azure.com/openai/v1/chat/completions');
      assert.equal(init?.redirect, 'error');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('api-key'), 'azure-secret');
      assert.equal(headers.has('Authorization'), false);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'my-gpt-4o-mini');
      assert.equal(body.max_completion_tokens, 4096);
      assert.equal(body.max_tokens, undefined);
      assert.equal(body.temperature, undefined);
      assert.equal(body.provider, undefined);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.response_format.json_schema.schema.properties.steps.minItems, undefined);
      assert.equal(body.response_format.json_schema.schema.properties.steps.maxItems, undefined);
      assert.equal(body.stream, false);
      assert.equal(String(init?.body).includes('azure-secret'), false);
      return Response.json({ choices: [{ message: { content: '{"success":true}' } }] });
    }),
  })(request);
  assert.equal(result.outputFormat, 'json_schema');
  if (result.outputFormat === 'json_schema')
    assert.deepEqual(result.structuredContent, { success: true });
  assert.equal(modelLabel(settings), 'my-gpt-4o-mini');
});

test('Azure accepts the documented v1 base URL and reports authentication without claiming deployment inference', async () => {
  const urls: string[] = [];
  const result = await checkModelHealth(
    { ...settings, azureEndpoint: 'https://sample.services.ai.azure.com/openai/v1/' },
    {
      apiKey: 'azure-secret',
      fetch: fakeFetch((url, init) => {
        urls.push(url);
        assert.equal(new Headers(init?.headers).get('api-key'), 'azure-secret');
        return Response.json({ data: [{ id: 'gpt-4o-mini' }] });
      }),
    },
  );
  assert.deepEqual(urls, ['https://sample.services.ai.azure.com/openai/v1/models']);
  assert.equal(result.ok, true);
  assert.match(result.message, /デプロイ・推論は未実行/);
  assert.equal(result.models, undefined);
});

test('Azure requires a key and translates upstream errors without exposing credentials', async () => {
  await assert.rejects(
    createModel(settings, AbortSignal.timeout(1000))(request),
    /Azure OpenAI API キー/,
  );
  await assert.rejects(
    createModel(settings, AbortSignal.timeout(1000), {
      apiKey: 'azure-secret',
      fetch: fakeFetch(() =>
        Response.json({ error: { message: 'azure-secret' } }, { status: 404 }),
      ),
    })(request),
    (error) =>
      error instanceof Error &&
      error.message.includes('デプロイ名') &&
      !error.message.includes('azure-secret'),
  );
  const health = await checkModelHealth(settings, {
    apiKey: 'azure-secret',
    fetch: fakeFetch(() => new Response('', { status: 401 })),
  });
  assert.equal(health.ok, false);
  assert.match(health.message, /API キー/);
});

test('Azure endpoint validation blocks arbitrary destinations and credentials in URLs', () => {
  for (const endpoint of [
    'http://sample.openai.azure.com',
    'https://sample.openai.azure.com.evil.example',
    'https://127.0.0.1',
    'https://user:pass@sample.openai.azure.com',
    'https://sample.openai.azure.com:8443',
    'https://sample.openai.azure.com/other',
    'https://sample.openai.azure.com?key=secret',
  ]) {
    assert.equal(settingsSchema.safeParse({ azureEndpoint: endpoint }).success, false, endpoint);
  }
  assert.equal(
    settingsUpdateSchema.safeParse({ azureApiKey: 'azure-secret', clearAzureApiKey: true }).success,
    false,
  );
  assert.equal(settingsUpdateSchema.safeParse({ azureApiKey: 'header\ninjection' }).success, false);
  assert.equal(
    JSON.stringify(settingsSchema.parse({ azureApiKey: 'secret' })).includes('secret'),
    false,
  );
});

test('Azure and OpenRouter keys stay separate across save, replace and delete', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autostage-azure-'));
  try {
    const keys = credentials(dir, {});
    keys.update('router-secret');
    keys.updateAzure('azure-secret');
    assert.equal(keys.get(), 'router-secret');
    assert.equal(keys.getAzure(), 'azure-secret');
    assert.equal(statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(keys.status()).includes('secret'), false);
    keys.updateAzure('new-azure-secret');
    assert.equal(keys.get(), 'router-secret');
    assert.equal(keys.getAzure(), 'new-azure-secret');
    keys.update(undefined, true);
    assert.equal(keys.get(), undefined);
    assert.equal(keys.getAzure(), 'new-azure-secret');
    assert.equal(
      readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes('router-secret'),
      false,
    );
    keys.updateAzure(undefined, true);
    assert.equal(keys.getAzure(), undefined);
    const env = credentials(dir, { AZURE_OPENAI_API_KEY: 'env-azure-secret' });
    assert.equal(env.getAzure(), 'env-azure-secret');
    assert.equal(env.status().azureKeySource, 'environment');
  } finally {
    rmSync(dir, { recursive: true });
  }
});
