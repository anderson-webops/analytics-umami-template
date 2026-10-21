import { expect, test } from 'vitest';
import { maskStrictReplayEvents } from '@/recorder/privacy';

test('strict masking retains replay structure but no submitted text or attributes', () => {
  const raw = [
    {
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
              tagName: 'div',
              attributes: { title: 'private-title', class: 'private-class' },
              childNodes: [{ type: 3, id: 3, textContent: 'private-text' }],
            },
          ],
        },
      },
    },
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 5,
        id: 2,
        text: 'private-input',
        value: 123456,
        privateField: 'private-field',
      },
    },
    { type: 5, data: { payload: { privateKey: 'private-key' } } },
  ];

  const masked = maskStrictReplayEvents(raw);
  const serialized = JSON.stringify(masked);

  expect(serialized).not.toContain('private');
  expect(serialized).not.toContain('123456');
  expect(masked[0]).toMatchObject({
    type: 2,
    data: {
      node: { childNodes: [{ tagName: 'div', attributes: {}, childNodes: [{ textContent: '' }] }] },
    },
  });
  expect(raw[0].data.node.childNodes[0].attributes.title).toBe('private-title');
});

test('unrecognized tag and field names cannot carry private values', () => {
  const masked = maskStrictReplayEvents([
    {
      type: 2,
      data: { node: { type: 2, tagName: 'private-tag', secretField: 888, attributes: {} } },
    },
  ]);

  expect(masked[0].data.node.tagName).toBe('div');
  expect(JSON.stringify(masked)).not.toContain('private');
  expect(JSON.stringify(masked)).not.toContain('888');
});

test('masked snapshots keep safe headings and replace unsafe tags with constructible elements', () => {
  const masked = maskStrictReplayEvents([
    {
      type: 2,
      data: {
        node: {
          type: 0,
          childNodes: [
            { type: 2, tagName: 'h1', attributes: {}, childNodes: [] },
            { type: 2, tagName: 'private-custom-tag', attributes: {}, childNodes: [] },
            { type: 2, tagName: 123, attributes: {}, childNodes: [] },
          ],
        },
      },
    },
  ]);
  const childNodes = masked[0].data.node.childNodes;

  expect(childNodes.map(node => node.tagName)).toEqual(['h1', 'div', 'div']);
  for (const node of childNodes) {
    expect(() => document.createElement(node.tagName)).not.toThrow();
  }
  expect(JSON.stringify(masked)).not.toContain('private');
});

test('strict masking removes numeric and nested input values', () => {
  const masked = maskStrictReplayEvents([
    { type: 3, data: { value: [123456, { text: 7890 }], textContent: 2468 } },
  ]);

  expect(masked).toEqual([{ type: 3, data: { value: '', textContent: '' } }]);
});

test('strict masking does not store a checkbox or radio answer', () => {
  const masked = maskStrictReplayEvents([
    { type: 3, data: { id: 4, isChecked: true, value: 'yes' } },
  ]);

  expect(masked).toEqual([{ type: 3, data: { id: 4, value: '' } }]);
});
