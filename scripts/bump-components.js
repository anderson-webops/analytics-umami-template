import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const distDir = path.resolve(process.cwd(), 'dist');
const packageFile = path.join(distDir, 'package.json');
const sourcePackage = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
);
const componentDependencies = Object.fromEntries(
  [
    'chart.js',
    'chartjs-adapter-date-fns',
    'colord',
    'jsonwebtoken',
    'lucide-react',
    'react-simple-maps',
    'react-window',
    'thenby',
    'uuid',
  ].map(name => {
    const version = sourcePackage.dependencies?.[name];
    if (typeof version !== 'string' || !version) {
      throw new Error(`The source dependency ${name} is missing.`);
    }
    return [name, version];
  }),
);

const defaultPackage = {
  name: '@umami/components',
  version: '0.0.0',
  description: 'Umami React components.',
  author: 'Mike Cao <mike@mikecao.com>',
  license: 'MIT',
  type: 'module',
  main: './index.js',
  types: './index.d.ts',
  dependencies: componentDependencies,
};

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir);
}

const pkg = fs.existsSync(packageFile)
  ? JSON.parse(fs.readFileSync(packageFile, 'utf8'))
  : defaultPackage;

if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(pkg.name)) {
  throw new Error('Package name is invalid.');
}

pkg.dependencies = { ...pkg.dependencies, ...componentDependencies };

const published = execFileSync('npm', ['view', pkg.name, 'version'], {
  encoding: 'utf8',
}).trim();
const [major, minor] = published.split('.').map(Number);
const next = `${major}.${minor + 1}.0`;

pkg.version = next;

fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Bumped ${pkg.name} version: ${published} -> ${next}`);
