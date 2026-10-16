import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checksum } from '../src/migrate';
import { loadMigrationsFromDir } from '../src/node';

/**
 * testdata/migration-checksums.json is what the C# Migrator is tested against. If a migration file changes, this
 * fails: regenerate with `npm run vectors` (and remember that a migration already applied in a shop must NOT change).
 */
describe('migration checksums shared with C#', () => {
  const golden = JSON.parse(
    readFileSync(new URL('../../../testdata/migration-checksums.json', import.meta.url), 'utf8'),
  ) as { migrations: { version: number; name: string; checksum: string }[] };

  it('match the files in packages/db/migrations', () => {
    const actual = loadMigrationsFromDir().map((m) => ({
      version: m.version,
      name: m.name,
      checksum: checksum(m.sql),
    }));
    expect(actual).toEqual(golden.migrations);
  });
});
