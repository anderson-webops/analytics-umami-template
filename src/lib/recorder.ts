export interface RecorderConfig {
  replayEnabled?: boolean;
  heatmapEnabled?: boolean;
  sampleRate?: number;
  heatmapSampleRate?: number;
  maskLevel?: 'strict' | 'moderate';
  maxDuration?: number;
  blockSelector?: string;
}

const MIN_RECORDING_DURATION_MS = 60_000;
const MAX_RECORDING_DURATION_MS = 3_600_000;
const MAX_BLOCK_SELECTOR_LENGTH = 1_000;

export function getRecorderConfig(value: unknown): RecorderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const config = value as Record<string, unknown>;
  const nextConfig: RecorderConfig = {};

  if (config.replayEnabled === true) {
    nextConfig.replayEnabled = true;
  }

  if (config.heatmapEnabled === true) {
    nextConfig.heatmapEnabled = true;
  }

  if (
    typeof config.sampleRate === 'number' &&
    Number.isFinite(config.sampleRate) &&
    config.sampleRate >= 0 &&
    config.sampleRate <= 1
  ) {
    nextConfig.sampleRate = config.sampleRate;
  }

  if (
    typeof config.heatmapSampleRate === 'number' &&
    Number.isFinite(config.heatmapSampleRate) &&
    config.heatmapSampleRate >= 0 &&
    config.heatmapSampleRate <= 1
  ) {
    nextConfig.heatmapSampleRate = config.heatmapSampleRate;
  }

  if (config.maskLevel === 'strict' || config.maskLevel === 'moderate') {
    nextConfig.maskLevel = config.maskLevel;
  }

  if (
    typeof config.maxDuration === 'number' &&
    Number.isFinite(config.maxDuration) &&
    config.maxDuration >= MIN_RECORDING_DURATION_MS &&
    config.maxDuration <= MAX_RECORDING_DURATION_MS
  ) {
    nextConfig.maxDuration = Math.round(config.maxDuration);
  }

  if (
    typeof config.blockSelector === 'string' &&
    config.blockSelector.length <= MAX_BLOCK_SELECTOR_LENGTH
  ) {
    nextConfig.blockSelector = config.blockSelector;
  }

  return nextConfig;
}

export function getRecorderEnabled(config: unknown) {
  const { replayEnabled, heatmapEnabled } = getRecorderConfig(config);

  return replayEnabled === true || heatmapEnabled === true;
}
