import { Column, Grid, Label, Row, Text } from '@umami/react-zen';
import { Badge } from '@/components/common/Badge';
import { LoadingPanel } from '@/components/common/LoadingPanel';
import { useEventDataQuery } from '@/components/hooks';
import { COLLECTION_TRUST_TIER } from '@/lib/constants';
import { getDisplayValue } from '@/lib/data';

export function EventData({ websiteId, eventId }: { websiteId: string; eventId: string }) {
  const { data, isLoading, error } = useEventDataQuery(websiteId, eventId);

  return (
    <LoadingPanel isLoading={isLoading} error={error}>
      <Grid columns="1fr 1fr" gap="5">
        {data?.map(row => {
          return (
            <Column key={row.dataKey}>
              <Label>{row.dataKey}</Label>
              <Row alignItems="center" gap>
                <Text>{getDisplayValue(row)}</Text>
                <Badge
                  variant={
                    row.trustTier === COLLECTION_TRUST_TIER.backendAuthorized ? 'good' : 'warning'
                  }
                  dot={false}
                >
                  {row.trustTier === COLLECTION_TRUST_TIER.backendAuthorized
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
