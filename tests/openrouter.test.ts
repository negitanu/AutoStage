import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { settingsSchema, settingsUpdateSchema } from '../shared/schema.js';
import { createModel, checkModelHealth, type ModelRequest } from '../server/model.js';
import { credentials } from '../server/credentials.js';

const settings = settingsSchema.parse({
  modelProvider: 'openrouter',
  openRouterModel: 'test/structured',
});
const request: ModelRequest = {
  messages: [{ role: 'user', content: { type: 'text', text: 'Click sign in' } }],
  responseFormat: {
    type: 'json_schema',
    name: 'action',
    schema: { type: 'object', properties: { success: { type: 'boolean' } } },
  },
};
const fakeFetch = (
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch => ((url, init) => Promise.resolve(handler(String(url), init))) as typeof fetch;

test('OpenRouter uses fixed endpoint, bearer auth, strict schema routing and selected model', async () => {
  const generate = createModel(settings, AbortSignal.timeout(1000), {
    apiKey: 'test-secret',
    fetch: fakeFetch((url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret');
      assert.equal(init?.redirect, 'error');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'test/structured');
      assert.deepEqual(body.provider, { require_parameters: true });
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.stream, false);
      assert.equal(String(init?.body).includes('test-secret'), false);
      return Response.json({ choices: [{ message: { content: '{"success":true}' } }] });
    }),
  });
  const result = await generate(request);
  assert.equal(result.outputFormat, 'json_schema');
  if (result.outputFormat === 'json_schema')
    assert.deepEqual(result.structuredContent, { success: true });
});

test('local provider never receives OpenRouter credentials or routing parameters', async () => {
  await createModel(settingsSchema.parse({}), AbortSignal.timeout(1000), {
    apiKey: 'test-secret',
    fetch: fakeFetch((url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      assert.equal(JSON.parse(String(init?.body)).provider, undefined);
      return Response.json({ choices: [{ message: { content: '{}' } }] });
    }),
  })(request);
});

test('missing key fails without a request; upstream errors never echo credentials', async () => {
  await assert.rejects(
    createModel(settings, AbortSignal.timeout(1000), {
      fetch: fakeFetch(() => {
        throw new Error('must not call');
      }),
    })(request),
    /API キー/,
  );
  for (const status of [401, 402, 429, 502]) {
    await assert.rejects(
      createModel(settings, AbortSignal.timeout(1000), {
        apiKey: 'test-secret',
        fetch: fakeFetch(() => new Response('echo test-secret', { status })),
      })(request),
      (error) =>
        error instanceof Error &&
        error.message.includes(String(status)) &&
        !error.message.includes('test-secret'),
    );
  }
  await assert.rejects(
    createModel(settings, AbortSignal.timeout(1000), {
      apiKey: 'test-secret',
      fetch: fakeFetch(() => Response.json({ error: { code: 402, message: 'test-secret' } })),
    })(request),
    /HTTP 402/,
  );
});

test('health validates key before listing only structured output models', async () => {
  const calls: string[] = [];
  const options = {
    apiKey: 'test-secret',
    fetch: fakeFetch((url, init) => {
      calls.push(url);
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret');
      return Response.json(
        url.endsWith('/key')
          ? { data: {} }
          : {
              data: [
                { id: 'test/structured', supported_parameters: ['structured_outputs'] },
                { id: 'test/plain', supported_parameters: ['temperature'] },
              ],
            },
      );
    }),
  };
  const result = await checkModelHealth(settings, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ['test/structured']);
  assert.deepEqual(
    calls.map((x) => x.split('/').at(-1)),
    ['key', 'models'],
  );
  assert.equal(
    (await checkModelHealth({ ...settings, openRouterModel: 'test/plain' }, options)).ok,
    false,
  );
  assert.equal(
    (
      await checkModelHealth(settings, {
        ...options,
        fetch: fakeFetch(() => new Response('', { status: 401 })),
      })
    ).ok,
    false,
  );
});

test('credentials persist privately, support keep/replace/delete and environment precedence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'autostage-keys-'));
  try {
    const keys = credentials(dir, {});
    assert.equal(keys.status().openRouterKeySource, 'none');
    keys.update('test-secret');
    assert.equal(statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
    assert.equal(credentials(dir, {}).get(), 'test-secret');
    keys.update('');
    assert.equal(keys.get(), 'test-secret');
    assert.equal(JSON.stringify(keys.status()).includes('test-secret'), false);
    const envKeys = credentials(dir, { OPENROUTER_API_KEY: 'env-secret' });
    assert.equal(envKeys.get(), 'env-secret');
    assert.equal(envKeys.status().openRouterKeySource, 'environment');
    keys.update('replacement');
    assert.equal(
      readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes('test-secret'),
      false,
    );
    keys.update(undefined, true);
    assert.equal(keys.get(), undefined);
    assert.equal(envKeys.get(), 'env-secret');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('legacy settings default to local; public settings strip secrets and reject ambiguous updates', () => {
  assert.equal(settingsSchema.parse({}).modelProvider, 'local');
  assert.equal(
    JSON.stringify(settingsSchema.parse({ openRouterApiKey: 'test-secret' })).includes(
      'test-secret',
    ),
    false,
  );
  assert.equal(
    settingsUpdateSchema.safeParse({ openRouterApiKey: 'test-secret', clearOpenRouterApiKey: true })
      .success,
    false,
  );
  assert.equal(
    settingsUpdateSchema.safeParse({ openRouterApiKey: 'header\ninjection' }).success,
    false,
  );
});
