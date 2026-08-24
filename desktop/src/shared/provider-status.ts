import type { ProviderId, ProviderStatus, ProviderStatusMap } from './ipc-types';

export const PROVIDER_IDS = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'kimi',
  'glm',
] as const satisfies readonly ProviderId[];

export const OPERATIONAL_PROVIDER_IDS = ['anthropic', 'openai'] as const satisfies readonly ProviderId[];

function hasOperationalPage(provider: ProviderId): boolean {
  return (OPERATIONAL_PROVIDER_IDS as readonly ProviderId[]).includes(provider);
}

function hasCompleteProviderSignals(
  status: ProviderStatus | undefined,
  requireOperational: boolean,
): boolean {
  if (!status || status.quality.score === null) return false;
  return requireOperational ? status.operational.level !== 'unknown' : true;
}

export function hasCompleteProviderStatusMap(statuses: ProviderStatusMap): boolean {
  const operationalComplete = OPERATIONAL_PROVIDER_IDS.every((provider) =>
    hasCompleteProviderSignals(statuses[provider], true),
  );
  if (!operationalComplete) return false;

  return PROVIDER_IDS.some((provider) =>
    hasCompleteProviderSignals(statuses[provider], hasOperationalPage(provider)),
  );
}
