import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Ellipsis,
  GripVertical,
  Minus,
  Monitor,
  Moon,
  Plus,
  Search,
  Sun,
  X,
} from 'lucide-react';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const parentEntry = require.resolve('@umami/react-zen');
const parentRoot = path.dirname(path.dirname(parentEntry));
const parentRequire = createRequire(parentEntry);
const icons = {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Ellipsis,
  GripVertical,
  Minus,
  Monitor,
  Moon,
  Plus,
  Search,
  Sun,
  X,
};
const iconNames = Object.keys(icons).sort();

function consumedIcons(source, filename) {
  const syntax = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const namespaces = new Set(['lucide_react_star', 'lucide_react_star__namespace']);
  const consumed = new Set();
  let imports = 0;
  let copies = 0;
  const visit = node => {
    if (ts.isStringLiteral(node) && node.text === 'lucide-react') {
      const parent = node.parent;
      assert.ok(
        (ts.isImportDeclaration(parent) &&
          ts.isNamespaceImport(parent.importClause?.namedBindings) &&
          parent.importClause.namedBindings.name.text === 'lucide_react_star') ||
          (ts.isCallExpression(parent) && parent.expression.getText(syntax) === 'require'),
        'Lucide must enter through the reviewed namespace only',
      );
      imports += 1;
    }
    if (ts.isIdentifier(node) && (namespaces.has(node.text) || node.text === 'icons_exports')) {
      const parent = node.parent;
      if (
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isNamespaceImport(parent) && parent.name === node)
      ) {
        if (node.text === 'icons_exports') {
          assert.ok(ts.isObjectLiteralExpression(parent.initializer));
          assert.equal(parent.initializer.properties.length, 0);
        }
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        assert.equal(node.text, 'icons_exports');
        consumed.add(parent.name.text);
      } else if (ts.isCallExpression(parent)) {
        if (parent.expression.getText(syntax) === '_interopNamespace') {
          assert.equal(node.text, 'lucide_react_star');
          assert.equal(parent.arguments.length, 1);
        } else {
          assert.equal(parent.expression.getText(syntax), '__reExport');
          assert.equal(parent.arguments.length, 2);
          assert.equal(parent.arguments[0].getText(syntax), 'icons_exports');
          assert.ok(namespaces.has(parent.arguments[1].getText(syntax)));
          if (node.text === 'icons_exports') copies += 1;
        }
      } else {
        assert.fail(`Unreviewed Lucide namespace use: ${parent.getText(syntax)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  assert.equal(imports, 1);
  assert.equal(copies, 1);
  return [...consumed].sort();
}

test('the version-bound Zen dependency resolves the same modern Lucide as the application', async () => {
  const parent = JSON.parse(await fs.readFile(path.join(parentRoot, 'package.json'), 'utf8'));
  assert.equal(parent.version, '0.255.0');
  assert.equal(parent.dependencies['lucide-react'], '^0.555.0');
  assert.equal(parentRequire('lucide-react/package.json').version, '1.70.0');
  assert.equal(parentRequire.resolve('lucide-react'), require.resolve('lucide-react'));
});

for (const filename of ['index.js', 'index.mjs']) {
  test(`${filename} consumes only the reviewed static Lucide members`, async () => {
    const source = await fs.readFile(path.join(parentRoot, 'dist', filename), 'utf8');
    assert.deepEqual(consumedIcons(source, filename), iconNames);
    assert.throws(() => consumedIcons(`${source}\nconsume(icons_exports);`, filename));
    assert.throws(() => consumedIcons(`${source}\nicons_exports[name];`, filename));
    assert.throws(() => consumedIcons(`${source}\nexport * from 'lucide-react';`, filename));
  });
}

for (const name of iconNames) {
  test(`${name} retains SVG sizing, stroke, accessibility and child forwarding`, () => {
    const icon = icons[name];
    assert.ok(icon, name);
    const markup = renderToStaticMarkup(
      React.createElement(
        icon,
        {
          size: 30,
          color: 'currentColor',
          strokeWidth: 3,
          absoluteStrokeWidth: true,
          role: 'img',
          'aria-label': name,
          'data-testid': name,
        },
        React.createElement('title', null, name),
      ),
    );
    const document = new JSDOM(markup).window.document;
    const svg = document.querySelector('svg');
    assert.equal(svg?.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('width'), '30');
    assert.equal(svg.getAttribute('height'), '30');
    assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
    assert.equal(svg.getAttribute('stroke-width'), '2.4');
    assert.equal(svg.getAttribute('stroke'), 'currentColor');
    assert.equal(svg.getAttribute('aria-label'), name);
    assert.equal(svg.getAttribute('aria-hidden'), null);
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('data-testid'), name);
    assert.equal(svg.querySelector('title')?.textContent, name);
    assert.ok(svg.querySelector('path, circle, line, polyline, polygon, rect, ellipse'));
    assert.match(renderToStaticMarkup(React.createElement(icon)), /aria-hidden="true"/);
    document.defaultView.close();
  });
}

for (const filename of ['index.js', 'index.mjs']) {
  test(`${filename} preserves Zen public exports and internally rendered icons`, async () => {
    const entry = path.join(parentRoot, 'dist', filename);
    const parent = filename.endsWith('.mjs') ? await import(pathToFileURL(entry)) : require(entry);
    const exports = Object.keys(parent)
      .filter(name => name !== 'default')
      .sort();
    assert.equal(exports.length, 316);
    assert.equal(
      crypto.createHash('sha256').update(exports.join('\n')).digest('hex'),
      '74c7c711611dfa4144ce476fa468d22330b5ef7b600acddf93a751a98e3dadc3',
    );
    const declarations = await fs.readFile(path.join(parentRoot, 'dist/index.d.ts'), 'utf8');
    assert.doesNotMatch(declarations, /lucide-react/);
    for (const [component, iconClass] of [
      ['BreadcrumbEllipsis', 'lucide-ellipsis'],
      ['PaginationPrevious', 'lucide-chevron-left'],
      ['PaginationNext', 'lucide-chevron-right'],
      ['PaginationEllipsis', 'lucide-ellipsis'],
      ['SearchField', 'lucide-search'],
    ]) {
      const markup = renderToStaticMarkup(React.createElement(parent[component]));
      assert.match(markup, new RegExp(`class="[^"]*${iconClass}`));
      assert.match(markup, /<svg[^>]*aria-hidden="true"/);
    }
    for (const [size, classes] of [
      ['xs', 'w-3 h-3'],
      ['sm', 'w-4 h-4'],
      ['md', 'w-5 h-5'],
      ['lg', 'w-6 h-6'],
      ['xl', 'w-8 h-8'],
    ]) {
      const markup = renderToStaticMarkup(
        React.createElement(parent.Icon, { size }, React.createElement(icons.Check)),
      );
      assert.ok(markup.includes(classes), size);
    }
  });
}

test('modern Zen icons preserve browser refs and click handling', async () => {
  const browser = new JSDOM('<div id="root"></div>', { url: 'https://example.invalid' });
  const saved = new Map();
  for (const [name, value] of Object.entries({
    window: browser.window,
    document: browser.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const root = createRoot(browser.window.document.getElementById('root'));
  const reference = React.createRef();
  let clicks = 0;
  try {
    await act(async () => {
      root.render(
        React.createElement(
          require('@umami/react-zen').Icon,
          { size: 'lg' },
          React.createElement(icons.Search, {
            ref: reference,
            'aria-label': 'Search',
            onClick: () => {
              clicks += 1;
            },
          }),
        ),
      );
    });
    assert.equal(reference.current?.tagName, 'svg');
    assert.match(reference.current.getAttribute('class'), /w-6 h-6/);
    await act(async () => {
      reference.current.dispatchEvent(new browser.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(clicks, 1);
    await act(async () => {
      root.unmount();
    });
    assert.equal(reference.current, null);
  } finally {
    if (reference.current)
      await act(async () => {
        root.unmount();
      });
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    browser.window.close();
  }
});
