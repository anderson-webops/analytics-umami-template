import { expect, test } from 'vitest';
import { operations } from './contract';

function schemaFor(method: string) {
  const contract = operations.find(operation => operation.method === method);
  const response = contract?.operation.responses?.['200'];
  if (!response) throw new Error(`Missing ${method} team response contract`);
  return (
    response as {
      content: {
        'application/json': {
          schema: {
            properties: Record<string, { type: string | string[] }>;
            required: string[];
          };
        };
      };
    }
  ).content['application/json'].schema;
}

test.each(['get', 'post'])('%s documents an optional invitation code', method => {
  const schema = schemaFor(method);

  expect(schema.properties.accessCode.type).toEqual(['string', 'null']);
  expect(schema.required).not.toContain('accessCode');
});

test.each(['get', 'post'])('%s nullable metadata follows the persisted team schema', method => {
  const schema = schemaFor(method);

  for (const field of ['logoUrl', 'createdAt', 'updatedAt', 'deletedAt']) {
    expect(schema.properties[field].type).toEqual(['string', 'null']);
  }
});

test('the maintained update contract retains route name and invitation-code constraints', () => {
  const update = operations.find(operation => operation.method === 'post');
  const body = update?.operation.requestBody as {
    content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
  };
  const properties = body.content['application/json'].schema.properties;

  expect(properties.name).toMatchObject({ type: 'string', minLength: 1, maxLength: 50 });
  expect(properties.accessCode).toMatchObject({
    type: 'string',
    pattern: '^team_[A-Za-z0-9]{16}$',
  });
});
