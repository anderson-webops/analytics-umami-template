import { DataGrid } from '@/components/common/DataGrid';
import { useNavigation, useRevenueSessionsQuery, useShare } from '@/components/hooks';
import { canViewShareSection } from '@/lib/share';
import { SessionsTable } from '../../sessions/SessionsTable';

export interface RevenueSessionsDataTableProps {
  websiteId: string;
  currency: string;
}

export function RevenueSessionsDataTable({ websiteId, currency }: RevenueSessionsDataTableProps) {
  const { updateParams } = useNavigation();
  const share = useShare();
  const queryResult = useRevenueSessionsQuery(websiteId, currency);

  return (
    <DataGrid query={queryResult} allowPaging allowSearch>
      {({ data }) => (
        <SessionsTable
          data={data}
          websiteId={websiteId}
          getSessionHref={row => updateParams({ session: row.id })}
          showSessionLinks={canViewShareSection(share?.parameters, 'sessions')}
        />
      )}
    </DataGrid>
  );
}
