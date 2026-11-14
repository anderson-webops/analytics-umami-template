import ts from 'typescript';
import { expect, test } from 'vitest';
import { analyzeSourceOperation } from './source-analysis';

function infer(permission: string, argument = 'auth') {
  const source = ts.createSourceFile(
    'route.ts',
    `
    export async function GET(request: Request) {
      const { auth } = await parseRequest(request);
      if (!await ${permission}(${argument}, 'entity')) return unauthorized();
      return json({});
    }
  `,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return analyzeSourceOperation(source, 'get').auth;
}
test.each([
  'canViewAuthenticatedWebsite',
  'canViewAllWebsites',
  'canViewAllTeams',
  'canViewUser',
  'canViewUsers',
  'canViewTeam',
  'canViewTeamSubscription',
  'canViewBoardEntities',
  'canViewUnknownResource',
])('%s does not advertise a share credential', permission => {
  expect(infer(permission)).toBe('bearer');
});

test.each([
  'canViewWebsite',
  'canViewWebsiteSection',
  'canViewWebsiteSectionRows',
  'canViewSharedWebsite',
  'canViewSharedWebsiteFilters',
  'canViewWebsiteAnnotations',
  'canViewSavedWebsiteSegments',
  'canViewBatchWebsites',
  'canViewReport',
  'canViewBoard',
  'canViewLink',
  'canViewPixel',
])('%s retains supported share authentication metadata', permission => {
  expect(infer(permission)).toBe('bearer-or-share');
});

test.each(['{ user: auth.user }', '{ ...auth, shareToken: undefined }', '{ shareToken: null }'])(
  'explicit removal of share authority remains bearer-only: %s',
  argument => expect(infer('canViewWebsite', argument)).toBe('bearer'),
);
test.each(['{ shareToken: auth.shareToken }', '{ ...auth }'])(
  'explicit share authority remains represented: %s',
  argument => expect(infer('canViewWebsite', argument)).toBe('bearer-or-share'),
);
