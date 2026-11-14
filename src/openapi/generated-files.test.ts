import * as fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { writeGeneratedContracts } from './generated-files';

const faults = vi.hoisted(() => ({
  renameCount: 0,
  failRenameAt: 0,
  failRestore: false,
  failRemove: '',
  changedFile: '',
  changeOnPrepare: false,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: async (source: string, target: string) => {
      faults.renameCount++;
      if (
        faults.renameCount === faults.failRenameAt ||
        (faults.failRestore && path.basename(source).startsWith('restore-'))
      ) {
        throw new Error('Synthetic rename failure');
      }
      return actual.rename(source, target);
    },
    rm: async (target: string, options: any) => {
      if (target === faults.failRemove) {
        faults.failRemove = '';
        throw new Error('Synthetic removal failure');
      }
      return actual.rm(target, options);
    },
    writeFile: async (file: string, data: any, options: any) => {
      const result = await actual.writeFile(file, data, options);
      if (faults.changeOnPrepare && path.basename(file) === 'manifest.json') {
        await actual.writeFile(faults.changedFile, 'concurrent-owner-progress');
      }
      return result;
    },
  };
});
let project: string;
let first: string;
let second: string;
beforeEach(async () => {
  Object.assign(faults, {
    renameCount: 0,
    failRenameAt: 0,
    failRestore: false,
    failRemove: '',
    changedFile: '',
    changeOnPrepare: false,
  });
  const runs = path.join(process.cwd(), '.ai-work', 'runs');
  await fs.mkdir(runs, { recursive: true });
  project = await fs.mkdtemp(path.join(runs, 'generated-files-test-'));
  const api = path.join(project, 'src', 'app', 'api');
  await fs.mkdir(path.join(api, 'first'), { recursive: true });
  await fs.mkdir(path.join(api, 'second'), { recursive: true });
  first = path.join(api, 'first', 'contract.generated.ts');
  second = path.join(api, 'second', 'contract.generated.ts');
  await fs.writeFile(first, 'first-before');
  await fs.writeFile(second, 'second-before');
});
afterEach(async () => {
  faults.failRestore = false;
  faults.failRemove = '';
  faults.changeOnPrepare = false;
  await fs.rm(project, { recursive: true, force: true });
});

test('publishes every validated output, removes obsolete contracts and preserves modes', async () => {
  await fs.chmod(first, 0o640);
  await writeGeneratedContracts(project, new Map([[first, 'first-after']]), [first, second]);
  expect(await fs.readFile(first, 'utf8')).toBe('first-after');
  expect((await fs.stat(first)).mode & 0o777).toBe(0o640);
  await expect(fs.readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(path.join(project, '.ai-work', 'runs'))).toEqual([]);
});

test('a failed promotion restores every prior byte and removes newly created outputs', async () => {
  await fs.rm(second);
  faults.failRenameAt = 2;
  await expect(
    writeGeneratedContracts(
      project,
      new Map([
        [first, 'after'],
        [second, 'new'],
      ]),
      [first],
    ),
  ).rejects.toThrow('Synthetic rename failure');
  expect(await fs.readFile(first, 'utf8')).toBe('first-before');
  await expect(fs.readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readdir(path.join(project, '.ai-work', 'runs'))).toEqual([]);
});

test('obsolete-file removal failure restores previously promoted files', async () => {
  faults.failRemove = second;
  await expect(
    writeGeneratedContracts(project, new Map([[first, 'after']]), [first, second]),
  ).rejects.toThrow('Synthetic removal failure');
  expect(await fs.readFile(first, 'utf8')).toBe('first-before');
  expect(await fs.readFile(second, 'utf8')).toBe('second-before');
});

test('failed recovery retains durable exact backups and a reviewable manifest', async () => {
  faults.failRenameAt = 2;
  faults.failRestore = true;
  await expect(
    writeGeneratedContracts(
      project,
      new Map([
        [first, 'after'],
        [second, 'after'],
      ]),
      [first, second],
    ),
  ).rejects.toBeInstanceOf(AggregateError);
  const [directory] = await fs.readdir(path.join(project, '.ai-work', 'runs'));
  const recovery = path.join(project, '.ai-work', 'runs', directory);
  expect(await fs.readFile(path.join(recovery, 'before-0'), 'utf8')).toBe('first-before');
  expect(await fs.readFile(path.join(recovery, 'before-1'), 'utf8')).toBe('second-before');
  const manifest = JSON.parse(await fs.readFile(path.join(recovery, 'manifest.json'), 'utf8'));
  expect(manifest.files).toHaveLength(2);
  expect(manifest.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.beforeSha256))).toBe(true);
});

test('a concurrent source change is preserved instead of overwritten', async () => {
  faults.changedFile = first;
  faults.changeOnPrepare = true;
  await expect(
    writeGeneratedContracts(project, new Map([[first, 'after']]), [first]),
  ).rejects.toThrow('changed during preparation');
  expect(await fs.readFile(first, 'utf8')).toBe('concurrent-owner-progress');
  expect(await fs.readFile(second, 'utf8')).toBe('second-before');
});

test('handwritten contracts and outside paths are rejected before mutation', async () => {
  const manual = path.join(path.dirname(first), 'contract.ts');
  await fs.writeFile(manual, 'curated');
  const outside = path.join(project, 'contract.generated.ts');
  await fs.writeFile(outside, 'outside');
  for (const file of [manual, outside]) {
    await expect(writeGeneratedContracts(project, new Map([[file, 'after']]), [])).rejects.toThrow(
      'outside the API contract scope',
    );
  }
  expect(await fs.readFile(manual, 'utf8')).toBe('curated');
  expect(await fs.readFile(outside, 'utf8')).toBe('outside');
});

test('file and parent symlinks cannot redirect generated writes', async () => {
  const outside = path.join(project, 'outside');
  await fs.mkdir(outside);
  const target = path.join(outside, 'contract.generated.ts');
  await fs.writeFile(target, 'outside');
  await fs.rm(first);
  await fs.symlink(target, first);
  await expect(writeGeneratedContracts(project, new Map([[first, 'after']]), [])).rejects.toThrow(
    'regular file',
  );
  await fs.symlink(outside, path.join(project, 'src', 'app', 'api', 'linked'));
  await expect(
    writeGeneratedContracts(
      project,
      new Map([
        [path.join(project, 'src', 'app', 'api', 'linked', 'contract.generated.ts'), 'after'],
      ]),
      [],
    ),
  ).rejects.toThrow('outside the API contract scope');
  expect(await fs.readFile(target, 'utf8')).toBe('outside');
});
