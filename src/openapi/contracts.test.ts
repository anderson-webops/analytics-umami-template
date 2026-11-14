import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadApiContracts } from './contracts';

let project: string;
let directory: string;
beforeEach(async () => {
  const runs = path.join(process.cwd(), '.ai-work', 'runs');
  await fs.mkdir(runs, { recursive: true });
  project = await fs.mkdtemp(path.join(runs, 'contract-loader-test-'));
  directory = path.join(project, 'src', 'app', 'api', 'fixture');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'contract.ts'),
    'export const operations = [{ method: "get", path: "/api/manual", audience: "public", auth: "none", operation: { responses: { 200: { description: "ok" } } } }];',
  );
});
afterEach(async () => fs.rm(project, { recursive: true, force: true }));

test('source-only generation ignores stale generated modules without changing them', async () => {
  const file = path.join(directory, 'contract.generated.ts');
  const bytes = 'throw new Error("synthetic stale contract"); export const operations = [];';
  await fs.writeFile(file, bytes);
  expect(await loadApiContracts(project, { includeGenerated: false })).toMatchObject([
    { path: '/api/manual', source: 'src/app/api/fixture/contract.ts', origin: 'explicit' },
  ]);
  expect(await fs.readFile(file, 'utf8')).toBe(bytes);
  await expect(loadApiContracts(project)).rejects.toThrow('synthetic stale contract');
});

test('normal document loading continues including valid generated contracts', async () => {
  await fs.writeFile(
    path.join(directory, 'contract.generated.ts'),
    'export const operations = [{ method: "get", path: "/api/generated", audience: "public", auth: "none", operation: { responses: { 200: { description: "ok" } } } }];',
  );
  const contracts = await loadApiContracts(project);
  expect(contracts.map(contract => contract.path).sort()).toEqual([
    '/api/generated',
    '/api/manual',
  ]);
});
