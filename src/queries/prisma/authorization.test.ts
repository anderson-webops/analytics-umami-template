import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const transaction = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction,
  },
}));

const { runSerializable, runSerializedUserMutation, SERIALIZABLE_RETRY_ATTEMPTS } = await import(
  './authorization'
);

function serializationConflict() {
  return Object.assign(new Error('Transaction write conflict'), { code: 'P2034' });
}

function adapterSerializationConflict() {
  return Object.assign(new Error('Transaction write conflict'), {
    name: 'DriverAdapterError',
    cause: {
      originalCode: '40001',
      originalMessage: 'could not serialize access due to read/write dependencies',
      kind: 'TransactionWriteConflict',
    },
  });
}

describe('runSerializable', () => {
  beforeEach(() => {
    transaction.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('backs off and retries a serialization conflict', async () => {
    transaction.mockRejectedValueOnce(serializationConflict()).mockResolvedValueOnce('ok');

    const result = runSerializable(async () => 'unused');

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('retries a PostgreSQL adapter serialization conflict', async () => {
    transaction.mockRejectedValueOnce(adapterSerializationConflict()).mockResolvedValueOnce('ok');

    const result = runSerializable(async () => 'unused');

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('does not retry a non-serialization failure', async () => {
    const failure = new Error('Database unavailable');
    transaction.mockRejectedValueOnce(failure);

    await expect(runSerializable(async () => 'unused')).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stops after the bounded retry limit', async () => {
    const conflict = serializationConflict();
    transaction.mockRejectedValue(conflict);

    const result = runSerializable(async () => 'unused');
    const assertion = expect(result).rejects.toBe(conflict);

    await vi.runAllTimersAsync();
    await assertion;

    expect(transaction).toHaveBeenCalledTimes(SERIALIZABLE_RETRY_ATTEMPTS);
  });
});

describe('runSerializedUserMutation', () => {
  beforeEach(() => {
    transaction.mockReset();
  });

  test('takes the transaction-scoped user lock before running the mutation', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]);
    const operation = vi.fn().mockResolvedValue('ok');

    transaction.mockImplementationOnce(
      async (
        callback: (client: { $queryRaw: typeof queryRaw }) => Promise<unknown>,
        options: unknown,
      ) => {
        expect(options).toEqual({ isolationLevel: 'ReadCommitted', timeout: 45_000 });

        return callback({ $queryRaw: queryRaw });
      },
    );

    await expect(runSerializedUserMutation(operation, { timeout: 45_000 })).resolves.toBe('ok');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      operation.mock.invocationCallOrder[0],
    );
  });
});
