import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CredentialStatus } from '../shared/schema.js';

// Credentials never belong to Settings, Run, SQLite snapshots, or API responses.
export function credentials(directory: string, env: NodeJS.ProcessEnv = process.env) {
  const file = path.join(directory, 'credentials.json');
  type SavedKeys = { openRouterApiKey?: string; azureApiKey?: string };
  const saved = (): SavedKeys =>
    existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as SavedKeys) : {};
  const update = (field: keyof SavedKeys, key?: string, clear = false) => {
    if (!clear && !key?.trim()) return;
    const next = saved();
    if (clear) delete next[field];
    else next[field] = key!.trim();
    if (!next.openRouterApiKey && !next.azureApiKey) {
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  };
  return {
    get: () => env.OPENROUTER_API_KEY?.trim() || saved().openRouterApiKey,
    getAzure: () => env.AZURE_OPENAI_API_KEY?.trim() || saved().azureApiKey,
    status: (): CredentialStatus => ({
      openRouterKeySource: env.OPENROUTER_API_KEY?.trim()
        ? 'environment'
        : saved().openRouterApiKey
          ? 'saved'
          : 'none',
      azureKeySource: env.AZURE_OPENAI_API_KEY?.trim()
        ? 'environment'
        : saved().azureApiKey
          ? 'saved'
          : 'none',
    }),
    update: (key?: string, clear = false) => update('openRouterApiKey', key, clear),
    updateAzure: (key?: string, clear = false) => update('azureApiKey', key, clear),
  };
}
