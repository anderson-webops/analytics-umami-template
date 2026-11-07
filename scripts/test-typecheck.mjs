import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const launcher = path.join(root, 'scripts/typecheck.mjs');

test('tracker bundling emits JavaScript without invalid compiler options', async () => {
  const fixture = await mkdtemp(path.join(root, 'public', '.tracker-typescript-'));
  const output = path.join(fixture, 'script.js');

  try {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/rollup/dist/bin/rollup'),
        '--config',
        path.join(root, 'rollup.tracker.config.js'),
        '--file',
        output,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(fixture, '.env'),
          COLLECT_API_HOST: '',
          COLLECT_API_ENDPOINT: '/api/send',
        },
        timeout: 20_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /\bTS\d+:/);
    const script = await readFile(output, 'utf8');
    assert.match(script, /\bumami\b/);
    assert.match(script, /\/api\/send/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('native TypeScript 7 checks valid code and rejects a real type error', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'analytics-native-typescript-'));
  const source = path.join(fixture, 'fixture.ts');

  try {
    const version = spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^Version 7\./);

    const args = [launcher, '--ignoreConfig', '--noEmit', '--skipLibCheck', source];
    await writeFile(source, 'export const numeric: number = 42;\n');
    const valid = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);

    await writeFile(source, 'export const numeric: number = "not a number";\n');
    const invalid = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stdout + invalid.stderr, /TS2322/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('compiler-API consumers retain their supported JavaScript compiler', () => {
  const compiler = require('typescript');
  const openapi = require('openapi-typescript/package.json');
  assert.equal(compiler.version, '6.0.3');
  assert.equal(typeof compiler.createSourceFile, 'function');
  assert.equal(typeof compiler.createProgram, 'function');
  assert.equal(typeof compiler.transpileModule, 'function');
  assert.equal(openapi.version, '7.13.0');
  assert.equal(openapi.peerDependencies.typescript, '^5.x');
  for (const consumer of [
    '@rollup/plugin-typescript',
    'tsup',
    'rollup-plugin-dts',
    'openapi-typescript',
    'next',
  ]) {
    const consumerRequire = createRequire(require.resolve(consumer));
    assert.equal(consumerRequire('typescript'), compiler, consumer);
  }
  for (const workspace of ['packages/api-client/package.json', 'packages/mcp/package.json']) {
    const workspaceRequire = createRequire(path.join(root, workspace));
    assert.equal(workspaceRequire('typescript'), compiler, workspace);
  }
});

test('OpenAPI compiler support is a version-scoped compatibility backport', async () => {
  const workspace = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(
    workspace,
    /^ {2}"openapi-typescript@7\.13\.0>typescript:peer": \^5\.x \|\| \^6\.x$/m,
  );
  assert.doesNotMatch(workspace, /peerDependencyRules|strictPeerDependencies:\s*false/);
  const prismaConfig = JSON.parse(await readFile(path.join(root, 'tsconfig.prisma.json')));
  assert.equal(prismaConfig.compilerOptions.module, 'ESNext');
  assert.equal(prismaConfig.compilerOptions.moduleResolution, 'Bundler');
});

function compilerDiagnostics(compiler, source, options = {}) {
  const program = compiler.createProgram([source], {
    noEmit: true,
    strict: true,
    target: compiler.ScriptTarget.ES2022,
    module: compiler.ModuleKind.ESNext,
    moduleResolution: compiler.ModuleResolutionKind.Bundler,
    types: [],
    ...options,
  });
  return compiler.getPreEmitDiagnostics(program);
}

function diagnosticText(compiler, diagnostics) {
  return diagnostics
    .map(diagnostic => compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    .join('\n');
}

test('JavaScript TypeScript 6 checks valid code and rejects a real type error', {
  timeout: 20_000,
}, async () => {
  const compiler = require('typescript');
  const fixture = await mkdtemp(path.join(root, '.ai-work', 'runs', 'typescript-api-'));
  const source = path.join(fixture, 'fixture.ts');
  try {
    assert.equal(compiler.version, '6.0.3');
    await writeFile(source, 'export const numeric: number = 42;\n');
    const valid = compilerDiagnostics(compiler, source);
    assert.equal(valid.length, 0, diagnosticText(compiler, valid));
    await writeFile(source, 'export const numeric: number = "not a number";\n');
    const invalid = compilerDiagnostics(compiler, source);
    assert.ok(invalid.some(diagnostic => diagnostic.code === 2322));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('OpenAPI AST and printer retain typed responses with the JavaScript compiler', {
  timeout: 20_000,
}, async () => {
  const compiler = require('typescript');
  const { default: openapiTS, astToString } = await import('openapi-typescript');
  const fixture = await mkdtemp(path.join(root, '.ai-work', 'runs', 'openapi-typescript-api-'));
  try {
    const nodes = await openapiTS({
      openapi: '3.1.0',
      info: { title: 'Synthetic compiler compatibility', version: '1.0.0' },
      paths: {
        '/widgets/{widgetId}': {
          get: {
            operationId: 'getWidget',
            parameters: [
              { name: 'widgetId', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: {
              200: {
                description: 'Synthetic widget',
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Widget' } },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Widget: {
            type: 'object',
            required: ['id', 'kind'],
            properties: {
              id: { type: 'integer' },
              kind: { type: 'string', enum: ['alpha', 'beta'] },
              tags: { type: 'array', items: { type: 'string' } },
              label: { type: ['string', 'null'] },
              variant: {
                oneOf: [{ type: 'string', enum: ['fast'] }, { type: 'integer' }],
              },
            },
          },
        },
      },
    });
    assert.ok(nodes.length > 0);
    const generated = astToString(nodes);
    const parsed = compiler.createSourceFile(
      'generated.ts',
      generated,
      compiler.ScriptTarget.ES2022,
      true,
    );
    assert.equal(parsed.parseDiagnostics.length, 0);
    await writeFile(path.join(fixture, 'generated.ts'), generated);
    const source = path.join(fixture, 'consumer.ts');
    const prefix =
      'import type { components, operations } from "./generated";\n' +
      'type Widget = components["schemas"]["Widget"];\n' +
      'type Response = operations["getWidget"]["responses"][200]["content"]["application/json"];\n';
    await writeFile(
      source,
      `${prefix}export const widget: Widget = { id: 7, kind: "alpha", tags: ["one"], label: null, variant: "fast" };\nexport const response: Response = widget;\nexport const otherResponse: Response = { id: 8, kind: "beta", variant: 2 };\n`,
    );
    const valid = compilerDiagnostics(compiler, source);
    assert.equal(valid.length, 0, diagnosticText(compiler, valid));
    for (const [payload, expectedCode] of [
      ['{ id: 7, kind: "other" }', 2322],
      ['{ kind: "alpha" }', 2741],
      ['{ id: 7, kind: "alpha", label: 42 }', 2322],
      ['{ id: 7, kind: "alpha", variant: false }', 2322],
    ]) {
      await writeFile(source, `${prefix}export const invalid: Response = ${payload};\n`);
      const diagnostics = compilerDiagnostics(compiler, source);
      assert.equal(diagnostics.length, 1, diagnosticText(compiler, diagnostics));
      const invalid = diagnostics[0];
      assert.equal(invalid.code, expectedCode);
      assert.equal(invalid.file?.fileName, source);
      assert.ok(invalid.start >= prefix.length);
      assert.equal(
        invalid.file.getLineAndCharacterOfPosition(invalid.start).line,
        prefix.split('\n').length - 1,
      );
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('built workspaces expose usable declarations through their public exports', {
  timeout: 20_000,
}, async () => {
  const compiler = require('typescript');
  const fixture = await mkdtemp(path.join(root, '.ai-work', 'runs', 'typescript-public-exports-'));
  const source = path.join(fixture, 'consumer.ts');
  try {
    const scope = path.join(fixture, 'node_modules', '@umami');
    await mkdir(scope, { recursive: true });
    for (const [name, directory] of [
      ['api-client', 'packages/api-client'],
      ['mcp', 'packages/mcp'],
    ]) {
      const packageRoot = path.join(root, directory);
      const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json')));
      await symlink(packageRoot, path.join(scope, name), 'dir');
      const resolved = compiler.resolveModuleName(
        `@umami/${name}`,
        source,
        { moduleResolution: compiler.ModuleResolutionKind.Bundler },
        compiler.sys,
      ).resolvedModule;
      assert.ok(resolved, `Missing public declarations for @umami/${name}`);
      assert.equal(
        await realpath(resolved.resolvedFileName),
        await realpath(path.join(packageRoot, manifest.exports['.'].types)),
      );
    }
    const imports =
      'import { UmamiClient } from "@umami/api-client";\n' +
      'import { createUmamiMcpServer } from "@umami/mcp";\n';
    const client =
      'export const client = new UmamiClient({ baseUrl: "https://analytics.example.com" });\n';
    const options = { types: ['node'], skipLibCheck: true };
    await writeFile(
      source,
      `${imports}${client}export const server = createUmamiMcpServer({ client, tools: [] });\nexport const request = client.getWebsiteStats({ websiteId: "site", startAt: 0, endAt: 1 });\n`,
    );
    const valid = compilerDiagnostics(compiler, source, options);
    assert.equal(valid.length, 0, diagnosticText(compiler, valid));
    for (const rejected of [
      'export const request = client.getWebsiteStats({ websiteId: 42, startAt: 0, endAt: 1 });\n',
      'export const server = createUmamiMcpServer({ client: "not a client" });\n',
    ]) {
      const prefix = `${imports}${client}`;
      await writeFile(source, prefix + rejected);
      const diagnostics = compilerDiagnostics(compiler, source, options);
      assert.equal(diagnostics.length, 1, diagnosticText(compiler, diagnostics));
      assert.equal(diagnostics[0].code, 2322);
      assert.equal(diagnostics[0].file?.fileName, source);
      assert.ok(diagnostics[0].start >= prefix.length);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('root and maintained workspace checks use the native compiler launcher', async () => {
  for (const relative of [
    'package.json',
    'packages/api-client/package.json',
    'packages/mcp/package.json',
  ]) {
    const manifest = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
    assert.match(
      manifest.scripts.typecheck,
      /^node (?:\.\.\/\.\.\/)?scripts\/typecheck\.mjs --noEmit$/,
    );
  }
});
