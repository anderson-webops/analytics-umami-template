import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

test('legacy event revenue materialization stays absent from the runtime', () => {
  const source = path.join(process.cwd(), 'src/queries/sql/events');
  expect(existsSync(path.join(source, 'saveEvent.ts'))).toBe(true);
  expect(existsSync(path.join(source, 'saveRevenue.ts'))).toBe(false);
  expect(readFileSync(path.join(source, 'saveEvent.ts'), 'utf8')).not.toMatch(
    /from ['"]\.\/saveRevenue['"]/,
  );
});
