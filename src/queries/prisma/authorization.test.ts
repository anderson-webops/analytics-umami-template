import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const transaction = vi.fn();

vi.mock('@/lib/prisma', () => ({
  default: {
    transaction,
  },
}));

const {
  runAuthorizedAdministratorMutation,
  runSerializable,
  runSerializedUserMutation,
  SERIALIZABLE_RETRY_ATTEMPTS,
} = await import('./authorization');

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

function rawQuerySerializationConflict() {
  return Object.assign(new Error('Raw query serialization conflict'), {
    code: 'P2010',
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: '40001',
          kind: 'TransactionWriteConflict',
        },
      },
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

  test('retries a nested PostgreSQL raw-query serialization conflict', async () => {
    transaction.mockRejectedValueOnce(rawQuerySerializationConflict()).mockResolvedValueOnce('ok');

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('takes the transaction-scoped user lock before running the mutation', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]);
    const operation = vi.fn().mockResolvedValue('ok');

    transaction.mockImplementationOnce(
      async (
        callback: (client: { $queryRaw: typeof queryRaw }) => Promise<unknown>,
        options: unknown,
      ) => {
        expect(options).toEqual({ isolationLevel: 'Serializable', timeout: 45_000 });

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

  test('retries ownership races without skipping the user-mutation lock', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: '' }]);
    const operation = vi.fn().mockResolvedValue('ok');

    transaction
      .mockRejectedValueOnce(serializationConflict())
      .mockImplementationOnce(async callback => callback({ $queryRaw: queryRaw }));

    const result = runSerializedUserMutation(operation);

    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(queryRaw).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe('runAuthorizedAdministratorMutation', () => {
  beforeEach(() => {
    transaction.mockReset();
  });

  test('rechecks the current administrator after taking the user-mutation lock', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ allowed: 1 }]);
    const operation = vi.fn().mockResolvedValue('updated');
    transaction.mockImplementation(async callback => callback({ $queryRaw: queryRaw }));

    await expect(runAuthorizedAdministratorMutation('admin-1', operation)).resolves.toBe('updated');
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queryRaw.mock.calls[1][0].join('')).toContain('FOR UPDATE');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[1]);
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      operation.mock.invocationCallOrder[0],
    );
  });

  test('does not run the mutation after administrator demotion', async () => {
    const operation = vi.fn();
    transaction.mockImplementation(async callback =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([]),
      }),
    );

    await expect(runAuthorizedAdministratorMutation('admin-1', operation)).rejects.toThrow(
      'ENTITY_ADMIN_REQUIRED',
    );
    expect(operation).not.toHaveBeenCalled();
  });

  test('rejects a missing actor identifier before querying an administrator', async () => {
    const operation = vi.fn();
    const queryRaw = vi.fn().mockResolvedValue([]);
    transaction.mockImplementation(async callback => callback({ $queryRaw: queryRaw }));

    await expect(runAuthorizedAdministratorMutation('', operation)).rejects.toThrow(
      'ENTITY_ADMIN_REQUIRED',
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });
});
