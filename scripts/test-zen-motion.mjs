import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const parentEntry = require.resolve('@umami/react-zen');
const parentRoot = path.dirname(path.dirname(parentEntry));
const parentRequire = createRequire(parentEntry);

async function packageMetadata(name, consumer = parentRequire) {
  let directory = path.dirname(consumer.resolve(name));
  for (;;) {
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return { directory, metadata };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, `Package metadata not found: ${name}`);
    directory = parent;
  }
}

test('the reviewed Zen parent uses the supported React19 animation major', async () => {
  const parent = JSON.parse(await fs.readFile(path.join(parentRoot, 'package.json'), 'utf8'));
  assert.equal(parent.version, '0.255.0');
  assert.equal(parent.dependencies['@react-spring/web'], '^9.7.5');
  const { metadata } = await packageMetadata('@react-spring/web');
  assert.equal(metadata.version, '10.1.2');
  for (const name of ['react', 'react-dom']) {
    assert.match(metadata.peerDependencies[name], /\^19\.0\.0/);
  }
  const policy = await fs.readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(policy, /@react-spring\/(?:animated|core|shared|web)@9\.7\.5>/);
});

for (const name of ['animated', 'core', 'rafz', 'shared', 'types', 'web']) {
  test(`the ${name} animation package stays on the same supported major`, async () => {
    const web = await packageMetadata('@react-spring/web');
    const webConsumer = createRequire(path.join(web.directory, 'package.json'));
    const owner =
      name === 'rafz' ? await packageMetadata('@react-spring/shared', webConsumer) : web;
    const consumer = createRequire(path.join(owner.directory, 'package.json'));
    const { metadata } = await packageMetadata(`@react-spring/${name}`, consumer);
    assert.equal(metadata.version, '10.1.2');
    if (metadata.peerDependencies?.react) {
      assert.match(metadata.peerDependencies.react, /\^19\.0\.0/);
    }
  });
}

test('Base UI uses the latest compatible minor through the original supported range', async () => {
  const parent = JSON.parse(await fs.readFile(path.join(parentRoot, 'package.json'), 'utf8'));
  assert.equal(parent.dependencies['@base-ui/react'], '^1.8.0');
  const { metadata } = await packageMetadata('@base-ui/react');
  assert.equal(metadata.version, '1.9.0');
  assert.match(metadata.peerDependencies.react, /\^19/);
});

for (const filename of ['index.js', 'index.mjs']) {
  test(`${filename} retains only the reviewed animation entrypoints`, async () => {
    const source = await fs.readFile(path.join(parentRoot, 'dist', filename), 'utf8');
    const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const members = new Set();
    let dependencyImports = 0;
    const visit = node => {
      if (ts.isStringLiteral(node) && node.text === '@react-spring/web') {
        dependencyImports += 1;
        const parent = node.parent;
        if (ts.isImportDeclaration(parent)) {
          for (const element of parent.importClause.namedBindings.elements) {
            members.add(element.propertyName?.text ?? element.name.text);
          }
        } else {
          assert.equal(parent.expression.getText(syntax), 'require');
        }
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(syntax) === 'web') {
        members.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    assert.equal(dependencyImports, 1);
    assert.deepEqual([...members].sort(), ['animated', 'useTransition']);
    assert.match(source, /useTransition\(toasts,/);
    assert.match(source, /useTransition\(theme,/);
  });

  test(`${filename} preserves server rendering, controls and animation wrappers`, async () => {
    const entry = path.join(parentRoot, 'dist', filename);
    const parent = filename.endsWith('.mjs') ? await import(pathToFileURL(entry)) : require(entry);
    const markup = renderToStaticMarkup(
      React.createElement(
        parent.ZenProvider,
        { colorScheme: 'light' },
        React.createElement(parent.ThemeButton, { 'aria-label': 'Change theme' }),
        React.createElement(parent.Button, { type: 'submit', disabled: true }, 'Save'),
      ),
    );
    assert.match(markup, /aria-label="Change theme"/);
    assert.match(markup, /lucide-(sun|moon)/);
    assert.match(markup, /type="submit"/);
    assert.match(markup, /disabled=""/);
    assert.match(markup, /aria-label="Notifications"/);
  });
}
