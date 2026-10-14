import { expect, test } from 'vitest';
import type { Board } from '@/generated/prisma/client';
import { filterSharedBoardParameters } from './board-public';

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

test('public board parameters omit ungranted entity references and components', () => {
  const allowedWebsite = uuid(1);
  const deniedWebsite = uuid(2);
  const deniedPixel = uuid(3);
  const allowedColumn = {
    id: uuid(4),
    component: { type: 'WebsiteChart', websiteId: allowedWebsite },
  };
  const deniedColumn = {
    id: uuid(5),
    component: { type: 'WebsiteChart', websiteId: deniedWebsite },
  };
  const hiddenProps = {
    id: uuid(6),
    component: { type: 'WebsiteChart', websiteId: allowedWebsite, props: { pixelId: deniedPixel } },
  };
  const board = {
    type: 'mixed',
    parameters: {
      websiteId: deniedWebsite,
      pixelId: deniedPixel,
      rows: [{ id: uuid(7), columns: [allowedColumn, deniedColumn, hiddenProps] }],
    },
  } as unknown as Board;

  expect(filterSharedBoardParameters(board, { websiteIds: [allowedWebsite] })).toEqual({
    rows: [{ id: uuid(7), size: undefined, columns: [allowedColumn] }],
  });
});

test('public board parameters hide every component of an ungranted fixed-entity board', () => {
  const deniedWebsite = uuid(1);
  const board = {
    type: 'website',
    parameters: {
      websiteId: deniedWebsite,
      rows: [{ id: uuid(2), columns: [{ id: uuid(3), component: { type: 'WebsiteChart' } }] }],
    },
  } as unknown as Board;

  expect(filterSharedBoardParameters(board, {})).toEqual({
    rows: [{ id: uuid(2), size: undefined, columns: [] }],
  });
});

test('public board parameters omit nested and unsupported component configuration', () => {
  const allowedWebsite = uuid(1);
  const deniedWebsite = uuid(2);
  const validColumn = {
    id: uuid(3),
    component: {
      type: 'MetricsTable',
      websiteId: allowedWebsite,
      props: { type: 'country', limit: '5', params: { type: 'country', limit: '5' } },
    },
  };
  const board = {
    type: 'mixed',
    parameters: {
      websiteId: deniedWebsite,
      privateMetadata: { websiteId: deniedWebsite },
      rows: [
        {
          id: uuid(4),
          privateMetadata: { websiteId: deniedWebsite },
          columns: [
            validColumn,
            {
              id: uuid(5),
              component: {
                type: 'MetricsTable',
                websiteId: allowedWebsite,
                props: { type: 'country', params: { websiteId: deniedWebsite } },
              },
            },
            {
              id: uuid(6),
              component: {
                type: 'WebsiteChart',
                websiteId: allowedWebsite,
                props: { metadata: { websiteId: deniedWebsite } },
              },
            },
            {
              id: uuid(7),
              component: { type: 'TextBlock', props: { text: 'Public note' } },
            },
          ],
        },
      ],
    },
  } as unknown as Board;

  const result = filterSharedBoardParameters(board, { websiteIds: [allowedWebsite] });

  expect(result.rows?.[0].columns).toEqual([
    validColumn,
    {
      id: uuid(6),
      component: { type: 'WebsiteChart', websiteId: allowedWebsite, props: {} },
    },
    { id: uuid(7), component: { type: 'TextBlock', props: { text: 'Public note' } } },
  ]);
  expect(JSON.stringify(result)).not.toContain(deniedWebsite);
});

test('public board parameters project only declared column and component fields', () => {
  const allowedWebsite = uuid(1);
  const deniedWebsite = uuid(2);
  const board = {
    type: 'mixed',
    parameters: {
      websiteId: deniedWebsite,
      rows: [
        {
          id: uuid(3),
          columns: [
            {
              id: uuid(4),
              privateMetadata: { websiteId: deniedWebsite },
              component: {
                type: 'WebsiteChart',
                websiteId: allowedWebsite,
                privateMetadata: { websiteId: deniedWebsite },
              },
            },
          ],
        },
      ],
    },
  } as unknown as Board;

  const result = filterSharedBoardParameters(board, { websiteIds: [allowedWebsite] });

  expect(result.rows?.[0].columns).toEqual([
    { id: uuid(4), component: { type: 'WebsiteChart', websiteId: allowedWebsite } },
  ]);
  expect(JSON.stringify(result)).not.toContain(deniedWebsite);
});

test('public board parameters preserve selected string row limits and unusual component names', () => {
  const allowedWebsite = uuid(1);
  const board = {
    type: 'mixed',
    parameters: {
      rows: [
        {
          id: uuid(2),
          columns: [
            {
              id: uuid(3),
              component: {
                type: 'UTM',
                websiteId: allowedWebsite,
                props: { param: 'utm_source', limit: '10' },
              },
            },
            {
              id: uuid(4),
              component: { type: '__proto__', websiteId: allowedWebsite, props: {} },
            },
          ],
        },
      ],
    },
  } as unknown as Board;

  expect(
    filterSharedBoardParameters(board, { websiteIds: [allowedWebsite] }).rows?.[0].columns,
  ).toEqual([
    {
      id: uuid(3),
      component: {
        type: 'UTM',
        websiteId: allowedWebsite,
        props: { param: 'utm_source', limit: '10' },
      },
    },
    { id: uuid(4), component: { type: '__proto__', websiteId: allowedWebsite, props: {} } },
  ]);
});

test('public board parameters fail closed on malformed clone layout fields', () => {
  const deniedWebsite = uuid(1);
  const board = {
    type: 'mixed',
    parameters: {
      rows: [{ id: uuid(2), size: { websiteId: deniedWebsite }, columns: [] }],
    },
  } as unknown as Board;

  const result = filterSharedBoardParameters(board, {});

  expect(result).toEqual({
    rows: [{ id: uuid(2), size: undefined, columns: [] }],
  });
  expect(JSON.stringify(result)).not.toContain(deniedWebsite);
});
