export interface ErrorCaptureOptions {
  release?: string;
  environment?: string;
  tags?: Record<string, string>;
  fingerprint?: string[];
}
interface CollectorOptions {
  endpoint: string;
  enabled: boolean;
  disabled: () => boolean;
  context: () => {
    website: string | null;
    hostname?: string;
    sessionSeed?: string;
    id?: string;
    salt?: string;
    url: string;
    screen: string;
    language: string;
  };
  cache: () => string | undefined;
  generation?: () => number;
  updateCache: (cache: string) => void;
  release: string;
  environment: string;
  beforeSend: (
    payload: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | null | undefined>;
}
export declare function createErrorCollector(options: CollectorOptions): {
  captureException: (error: unknown, config?: ErrorCaptureOptions) => Promise<void>;
};
