'use client';
import { Button, Column, Grid, Heading } from '@umami/react-zen';
import Script from 'next/script';
import { WebsiteChart } from '@/app/(main)/websites/[websiteId]/WebsiteChart';
import Link from '@/components/common/Link';
import { PageBody } from '@/components/common/PageBody';
import { PageHeader } from '@/components/common/PageHeader';
import { Panel } from '@/components/common/Panel';
import { useWebsiteQuery } from '@/components/hooks';
import { EventsChart } from '@/components/metrics/EventsChart';

export function TestConsolePage({ websiteId }: { websiteId: string }) {
  const { data } = useWebsiteQuery(websiteId);

  function handleRunScript() {
    window.umami.track(props => ({
      ...props,
      url: '/page-view',
      referrer: 'https://www.google.com',
    }));
  }

  if (!data) {
    return null;
  }

  return (
    <PageBody>
      <PageHeader title="Test console">
        <Column>{data.name}</Column>
      </PageHeader>
      <Column gap="6" paddingY="6">
        <Script
          async
          data-website-id={websiteId}
          src={`${process.env.basePath || ''}/script.js`}
          data-cache="true"
          data-performance="true"
        />
        <Panel
          title="Public tracking"
          description="This browser console sends unverified pageviews only. Identity, custom events, revenue, replay, and heatmaps require separately reviewed website integrations."
        >
          <Grid columns="1fr 1fr" gap>
            <Column gap>
              <Heading>Page links</Heading>
              <div>
                <Link href={`/console/${websiteId}?page=1`}>page one</Link>
              </div>
              <div>
                <Link href={`/console/${websiteId}?page=2`}>page two</Link>
              </div>
            </Column>
            <Column gap>
              <Heading>Javascript pageview</Heading>
              <Button id="manual-pageview-button" variant="primary" onClick={handleRunScript}>
                Run pageview script
              </Button>
            </Column>
          </Grid>
        </Panel>
        <Heading>Pageviews</Heading>
        <WebsiteChart websiteId={websiteId} />
        <Heading>Historical events</Heading>
        <Panel>
          <EventsChart websiteId={websiteId} />
        </Panel>
      </Column>
    </PageBody>
  );
}
