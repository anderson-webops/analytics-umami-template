import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { selectedNpmCli } from './build-toolchain-state.mjs';

test('application and selected npm consumers resolve the maintained Picomatch archive', () => {
  const application = createRequire(import.meta.url);
  const tool = createRequire(selectedNpmCli());
  const bundler = createRequire(application.resolve('vite/package.json'));
  for (const [root, context] of [
    [application, bundler],
    [tool, tool],
  ]) {
    assert.equal(root('picomatch/package.json').version, '4.0.7-webops.1');
    const glob = createRequire(context.resolve('tinyglobby/package.json'));
    const directory = createRequire(glob.resolve('fdir/package.json'));
    for (const consumer of [glob, directory]) {
      assert.equal(consumer.resolve('picomatch'), root.resolve('picomatch'));
    }
  }
});
