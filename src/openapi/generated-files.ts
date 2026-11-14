import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

async function inspect(file: string) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Generated output must be a regular file: ${file}`);
    return { bytes: await readFile(file), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, mode: 0o644 };
    throw error;
  }
}

export async function writeGeneratedContracts(
  projectRoot: string,
  outputs: ReadonlyMap<string, string>,
  existingFiles: readonly string[],
) {
  const apiRoot = await realpath(path.join(projectRoot, 'src', 'app', 'api'));
  const normalized = new Map(
    [...outputs].map(([file, content]) => [path.resolve(projectRoot, file), content]),
  );
  if (normalized.size !== outputs.size) throw new Error('Duplicate generated output paths.');
  const files = [
    ...new Set([
      ...normalized.keys(),
      ...existingFiles.map(file => path.resolve(projectRoot, file)),
    ]),
  ].sort();
  const before = new Map<string, Awaited<ReturnType<typeof inspect>>>();
  for (const file of files) {
    const parent = await realpath(path.dirname(file));
    const relative = path.relative(apiRoot, parent);
    if (
      path.basename(file) !== 'contract.generated.ts' ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`Generated output is outside the API contract scope: ${file}`);
    }
    before.set(file, await inspect(file));
  }

  const runRoot = path.join(projectRoot, '.ai-work', 'runs');
  await mkdir(runRoot, { recursive: true });
  const transaction = await mkdtemp(path.join(runRoot, 'openapi-contracts-'));
  const changed: string[] = [];
  let retainRecovery = false;
  try {
    const manifest = [];
    for (const [index, file] of files.entries()) {
      const original = before.get(file);
      const content = normalized.get(file);
      if (original.bytes !== null)
        await writeFile(path.join(transaction, `before-${index}`), original.bytes);
      if (content !== undefined) {
        const staged = path.join(transaction, `after-${index}`);
        await writeFile(staged, content);
        await chmod(staged, original.mode);
      }
      manifest.push({
        path: file,
        mode: original.mode,
        existed: original.bytes !== null,
        beforeSha256:
          original.bytes === null
            ? null
            : createHash('sha256').update(original.bytes).digest('hex'),
        afterSha256:
          content === undefined ? null : createHash('sha256').update(content).digest('hex'),
      });
    }
    await writeFile(
      path.join(transaction, 'manifest.json'),
      JSON.stringify({ state: 'prepared', files: manifest }, null, 2),
    );
    for (const file of files) {
      const original = before.get(file);
      const current = await inspect(file);
      if (
        current.mode !== original.mode ||
        (current.bytes === null) !== (original.bytes === null) ||
        (current.bytes !== null && !current.bytes.equals(original.bytes))
      ) {
        throw new Error(`Generated output changed during preparation: ${file}`);
      }
    }
    for (const [index, file] of files.entries()) {
      changed.push(file);
      if (normalized.has(file)) await rename(path.join(transaction, `after-${index}`), file);
      else await rm(file, { force: true });
    }
  } catch (error) {
    const recoveryErrors: unknown[] = [];
    for (const file of changed.reverse()) {
      try {
        const original = before.get(file);
        if (original.bytes === null) await rm(file, { force: true });
        else {
          const restored = path.join(transaction, `restore-${files.indexOf(file)}`);
          await copyFile(path.join(transaction, `before-${files.indexOf(file)}`), restored);
          await chmod(restored, original.mode);
          await rename(restored, file);
        }
      } catch (recoveryError) {
        recoveryErrors.push(recoveryError);
      }
    }
    if (recoveryErrors.length) {
      retainRecovery = true;
      throw new AggregateError(
        [error, ...recoveryErrors],
        `Generated contract recovery requires review: ${transaction}`,
      );
    }
    throw error;
  } finally {
    if (!retainRecovery) await rm(transaction, { recursive: true, force: true });
  }
}
