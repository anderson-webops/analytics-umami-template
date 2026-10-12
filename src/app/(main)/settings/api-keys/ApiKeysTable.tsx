import { Button, Column, DataColumn, DataTable, Text } from '@umami/react-zen';
import { DateDistance } from '@/components/common/DateDistance';
import { EmptyPlaceholder } from '@/components/common/EmptyPlaceholder';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { type ApiKeyData, useApiKeysQuery, useMessages } from '@/components/hooks';
import { KeyRound } from '@/components/icons';
import { ApiKeyDeleteButton } from './ApiKeyDeleteButton';

export function ApiKeysTable() {
  const { t, labels, messages } = useMessages();
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useApiKeysQuery();
  const keys = data?.pages.flat() ?? [];

  return (
    <LoadingPanel
      data={keys}
      isLoading={isLoading}
      error={error}
      isEmpty={!keys.length}
      renderEmpty={() => (
        <EmptyPlaceholder icon={<KeyRound />} description={t(messages.noApiKeys)} />
      )}
    >
      <Column gap="3">
        <DataTable data={keys}>
          <DataColumn id="name" label={t(labels.name)} />
          <DataColumn id="keyPrefix" label={t(labels.apiKey)}>
            {(row: ApiKeyData) => <code>{row.keyPrefix}…</code>}
          </DataColumn>
          <DataColumn id="createdAt" label={t(labels.created)}>
            {(row: ApiKeyData) => <DateDistance date={new Date(row.createdAt)} />}
          </DataColumn>
          <DataColumn id="lastUsedAt" label={t(labels.lastUsed)}>
            {(row: ApiKeyData) =>
              row.lastUsedAt ? (
                <DateDistance date={new Date(row.lastUsedAt)} />
              ) : (
                <Text color="muted">{t(labels.never)}</Text>
              )
            }
          </DataColumn>
          <DataColumn id="action" label=" " align="end" width="48px">
            {(row: ApiKeyData) => <ApiKeyDeleteButton keyId={row.id} name={row.name} />}
          </DataColumn>
        </DataTable>
        {hasNextPage && (
          <Button variant="outline" isDisabled={isFetchingNextPage} onPress={() => fetchNextPage()}>
            {t(labels.more)}
          </Button>
        )}
      </Column>
    </LoadingPanel>
  );
}
