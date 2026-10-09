import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { sanitizeReplayResourceEvents } from '../src/lib/replay-resources.server.ts';

const rrwebScript = fileURLToPath(
  new URL('../node_modules/rrweb/dist/rrweb.umd.cjs', import.meta.url),
);

const events = [
  { type: 4, timestamp: 1, data: { width: 800, height: 600 } },
  {
    type: 2,
    timestamp: 2,
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
                        textContent: 'body{color:red;background:url(https://attacker.invalid/css)}',
                      },
                    ],
                  },
                  {
                    type: 2,
                    id: 11,
                    tagName: 'link',
                    attributes: { rel: 'stylesheet', _cssText: 'body{margin:0}' },
                    childNodes: [],
                  },
                ],
              },
              {
                type: 2,
                id: 6,
                tagName: 'body',
                attributes: { class: 'layout' },
                childNodes: [
                  {
                    type: 2,
                    id: 7,
                    tagName: 'img',
                    attributes: { src: 'https://attacker.invalid/image', alt: 'Recorded image' },
                    childNodes: [],
                  },
                  {
                    type: 2,
                    id: 8,
                    tagName: 'p',
                    attributes: {},
                    childNodes: [{ type: 3, id: 9, textContent: 'Replay content' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      initialOffset: { top: 0, left: 0 },
    },
  },
  {
    type: 3,
    timestamp: 3,
    data: {
      source: 0,
      texts: [],
      attributes: [],
      removes: [],
      adds: [
        {
          parentId: 6,
          nextId: null,
          node: {
            type: 2,
            id: 10,
            tagName: 'img',
            attributes: { src: 'https://attacker.invalid/mutation', alt: 'Later image' },
            childNodes: [],
          },
        },
      ],
    },
  },
  {
    type: 3,
    timestamp: 4,
    data: {
      source: 0,
      texts: [],
      attributes: [],
      removes: [],
      adds: [
        {
          parentId: 11,
          nextId: null,
          node: {
            type: 3,
            id: 12,
            textContent: 'body{background:url(https://attacker.invalid/link-text)}',
          },
        },
      ],
    },
  },
  {
    type: 3,
    timestamp: 5,
    data: {
      source: 0,
      texts: [],
      attributes: [],
      removes: [],
      adds: [
        {
          parentId: 13,
          nextId: null,
          node: {
            type: 3,
            id: 14,
            textContent: 'body{background:url(https://attacker.invalid/reversed)}',
          },
        },
        {
          parentId: 3,
          nextId: null,
          node: { type: 2, id: 13, tagName: 'style', attributes: {}, childNodes: [] },
        },
      ],
    },
  },
];

async function playEvents(browser, replayEvents) {
  const page = await browser.newPage();
  const requests = [];

  try {
    await page.route('**/*', route => {
      requests.push(route.request().url());
      return route.abort();
    });
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ path: rrwebScript });
    await page.evaluate(data => {
      const player = new window.rrweb.Replayer(data, {
        root: document.querySelector('#root'),
        showWarning: false,
        useVirtualDom: false,
      });
      player.play();
    }, replayEvents);
    await page.waitForFunction(
      () => document.querySelector('iframe')?.contentDocument?.querySelectorAll('img').length === 2,
    );
    await page.waitForTimeout(200);

    const state = await page.evaluate(() => {
      const body = document.querySelector('iframe')?.contentDocument?.body;

      return { className: body?.className, text: body?.textContent };
    });

    return { requests, state };
  } finally {
    await page.close();
  }
}

test('replay snapshots and later mutations cannot load viewer-browser resources', async () => {
  const browser = await chromium.launch({ headless: true });

  try {
    const raw = await playEvents(browser, events);
    const safe = await playEvents(browser, sanitizeReplayResourceEvents(events));

    for (const url of [
      'https://attacker.invalid/image',
      'https://attacker.invalid/mutation',
      'https://attacker.invalid/reversed',
    ]) {
      assert.ok(raw.requests.includes(url), `Unfiltered replay did not request ${url}`);
    }
    assert.deepEqual(safe.requests, []);
    assert.deepEqual(safe.state, { className: 'layout', text: 'Replay content' });
  } finally {
    await browser.close();
  }
});
