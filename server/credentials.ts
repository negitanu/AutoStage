import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CredentialStatus } from '../shared/schema.js';

// Credentials never belong to Settings, Run, SQLite snapshots, or API responses.
export function credentials(directory: string, env: NodeJS.ProcessEnv = process.env) {
  const file = path.join(directory, 'credentials.json');
  const saved = (): string | undefined => {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')).openRouterApiKey || undefined;
  };
  return {
    get: () => env.OPENROUTER_API_KEY?.trim() || saved(),
    status: (): CredentialStatus => ({
      openRouterKeySource: env.OPENROUTER_API_KEY?.trim()
        ? 'environment'
        : saved()
          ? 'saved'
          : 'none',
    }),
    update(key?: string, clear = false) {
      if (clear) {
        if (existsSync(file)) unlinkSync(file);
      } else if (key?.trim()) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify({ openRouterApiKey: key.trim() }), {
            mode: 0o600,
            flag: 'wx',
          });
          renameSync(temporary, file);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      }
    },
  };
}
