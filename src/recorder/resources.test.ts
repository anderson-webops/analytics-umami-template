import { expect, test } from 'vitest';
import { createReplayResourceRedactor } from './resources';

test('removes resource URLs before snapshots and mutations leave the browser', () => {
  const redact = createReplayResourceRedactor();
  const snapshot = {
    type: 2,
    timestamp: 1,
    data: {
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'img',
            attributes: {
              alt: 'Photo? #1',
              class: 'preview',
              src: 'https://assets.example/photo?token=snapshot-secret',
              srcset: '/photo?token=srcset-secret 2x',
              'data-resource-url': 'https://assets.example/?token=data-secret',
              style: 'color:red;background:u\\72l(/photo?token=style-secret)',
            },
            childNodes: [],
          },
          {
            type: 2,
            id: 3,
            tagName: 'style',
            attributes: {},
            childNodes: [
              {
                type: 3,
                id: 4,
                textContent: '@import "https://assets.example/?token=css-secret"',
              },
            ],
          },
        ],
      },
    },
  };
  const mutation = {
    type: 3,
    timestamp: 2,
    data: {
      source: 0,
      adds: [],
      attributes: [
        { id: 2, attributes: { poster: '/photo?token=mutation-secret', 'data-state': 'open' } },
      ],
      texts: [
        { id: 4, value: 'body{background:url(/photo?token=text-secret)}' },
        { id: 5, value: 'Visible text' },
      ],
    },
  };

  const safeSnapshot = redact(snapshot);
  const safeMutation = redact(mutation);
  const serialized = JSON.stringify([safeSnapshot, safeMutation]);

  expect(serialized).not.toMatch(/snapshot-secret|srcset-secret|data-secret|style-secret/);
  expect(serialized).not.toMatch(/css-secret|mutation-secret|text-secret/);
  expect(safeSnapshot.data.node.childNodes[0].attributes).toMatchObject({
    alt: 'Photo? #1',
    class: 'preview',
  });
  expect(safeMutation.data.attributes[0].attributes).toEqual({ 'data-state': 'open' });
  expect(safeMutation.data.texts[1].value).toBe('Visible text');
  expect(snapshot.data.node.childNodes[0].attributes.src).toContain('snapshot-secret');
});

test('drops CSSOM resource references while retaining ordinary inline layout', () => {
  const redact = createReplayResourceRedactor();
  const events = [
    {
      type: 3,
      data: {
        source: 8,
        adds: [
          { rule: 'body{display:grid;color:red}' },
          { rule: 'body{background:image-set("/photo?token=cssom-secret" 1x)}' },
        ],
      },
    },
    { type: 3, data: { source: 13, set: { property: 'background', value: 'url(/private)' } } },
    {
      type: 3,
      data: { source: 15, styles: [{ rules: [{ rule: '@import url(/private)' }] }] },
    },
  ];
  const safe = events.map(redact);

  expect(JSON.stringify(safe)).not.toMatch(/cssom-secret|\/private/);
  expect(safe[0].data.adds[0].rule).toBe('body{display:grid;color:red}');
  expect(safe[0].data.adds[1].rule).toBe('');
  expect(safe[1].data.set.value).toBe('');
  expect(safe[2].data.styles[0].rules[0].rule).toBe('');
});

test('preserves safe style mutations and removals without retaining URL values', () => {
  const redact = createReplayResourceRedactor();
  const event = {
    type: 3,
    data: {
      source: 0,
      adds: [],
      attributes: [
        {
          id: 2,
          attributes: {
            style: {
              color: ['red', 'important'],
              background: 'url(/private?token=style-secret)',
              display: false,
              'bad?property': 'red',
            },
          },
        },
      ],
      texts: [],
    },
  };

  const safe = redact(event);

  expect(safe.data.attributes[0].attributes.style).toEqual({
    color: ['red', 'important'],
    display: false,
  });
  expect(JSON.stringify(safe)).not.toContain('style-secret');
});

test('drops escaped CSS URLs when style context is in a prior chunk', () => {
  const redact = createReplayResourceRedactor();
  const safe = redact({
    type: 3,
    data: {
      source: 0,
      adds: [],
      attributes: [],
      texts: [
        { id: 9, value: 'body{background:u\\72l(/private?token=escaped-secret)}' },
        { id: 10, value: 'Visible ordinary text' },
      ],
    },
  });

  expect(JSON.stringify(safe)).not.toContain('escaped-secret');
  expect(safe.data.texts[1].value).toBe('Visible ordinary text');
});
