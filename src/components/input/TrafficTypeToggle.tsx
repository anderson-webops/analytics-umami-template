import { Row, Text } from '@umami/react-zen';
import { useMessages, useNavigation } from '@/components/hooks';
import { FilterButtons } from './FilterButtons';

export function TrafficTypeToggle() {
  const { t, labels } = useMessages();
  const {
    query: { trafficType },
    router,
    updateParams,
  } = useNavigation();

  const selectedTrafficType = typeof trafficType === 'string' ? trafficType : 'human';

  const handleChange = (value: string) => {
    router.push(
      updateParams({
        trafficType: value !== 'human' ? value : undefined,
      }),
    );
  };

  return (
    <Row alignItems="center" gap="3" wrap="wrap">
      <Text size="sm" color="muted">
        {t(labels.traffic)}
      </Text>
      <FilterButtons
        value={selectedTrafficType}
        onChange={handleChange}
        items={[
          { id: 'human', label: t(labels.humanTraffic) },
          { id: 'bot', label: t(labels.botTraffic) },
          { id: 'all', label: t(labels.allTraffic) },
        ]}
      />
    </Row>
  );
}
