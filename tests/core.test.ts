import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { settingsSchema, scenarioSchema, generateScenarioRequestSchema } from '../shared/schema.js';
import { createModel, parseModelJson, verdict } from '../server/model.js';
import { draftFromModel } from '../server/generate.js';

test('Laya confidence gating never promotes uncertain or invalid results', () => {
  assert.equal(verdict(0.95, 0.85), 'passed');
  assert.equal(verdict(0.05, 0.85), 'failed');
  assert.equal(verdict(0.6, 0.85), 'review');
  assert.equal(verdict(0.85, 0.85), 'passed');
  assert.equal(verdict(0.15, 0.85), 'failed');
  for (const value of [NaN, Infinity, -0.1, 1.1]) assert.throws(() => verdict(value, 0.85));
});
test('model JSON supports reasoning tags and fenced JSON, rejects incomplete output', () => {
  assert.deepEqual(parseModelJson('<think>reasoning</think>\n```json\n{"action":"click"}\n```'), {
    action: 'click',
  });
  for (const value of ['not json', '{"action":', 'null', '[]'])
    assert.throws(() => parseModelJson(value));
});
test('model endpoints are loopback-only and have no embedded credentials', () => {
  for (const url of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:11434/v1',
  ])
    assert.equal(settingsSchema.parse({ modelBaseUrl: url }).modelBaseUrl, url);
  assert.equal(
    settingsSchema.parse({ modelBaseUrl: 'http://host.docker.internal:11434/v1' }).modelBaseUrl,
    'http://host.docker.internal:11434/v1',
  );
  assert.equal(
    settingsSchema.parse({ layaBaseUrl: 'http://laya:8001' }).layaBaseUrl,
    'http://laya:8001',
  );
  assert.equal(settingsSchema.safeParse({ modelBaseUrl: 'http://laya:11434/v1' }).success, false);
  assert.equal(
    settingsSchema.safeParse({ layaBaseUrl: 'http://host.docker.internal:8001' }).success,
    false,
  );
  for (const url of [
    'https://api.example.com/v1',
    'file:///tmp/model',
    'http://localhost.evil.test',
    'http://key@localhost:1234',
    'http://localhost:1234?redirect=1',
  ])
    assert.equal(settingsSchema.safeParse({ modelBaseUrl: url }).success, false);
});
test('scenario validation rejects empty assertions and duplicate step IDs', () => {
  const scenario = {
    name: 'Test',
    baseUrl: 'http://localhost:4310',
    steps: [{ id: 'a', type: 'assertText', title: 'Check', target: 'body', value: '' }],
  };
  assert.equal(scenarioSchema.safeParse(scenario).success, false);
  scenario.steps[0].value = 'Expected';
  assert.equal(scenarioSchema.safeParse(scenario).success, true);
  scenario.steps.push(scenario.steps[0]);
  assert.equal(scenarioSchema.safeParse(scenario).success, false);
});
test('generated plans are validated, start at the observed page, and cannot navigate to another site', () => {
  const output = {
    name: 'ログインを確認',
    description: 'フォームを検証',
    steps: [{ type: 'assertVisible', title: '入力欄を確認', target: '[name="email"]', value: '' }],
  };
  const draft = draftFromModel(output, 'https://example.com/login');
  assert.equal(draft.steps[0].target, 'https://example.com/login');
  assert.equal(draft.steps[1].type, 'assertVisible');
  assert.equal(draft.tags[0], 'AI 生成');
  assert.equal(scenarioSchema.safeParse(draft).success, true);
  assert.throws(
    () =>
      draftFromModel(
        {
          ...output,
          steps: [{ ...output.steps[0], type: 'navigate', target: 'https://evil.example/' }],
        },
        'https://example.com/login',
      ),
    /別のサイト/,
  );
  assert.throws(() =>
    draftFromModel(
      { ...output, steps: [{ ...output.steps[0], type: 'assertText', value: '' }] },
      'https://example.com/login',
    ),
  );
  assert.equal(
    generateScenarioRequestSchema.safeParse({
      url: 'https://user:secret@example.com/',
      prompt: 'ログインの表示を確認',
    }).success,
    false,
  );
});
test('real HTTP adapter sends structured schema, configured model and local messages', async () => {
  let captured: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    captured = JSON.parse(body);
    assert.equal(req.url, '/v1/chat/completions');
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"success":true}' }, finish_reason: 'stop' }],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const generate = createModel(
      settingsSchema.parse({
        modelBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelName: 'gemma3:12b',
      }),
      AbortSignal.timeout(5000),
    );
    const result = await generate({
      systemPrompt: 'Return JSON',
      messages: [{ role: 'user', content: { type: 'text', text: 'Click sign in' } }],
      responseFormat: {
        type: 'json_schema',
        name: 'action',
        schema: { type: 'object', properties: { success: { type: 'boolean' } } },
      },
    });
    assert.equal(captured.model, 'gemma3:12b');
    assert.equal(captured.stream, false);
    assert.equal((captured.response_format as { type: string }).type, 'json_schema');
    assert.ok(result.outputFormat === 'json_schema');
    assert.deepEqual(result.structuredContent, { success: true });
    assert.deepEqual(captured.messages, [
      { role: 'system', content: 'Return JSON' },
      { role: 'user', content: 'Click sign in' },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
