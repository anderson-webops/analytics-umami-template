import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { selectNpmSeed } from './build-toolchain-seed.mjs';

const scratch = path.resolve(import.meta.dirname, '../.ai-work/runs/npm-seed-fixtures');
mkdirSync(scratch, { recursive: true });

function fixture(callback) {
  const directory = mkdtempSync(path.join(scratch, 'seed-'));
  const nodePath = path.join(directory, 'bin/node');
  const npmRoot = path.join(directory, 'node_modules/npm');
  const npmCli = path.join(npmRoot, 'bin/npm-cli.js');
  mkdirSync(path.dirname(nodePath), { recursive: true });
  mkdirSync(path.dirname(npmCli), { recursive: true });
  writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm' }));
  writeFileSync(npmCli, 'throw Error("The selector must not execute a candidate")');
  try {
    callback({ directory, nodePath, npmRoot, npmCli });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test('a native pnpm npm_execpath selects paired npm without parsing or executing ELF bytes', () => {
  fixture(({ directory, nodePath, npmCli }) => {
    const nativePnpm = path.join(directory, 'pnpm');
    writeFileSync(nativePnpm, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    assert.equal(selectNpmSeed({ nodePath, npmExecpath: nativePnpm }), npmCli);
  });
});

test('the explicit npm CLI and a JavaScript pnpm launcher retain correct selection', () => {
  fixture(({ directory, nodePath, npmCli }) => {
    assert.equal(selectNpmSeed({ nodePath, npmExecpath: npmCli }), npmCli);
    const pnpmCli = path.join(directory, 'pnpm.cjs');
    writeFileSync(pnpmCli, 'throw Error("Do not run pnpm as npm")');
    assert.equal(selectNpmSeed({ nodePath, npmExecpath: pnpmCli }), npmCli);
  });
});

test('a normal global npm symlink remains a supported bootstrap seed', () => {
  fixture(({ directory, npmRoot, npmCli }) => {
    const relocated = path.join(directory, 'global/lib/node_modules/npm');
    mkdirSync(path.dirname(relocated), { recursive: true });
    symlinkSync(npmRoot, relocated);
    const executable = path.join(directory, 'global/bin/npm');
    mkdirSync(path.dirname(executable), { recursive: true });
    symlinkSync(path.join(relocated, 'bin/npm-cli.js'), executable);
    assert.equal(
      selectNpmSeed({ nodePath: path.join(directory, 'global/bin/node'), npmExecpath: '' }),
      npmCli,
    );
  });
});

test('Windows Node installations select their bundled JavaScript npm CLI', () => {
  fixture(({ directory, npmCli }) => {
    assert.equal(
      selectNpmSeed({
        nodePath: path.join(directory, 'node.exe'),
        npmExecpath: '',
        platform: 'win32',
      }),
      npmCli,
    );
  });
});

test('missing npm and another package impersonating npm-cli.js fail closed', () => {
  fixture(({ nodePath, npmRoot, npmCli }) => {
    writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'pnpm' }));
    assert.throws(() => selectNpmSeed({ nodePath, npmExecpath: npmCli }), /JavaScript npm CLI/);
    rmSync(npmCli);
    assert.throws(() => selectNpmSeed({ nodePath, npmExecpath: '' }), /JavaScript npm CLI/);
  });
});
