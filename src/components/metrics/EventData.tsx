import { Column, Grid, Label, Row, Text } from '@umami/react-zen';
import { Badge } from '@/components/common/Badge';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useEventDataQuery } from '@/components/hooks';
import { COLLECTION_TRUST_TIER } from '@/lib/constants';

export function EventData({ websiteId, eventId }: { websiteId: string; eventId: string }) {
  const { data, isLoading, error } = useEventDataQuery(websiteId, eventId);

  return (
    <LoadingPanel isLoading={isLoading} error={error}>
      <Grid columns="1fr 1fr" gap="5">
        {data?.map(({ dataKey, stringValue, trustTier }) => {
          return (
            <Column key={dataKey}>
              <Label>{dataKey}</Label>
              <Row alignItems="center" gap>
                <Text>{stringValue}</Text>
                <Badge
                  variant={
                    trustTier === COLLECTION_TRUST_TIER.backendAuthorized ? 'good' : 'warning'
                  }
                  dot={false}
                >
                  {trustTier === COLLECTION_TRUST_TIER.backendAuthorized
                    ? 'Website backend authorized'
                    : 'Unverified'}
                </Badge>
              </Row>
            </Column>
          );
        })}
      </Grid>
    </LoadingPanel>
  );
}
