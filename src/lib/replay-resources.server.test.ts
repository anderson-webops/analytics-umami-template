import { expect, test } from 'vitest';
import { sanitizeReplayResourceEvents } from './replay-resources.server';

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
          tagName: 'html',
          attributes: {},
          childNodes: [
            {
              type: 2,
              id: 3,
              tagName: 'head',
              attributes: {},
              childNodes: [
                {
                  type: 2,
                  id: 4,
                  tagName: 'style',
                  attributes: {},
                  childNodes: [
                    {
                      type: 3,
                      id: 5,
                      textContent:
                        'body{color:red;background:u\\72l(https://attacker.invalid/style)}',
                    },
                  ],
                },
                {
                  type: 2,
                  id: 6,
                  tagName: 'link',
                  attributes: {
                    href: 'https://attacker.invalid/sheet.css',
                    rel: 'stylesheet',
                    _cssText: '@import "https://attacker.invalid/import.css";main{display:grid}',
                  },
                  childNodes: [],
                },
              ],
            },
            {
              type: 2,
              id: 7,
              tagName: 'body',
              attributes: { class: 'page', style: 'color:blue;background:url(/private)' },
              childNodes: [
                {
                  type: 2,
                  id: 8,
                  tagName: 'img',
                  attributes: {
                    src: 'https://attacker.invalid/beacon',
                    srcset: 'https://attacker.invalid/large 2x',
                    alt: 'Recorded image',
                    width: 100,
                  },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 9,
                  tagName: 'iframe',
                  attributes: { srcdoc: '<img src="https://attacker.invalid/nested">' },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 10,
                  tagName: 'svg',
                  isSVG: true,
                  attributes: { fill: 'url(https://attacker.invalid/svg)', viewBox: '0 0 10 10' },
                  childNodes: [],
                },
                {
                  type: 2,
                  id: 11,
                  tagName: 'meta',
                  attributes: { 'http-equiv': 'refresh', content: '0;url=/private' },
                  childNodes: [],
                },
              ],
            },
          ],
        },
      ],
    },
    initialOffset: { left: 0, top: 0 },
  },
};

test('removes resource loads from a full snapshot while retaining safe layout', () => {
  const [safe] = sanitizeReplayResourceEvents([snapshot]);
  const [head, body] = safe.data.node.childNodes[0].childNodes;

  expect(head.childNodes[0].childNodes[0].textContent).toContain('color: red');
  expect(head.childNodes[0].childNodes[0].textContent).not.toContain('attacker.invalid');
  expect(head.childNodes[1].attributes._cssText).toContain('display: grid');
  expect(head.childNodes[1].attributes._cssText).not.toContain('attacker.invalid');
  expect(head.childNodes[1].attributes.href).toBeUndefined();
  expect(body.attributes.class).toBe('page');
  expect(body.attributes.style).toContain('color: #00f');
  expect(body.attributes.style).not.toContain('/private');
  expect(body.childNodes[0].attributes).toMatchObject({ alt: 'Recorded image', width: 100 });
  expect(body.childNodes[0].attributes.src).toBeUndefined();
  expect(body.childNodes[0].attributes.srcset).toBeUndefined();
  expect(body.childNodes[1].attributes.srcdoc).toBeUndefined();
  expect(body.childNodes[2].attributes.fill).toBeUndefined();
  expect(body.childNodes[2].attributes.viewBox).toBe('0 0 10 10');
  expect(body.childNodes[3].tagName).toBe('span');
  expect(JSON.stringify(snapshot)).toContain('https://attacker.invalid/beacon');
});

test('neutralizes later DOM, CSSOM, font and unknown resource events', () => {
  const events = [
    snapshot,
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [
          {
            parentId: 7,
            nextId: null,
            node: {
              type: 2,
              id: 12,
              tagName: 'img',
              attributes: { rr_dataURL: 'https://attacker.invalid/data', src: '/private' },
              childNodes: [],
            },
          },
        ],
        attributes: [
          {
            id: 8,
            attributes: { src: '/private', style: { background: 'url(/private)', color: 'red' } },
          },
        ],
        texts: [{ id: 5, value: '@import url(https://attacker.invalid/text);body{margin:0}' }],
        removes: [],
      },
    },
    {
      type: 3,
      timestamp: 3,
      data: {
        source: 8,
        id: 4,
        adds: [{ index: 0, rule: 'a{background:image-set("https://attacker.invalid/image" 1x)}' }],
      },
    },
    {
      type: 3,
      timestamp: 4,
      data: {
        source: 13,
        id: 4,
        index: [0],
        set: { property: 'background', value: 'url(/private)' },
      },
    },
    {
      type: 3,
      timestamp: 5,
      data: {
        source: 15,
        id: 1,
        styleIds: [1],
        styles: [
          { styleId: 1, rules: [{ rule: 'a{background:url(https://attacker.invalid/adopted)}' }] },
        ],
      },
    },
    { type: 3, timestamp: 6, data: { source: 10, family: 'evil', fontSource: '/private' } },
    { type: 3, timestamp: 7, data: { source: 17, url: '/private' } },
    { type: 7, timestamp: 8, data: { url: '/private' } },
  ];
  const safe = sanitizeReplayResourceEvents(events);

  expect(safe).toHaveLength(5);
  expect(safe[1].data.adds[0].node.attributes.src).toBeUndefined();
  expect(safe[1].data.adds[0].node.attributes.rr_dataURL).toBeUndefined();
  expect(safe[1].data.attributes[0].attributes.src).toBeUndefined();
  expect(safe[1].data.attributes[0].attributes.style.color).toBe('red');
  expect(safe[1].data.attributes[0].attributes.style.background).not.toContain('/private');
  expect(safe[1].data.texts[0].value).toContain('margin: 0');
  expect(safe[1].data.texts[0].value).not.toContain('attacker.invalid');
  expect(safe[2].data.adds[0].rule).not.toContain('attacker.invalid');
  expect(safe[3].data.set.value).not.toContain('/private');
  expect(safe[4].data.styles[0].rules[0].rule).not.toContain('attacker.invalid');
});

test('keeps inline raster images and ordinary non-resource replay events', () => {
  const inlineImage = 'data:image/png;base64,iVBORw0KGgo=';
  const safe = sanitizeReplayResourceEvents([
    { type: 4, timestamp: 0, data: { width: 800, height: 600 } },
    {
      ...snapshot,
      data: {
        ...snapshot.data,
        node: {
          ...snapshot.data.node,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'img',
              attributes: { src: inlineImage, rr_dataURL: inlineImage, alt: 'Safe image' },
              childNodes: [],
            },
          ],
        },
      },
    },
    { type: 3, timestamp: 2, data: { source: 2, id: 2, x: 50, y: 75 } },
  ]);

  expect(safe[0].data).toEqual({ width: 800, height: 600 });
  expect(safe[1].data.node.childNodes[0].attributes).toMatchObject({
    src: inlineImage,
    rr_dataURL: inlineImage,
    alt: 'Safe image',
  });
  expect(safe[2].data).toEqual({ source: 2, id: 2, x: 50, y: 75 });
});

test('sanitizes text added to an inlined link stylesheet', () => {
  const safe = sanitizeReplayResourceEvents([
    snapshot,
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [
          {
            parentId: 6,
            nextId: null,
            node: {
              type: 3,
              id: 20,
              textContent: 'body{background:url(https://attacker.invalid/link-text)}',
            },
          },
        ],
        attributes: [],
        texts: [],
        removes: [],
      },
    },
  ]);

  expect(safe[1].data.adds[0].node.textContent).not.toContain('attacker.invalid');
});

test('sanitizes style children even when added before their parent', () => {
  const safe = sanitizeReplayResourceEvents([
    snapshot,
    {
      type: 3,
      timestamp: 2,
      data: {
        source: 0,
        adds: [
          {
            parentId: 21,
            nextId: null,
            node: { type: 3, id: 22, textContent: 'body{background:url(/private)}' },
          },
          {
            parentId: 3,
            nextId: null,
            node: { type: 2, id: 21, tagName: 'style', attributes: {}, childNodes: [] },
          },
        ],
        attributes: [],
        texts: [],
        removes: [],
      },
    },
  ]);

  expect(safe[1].data.adds[0].node.textContent).not.toContain('/private');
});

test('keeps non-fetching SVG paint colors', () => {
  const paint = {
    ...snapshot,
    data: {
      ...snapshot.data,
      node: {
        type: 0,
        id: 1,
        childNodes: [
          {
            type: 2,
            id: 2,
            tagName: 'circle',
            isSVG: true,
            attributes: { fill: '#ff0000', stroke: 'blue' },
            childNodes: [],
          },
        ],
      },
    },
  };

  const [safe] = sanitizeReplayResourceEvents([paint]);

  expect(safe.data.node.childNodes[0].attributes).toEqual({ fill: '#ff0000', stroke: 'blue' });
});
