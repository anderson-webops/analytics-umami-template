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
