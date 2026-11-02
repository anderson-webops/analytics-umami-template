import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { transform } = require('@svgr/core');
const svgo = require('@svgr/plugin-svgo');
const jsx = require('@svgr/plugin-jsx');
const prettier = require('@svgr/plugin-prettier');
const assets = fileURLToPath(new URL('../src/assets/', import.meta.url));
const components = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../src/components/svg/', import.meta.url));

const filenames = (await readdir(assets)).filter(filename => filename.endsWith('.svg')).sort();
await mkdir(components, { recursive: true });
for (const filename of filenames) {
  const filePath = join(assets, filename);
  const basename = filename.slice(0, -4);
  const component = basename
    .split('-')
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('');
  const code = transform.sync(
    await readFile(filePath, 'utf8'),
    { typescript: true },
    {
      filePath,
      caller: { name: '@svgr/cli', defaultPlugins: [svgo, jsx, prettier] },
    },
  );
  const target = join(components, `${component}.tsx`);
  if ((await readFile(target, 'utf8').catch(() => null)) !== code) {
    await writeFile(target, code);
  }
}
