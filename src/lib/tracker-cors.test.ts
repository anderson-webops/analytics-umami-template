import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const allowedHeaders = 'Content-Type, X-Umami-Cache, X-Umami-Hostname';

describe('tracker cross-origin requests', () => {
  test('every collection route accepts every header emitted by the tracker', () => {
    const trackerSource = fs.readFileSync(
      path.join(repositoryRoot, 'src/tracker/index.js'),
      'utf8',
    );

    expect(trackerSource).toContain("'x-umami-hostname': hostname");

    for (const configurationFile of ['docker/proxy.ts', 'next.config.ts']) {
      const configurationSource = fs.readFileSync(
        path.join(repositoryRoot, configurationFile),
        'utf8',
      );

      expect(configurationSource).toContain(allowedHeaders);
    }
  });
});
