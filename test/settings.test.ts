import { describe, expect, it } from 'vitest';
import { defaultSettings, normalizeSettings } from '../src/shared/settings';

describe('normalizeSettings', () => {
  it('returns defaults for empty storage', () => {
    expect(normalizeSettings(undefined)).toEqual(defaultSettings());
  });

  it('keeps stored values and fills new fields', () => {
    const s = normalizeSettings({
      enabled: false,
      backend: { provider: 'typesafe', typesafe: { apiKey: 'k' } },
      display: { animation: false },
    });
    expect(s.enabled).toBe(false);
    expect(s.backend.provider).toBe('typesafe');
    expect(s.backend.typesafe.apiKey).toBe('k');
    expect(s.backend.typesafe.model).toBe('jev-latest');
    expect(s.display).toEqual({ hiddenStyle: 'label', animation: false });
    expect(s.actions.dailyLikeLimit).toBe(50);
  });

  it('falls back from the community server while it has no address', () => {
    expect(normalizeSettings({ backend: { provider: 'community' } }).backend.provider).toBe('ollaya');
  });

  it('drops values of the wrong type', () => {
    expect(normalizeSettings({ rules: 'oops', enabled: 'yes' })).toMatchObject({ rules: [], enabled: true });
  });
});
