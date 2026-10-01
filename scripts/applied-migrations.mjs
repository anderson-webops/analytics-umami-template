const publishedFinalizer = {
  name: '25_finalize_session_data_index_rebuild',
  currentChecksum: '5b2483cc6abeebc482c48411da790cda22e8c75828b305e9d58a1c7394279f4b',
  priorChecksum: 'f0cc6caeef1b1b586513b1f52f1a5d5dd71d2f6d5f03279bcfb751690044f282',
};

// Inspect every Prisma attempt. Query order must never choose the authoritative row.
export function verifyAppliedMigrations(releaseMigrations, appliedMigrations, { requireAll }) {
  const attemptsByName = new Map();

  for (const attempt of appliedMigrations) {
    const attempts = attemptsByName.get(attempt.migration_name) ?? [];
    attempts.push(attempt);
    attemptsByName.set(attempt.migration_name, attempts);
  }

  const issues = new Set();
  const successfulNames = new Set();

  for (const [name, attempts] of attemptsByName) {
    if (!releaseMigrations.has(name)) {
      issues.add('unknown');
      continue;
    }

    let successes = 0;
    for (const attempt of attempts) {
      const finished = attempt.finished_at != null;
      const rolledBack = attempt.rolled_back_at != null;

      if (finished && rolledBack) {
        issues.add('invalid');
      } else if (rolledBack) {
        // Explicitly resolved failures are historical evidence, not applications.
        // Their checksum may differ from the later successful retry.
      } else if (!finished) {
        issues.add('unresolved');
      } else {
        successes += 1;
        const releaseChecksum = releaseMigrations.get(name);
        const compatiblePriorFinalizer =
          name === publishedFinalizer.name &&
          releaseChecksum === publishedFinalizer.currentChecksum &&
          attempt.checksum === publishedFinalizer.priorChecksum;
        if (attempt.checksum !== releaseChecksum && !compatiblePriorFinalizer) issues.add('drift');
      }
    }

    if (successes > 1) issues.add('ambiguous');
    if (successes === 1) successfulNames.add(name);
  }

  // Fixed priority and messages keep both the outcome and diagnostics order-independent.
  // Never echo database-provided names, checksums, timestamps, logs, or connection details.
  const errors = {
    unknown:
      'Database migration history contains an unknown migration. Refusing to apply pending migrations or start from an older or incomplete source tree.',
    invalid: 'Database migration history contains contradictory completion and rollback states.',
    unresolved: 'Database migration history contains an unfinished or unresolved attempt.',
    drift: 'A successful database migration checksum does not match this release.',
    ambiguous:
      'Database migration history contains multiple successful attempts for one migration.',
  };

  for (const [issue, message] of Object.entries(errors)) {
    if (issues.has(issue)) throw new Error(message);
  }

  if (requireAll && [...releaseMigrations.keys()].some(name => !successfulNames.has(name))) {
    throw new Error('A required database migration has no successful application.');
  }
}
