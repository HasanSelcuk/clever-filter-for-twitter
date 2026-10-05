import type { ProviderConfig, ProviderId } from './types';

/**
 * The shared server run by the project. Leave `baseUrl` empty to hide this option until the
 * server is online. It speaks Ollaya's native API.
 */
export const COMMUNITY_SERVER: ProviderConfig & { name: string; note: string } = {
  name: 'Clever Filter server',
  note: 'A free Ollaya server shared by everyone who picks it. Answers can be slower at busy hours.',
  baseUrl: '',
  apiKey: '',
  model: 'laya',
  api: 'ollaya',
};

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const TYPESAFE_KEYS_URL = 'https://console.typesafe.ai/settings/keys';
export const OLLAYA_LOCAL_URL = 'http://127.0.0.1:11435';

export const PROVIDER_DEFAULTS: Record<ProviderId, ProviderConfig> = {
  typesafe: { baseUrl: TYPESAFE_BASE_URL, apiKey: '', model: 'jev-latest', api: 'typesafe' },
  ollaya: { baseUrl: OLLAYA_LOCAL_URL, apiKey: '', model: 'laya', api: 'ollaya' },
  custom: { baseUrl: '', apiKey: '', model: 'laya', api: 'ollaya' },
  community: {
    baseUrl: COMMUNITY_SERVER.baseUrl,
    apiKey: '',
    model: COMMUNITY_SERVER.model,
    api: COMMUNITY_SERVER.api,
  },
};

/** How long Ollaya keeps the model loaded after a request (native API only). */
export const OLLAYA_KEEP_ALIVE = '30m';

/** Per-attempt request timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
