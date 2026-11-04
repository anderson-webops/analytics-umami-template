import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

for (const existing of [false, true]) {
  test(`${existing ? 'existing' : 'new'} component metadata uses the maintained dependency graph`, async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'analytics-component-dependencies-'));
    try {
      await writeFile(path.join(fixture, 'package.json'), JSON.stringify(source));
      await mkdir(path.join(fixture, 'bin'));
      await writeFile(path.join(fixture, 'bin/npm'), '#!/bin/sh\nprintf "0.12.0\\n"\n', {
        mode: 0o755,
      });
      if (existing) {
        await mkdir(path.join(fixture, 'dist'));
        await writeFile(
          path.join(fixture, 'dist/package.json'),
          JSON.stringify({
            name: '@example/components',
            version: '0.12.0',
            description: 'Retained package identity',
            dependencies: { 'react-window': '^1.8.6', 'additional-component': '^1.0.0' },
          }),
        );
      }
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/bump-components.js')], {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: `${path.join(fixture, 'bin')}${path.delimiter}${process.env.PATH}`,
        },
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const built = JSON.parse(await readFile(path.join(fixture, 'dist/package.json'), 'utf8'));
      assert.equal(built.version, '0.13.0');
      for (const name of [
        'react-simple-maps',
        'react-window',
        'uuid',
        'chart.js',
        'lucide-react',
      ]) {
        assert.equal(built.dependencies[name], source.dependencies[name]);
      }
      if (existing) {
        assert.equal(built.name, '@example/components');
        assert.equal(built.description, 'Retained package identity');
        assert.equal(built.dependencies['additional-component'], '^1.0.0');
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
}
