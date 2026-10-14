import { after } from 'next/server';

export function releaseAfterResponse(release: () => Promise<void>) {
  after(release);
}
