import { COMMUNITY_SERVER, PROVIDER_DEFAULTS } from './config';
import { ext } from './ext';
import type { ProviderConfig, ProviderId, Settings } from './types';

export function defaultSettings(): Settings {
  return {
    version: 1,
    enabled: true,
    backend: {
      provider: COMMUNITY_SERVER.baseUrl ? 'community' : 'ollaya',
      typesafe: { ...PROVIDER_DEFAULTS.typesafe },
      ollaya: { ...PROVIDER_DEFAULTS.ollaya },
      custom: { ...PROVIDER_DEFAULTS.custom },
      community: { ...PROVIDER_DEFAULTS.community },
    },
    checks: [],
    rules: [],
    pages: { home: true, search: true, profile: false, replies: true, lists: true },
    display: { hiddenStyle: 'label', animation: true },
    actions: {
      likeRiskAccepted: false,
      dailyLikeLimit: 50,
      dailyBookmarkLimit: 100,
      gapSeconds: 5,
      dwellSeconds: 1.5,
    },
  };
}

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fills missing fields from the defaults, keeping stored values of the right type. */
function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlain(defaults) || !isPlain(stored)) {
    if (stored === undefined || stored === null) return defaults;
    if (Array.isArray(defaults)) return (Array.isArray(stored) ? stored : defaults) as T;
    return (typeof stored === typeof defaults ? stored : defaults) as T;
  }
  const out: Plain = {};
  for (const key of Object.keys(defaults)) out[key] = mergeDefaults(defaults[key], stored[key]);
  return out as T;
}

export function normalizeSettings(stored: unknown): Settings {
  const s = mergeDefaults(defaultSettings(), stored);
  // The community server's address comes from the build, never from storage.
  s.backend.community.baseUrl = COMMUNITY_SERVER.baseUrl;
  s.backend.community.api = COMMUNITY_SERVER.api;
  if (s.backend.provider === 'community' && !COMMUNITY_SERVER.baseUrl) s.backend.provider = 'ollaya';
  return s;
}

export async function loadSettings(): Promise<Settings> {
  const { settings } = await ext.storage.local.get('settings');
  return normalizeSettings(settings);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await ext.storage.local.set({ settings });
}

export function onSettingsChanged(listener: (s: Settings) => void): void {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) listener(normalizeSettings(changes.settings.newValue));
  });
}

export function activeProvider(s: Settings): { id: ProviderId; config: ProviderConfig } {
  const id = s.backend.provider;
  return { id, config: s.backend[id] };
}

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  typesafe: 'TypeSafe (Jev)',
  ollaya: 'Ollaya on this computer',
  custom: 'Your own server',
  community: COMMUNITY_SERVER.name,
};
