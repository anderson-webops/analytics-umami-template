import { afterEach, expect, test } from 'vitest';
import { flags, getDefaultFlagValues } from './flag-definitions';

afterEach(() => {
  delete flags['synthetic-flag'];
});

test('default flag values remain available without evaluating a server request', () => {
  expect(getDefaultFlagValues()).toEqual({});
});

test('default values reflect the same registry exposed to the server evaluator', () => {
  flags['synthetic-flag'] = Object.assign(async () => true, {
    key: 'synthetic-flag',
    defaultValue: false,
  }) as never;

  expect(getDefaultFlagValues()).toEqual({ 'synthetic-flag': false });
});
