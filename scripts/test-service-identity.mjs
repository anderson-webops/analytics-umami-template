import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const unit = readFileSync(new URL('../deploy/systemd/umami@.service', import.meta.url), 'utf8');
const directives = new Map(
  [...unit.matchAll(/^([A-Za-z][A-Za-z0-9]*)=(.*)$/gm)].map(([, name, value]) => [name, value]),
);

test('isolated instances use distinct non-root service identities', () => {
  assert.equal(directives.get('User'), 'umami-%i');
  assert.equal(directives.get('Group'), 'umami-%i');

  for (const instance of ['ballot', 'np-service']) {
    const username = directives.get('User').replaceAll('%i', instance);
    const groupname = directives.get('Group').replaceAll('%i', instance);

    assert.equal(username, groupname);
    assert.match(username, /^umami-[a-z][a-z0-9-]{0,24}$/);
  }

  assert.notEqual(
    directives.get('User').replaceAll('%i', 'ballot'),
    directives.get('User').replaceAll('%i', 'np-service'),
  );
});

test('instance runtime, environment, and writable cache remain scoped', () => {
  assert.equal(directives.get('WorkingDirectory'), '/srv/umami/%i/current');
  assert.equal(directives.get('EnvironmentFile'), '/etc/umami/%i.env');
  assert.equal(
    directives.get('ReadWritePaths'),
    '-/srv/umami/%i/current/.next/standalone/.next/cache',
  );
  assert.equal(directives.get('ProtectSystem'), 'strict');
  assert.equal(directives.get('NoNewPrivileges'), 'true');
});
