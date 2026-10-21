export interface RecorderConfig {
  replayEnabled?: boolean;
  heatmapEnabled?: boolean;
  sampleRate?: number;
  heatmapSampleRate?: number;
  maskLevel?: 'strict' | 'moderate';
  maxDuration?: number;
  blockSelector?: string;
  permitEndpoint?: string | null;
}

const MIN_RECORDING_DURATION_MS = 60_000;
const MAX_RECORDING_DURATION_MS = 3_600_000;
const MAX_BLOCK_SELECTOR_LENGTH = 1_000;
const MAX_PERMIT_ENDPOINT_LENGTH = 255;

export function isRecorderPermitEndpoint(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length > MAX_PERMIT_ENDPOINT_LENGTH ||
    !/^\/(?!\/)[^\\\s?#"'<>]+$/.test(value)
  ) {
    return false;
  }

  try {
    const parsed = new URL(value, 'https://site.invalid');
    return parsed.origin === 'https://site.invalid' && parsed.pathname === value;
  } catch {
    return false;
  }
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&"'<>]/g, character => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '"': '&quot;',
      "'": '&#39;',
      '<': '&lt;',
      '>': '&gt;',
    };
    return entities[character];
  });
}

export function getRecorderCode(
  recorderUrl: string,
  websiteId: string,
  permitEndpoint: string,
): string | null {
  if (!isRecorderPermitEndpoint(permitEndpoint)) {
    return null;
  }

  return (
    '<script defer src="' +
    escapeHtmlAttribute(recorderUrl) +
    '" data-website-id="' +
    escapeHtmlAttribute(websiteId) +
    '" data-permit-endpoint="' +
    escapeHtmlAttribute(permitEndpoint) +
    '"></script>'
  );
}

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

  if (isRecorderPermitEndpoint(config.permitEndpoint)) {
    nextConfig.permitEndpoint = config.permitEndpoint;
  }

  return nextConfig;
}

export function getRecorderEnabled(config: unknown) {
  const { replayEnabled, heatmapEnabled } = getRecorderConfig(config);

  return replayEnabled === true || heatmapEnabled === true;
}
