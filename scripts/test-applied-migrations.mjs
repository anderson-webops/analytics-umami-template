import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAppliedMigrations } from './applied-migrations.mjs';

const checksum = 'a'.repeat(64);
const migrations = new Map([['16_boards', checksum]]);
const success = {
  migration_name: '16_boards',
  checksum,
  finished_at: new Date(2),
  rolled_back_at: null,
};
const rollback = {
  ...success,
  checksum: 'b'.repeat(64),
  finished_at: null,
  rolled_back_at: new Date(1),
};
const pending = { ...success, finished_at: null };
const drift = { ...success, checksum: 'c'.repeat(64) };
const unknown = { ...success, migration_name: 'private-database-name\n'.repeat(1000) };
const contradictory = { ...success, rolled_back_at: new Date(3) };

function* permutations(rows) {
  if (rows.length === 0) yield [];
  for (let index = 0; index < rows.length; index += 1) {
    for (const rest of permutations(rows.filter((_, i) => i !== index))) {
      yield [rows[index], ...rest];
    }
  }
}

test('every subset and permutation of success, rollback, pending, unknown, and drift is deterministic', () => {
  const fixtures = [success, rollback, pending, unknown, drift, contradictory];
  let checked = 0;
  for (let mask = 0; mask < 2 ** fixtures.length; mask += 1) {
    const subset = fixtures.filter((_, index) => mask & (1 << index));
    for (const requireAll of [false, true]) {
      const acceptable =
        subset.every(row => row === success || row === rollback) &&
        (!requireAll || subset.includes(success));
      let expectedError;
      for (const rows of permutations(subset)) {
        const before = structuredClone(rows);
        if (acceptable) {
          assert.doesNotThrow(() => verifyAppliedMigrations(migrations, rows, { requireAll }));
        } else {
          assert.throws(
            () => verifyAppliedMigrations(migrations, rows, { requireAll }),
            error => {
              assert.ok(error.message.length < 200);
              assert.ok(!error.message.includes('private-database-name'));
              expectedError ??= error.message;
              assert.equal(error.message, expectedError);
              return true;
            },
          );
        }
        assert.deepEqual(rows, before, 'validation must preserve every historical attempt');
        checked += 1;
      }
    }
  }
  assert.equal(checked, 3914);
});

test('multiple successful attempts are ambiguous even with identical checksums', () => {
  for (const rows of permutations([success, { ...success }, rollback])) {
    for (const requireAll of [false, true]) {
      assert.throws(
        () => verifyAppliedMigrations(migrations, rows, { requireAll }),
        /multiple successful/,
      );
    }
  }
});

test('multiple rolled-back attempts and one successful retry are accepted in every order', () => {
  for (const rows of permutations([success, rollback, { ...rollback, checksum }])) {
    verifyAppliedMigrations(migrations, rows, { requireAll: true });
  }
});

test('unknown attempts are rejected in every state, including rolled back', () => {
  for (const state of [success, rollback, pending, contradictory]) {
    assert.throws(
      () =>
        verifyAppliedMigrations(migrations, [{ ...state, migration_name: 'unknown' }], {
          requireAll: false,
        }),
      /unknown migration/,
    );
  }
});

test('a missing or rollback-only application may be retried before migration but never starts', () => {
  for (const rows of [[], [rollback], [rollback, { ...rollback }]]) {
    verifyAppliedMigrations(migrations, rows, { requireAll: false });
    assert.throws(
      () => verifyAppliedMigrations(migrations, rows, { requireAll: true }),
      /no successful/,
    );
  }
});
