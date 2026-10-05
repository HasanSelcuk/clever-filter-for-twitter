import { ext } from '../shared/ext';
import type { DecideResult, ReserveResult, Request, StatusResponse, TestResult } from '../shared/messages';
import { activeProvider, loadSettings, onSettingsChanged } from '../shared/settings';
import type { ProviderConfig, Settings } from '../shared/types';
import { decide, listModels, trimBase } from './backend';
import { originOf, syncOriginRules } from './origin';
import { Scheduler } from './scheduler';
import { bump, getStats, reserve } from './stats';

const scheduler = new Scheduler();
let settingsPromise: Promise<Settings> = loadSettings();
let backendKey = '';
/** Addresses tried with Test connection, kept so their requests also lose the Origin header. */
const testedUrls = new Set<string>();
let activeUrl = '';

function syncOrigins(): Promise<void> {
  return syncOriginRules([activeUrl, ...testedUrls]);
}

async function applySettings(s: Settings): Promise<void> {
  const { id, config } = activeProvider(s);
  const key = JSON.stringify([id, config]);
  if (key !== backendKey) {
    backendKey = key;
    scheduler.reset();
    activeUrl = config.baseUrl;
    await syncOrigins();
    await setBadge(null);
  }
}

settingsPromise.then(applySettings);
onSettingsChanged((s) => {
  settingsPromise = Promise.resolve(s);
  void applySettings(s);
});

async function setBadge(message: string | null): Promise<void> {
  try {
    await ext.action.setBadgeText({ text: message ? '!' : '' });
    if (message) {
      await ext.action.setBadgeBackgroundColor({ color: '#b3261e' });
      await ext.action.setTitle({ title: `Clever Filter: ${message}` });
    } else {
      await ext.action.setTitle({ title: 'Clever Filter' });
    }
  } catch {
    /* the action API is missing in tests */
  }
}

/** Host permission for the server, which the person grants in Settings for custom addresses. */
async function hasHostAccess(baseUrl: string): Promise<boolean> {
  try {
    const origin = new URL(trimBase(baseUrl)).origin;
    return await ext.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

async function runDecide(msg: Extract<Request, { type: 'decide' }>): Promise<DecideResult> {
  const settings = await settingsPromise;
  const { config } = activeProvider(settings);
  if (config.baseUrl && !(await hasHostAccess(config.baseUrl))) {
    const error = {
      kind: 'permission' as const,
      message: 'The extension has no access to the server address yet. Open Settings and press Save to allow it.',
    };
    scheduler.lastError = { ...error, at: Date.now() };
    void setBadge(error.message);
    return { ok: false, error };
  }
  const receivedAt = Date.now();
  let sentAt: number | undefined;
  const result = await scheduler.submit(() => {
    sentAt = Date.now();
    return decide(config, msg.state, msg.questions);
  }, msg.priority);
  result.meta = { attempts: 1, ...result.meta, receivedAt, sentAt, answeredAt: Date.now() };
  void setBadge(result.ok ? null : result.error.message);
  if (result.ok) void bump('checked');
  return result;
}

async function runTest(config?: ProviderConfig): Promise<TestResult> {
  const settings = await settingsPromise;
  const cfg = config ?? activeProvider(settings).config;
  const origin = originOf(cfg.baseUrl);
  if (origin && !testedUrls.has(origin)) {
    testedUrls.add(origin);
    await syncOrigins();
  }
  const started = Date.now();
  const result = await decide(cfg, { post: 'Just finished a long walk by the river. The weather was perfect.' }, {
    test: { type: 'noul', instructions: 'Is `post` about the outdoors?' },
  });
  if (!result.ok) return result;
  const models = await listModels(cfg);
  return {
    ok: true,
    models: Array.isArray(models) ? models : null,
    answeredBy: result.model || cfg.model,
    ms: Date.now() - started,
  };
}

async function runReserve(action: 'like' | 'bookmark'): Promise<ReserveResult> {
  const s = await settingsPromise;
  if (action === 'like' && !s.actions.likeRiskAccepted) {
    return { allowed: false, reason: 'Automatic likes are off until you accept the note in Settings.' };
  }
  const limit = action === 'like' ? s.actions.dailyLikeLimit : s.actions.dailyBookmarkLimit;
  const ok = await reserve(action === 'like' ? 'liked' : 'bookmarked', limit);
  return ok ? { allowed: true } : { allowed: false, reason: `Today's ${action} limit (${limit}) is reached.` };
}

async function handle(msg: Request): Promise<unknown> {
  switch (msg.type) {
    case 'decide':
      return runDecide(msg);
    case 'count':
      return bump(msg.field);
    case 'reserve':
      return runReserve(msg.action);
    case 'release':
      return bump(msg.action === 'like' ? 'liked' : 'bookmarked', -1);
    case 'status':
      return { queue: scheduler.status(), stats: await getStats() } satisfies StatusResponse;
    case 'test':
      return runTest(msg.config);
  }
}

ext.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: { kind: 'server', message: String(err) } }));
  return true;
});

ext.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') void ext.runtime.openOptionsPage();
});
