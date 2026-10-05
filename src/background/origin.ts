import { ext } from '../shared/ext';

const FIRST_RULE_ID = 1;

export function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Ollaya, like Ollama, answers 403 to any request whose `Origin` header is outside its allowlist,
 * and an extension's requests carry `chrome-extension://…` or `moz-extension://…`. Requests
 * without an `Origin` header are allowed. This session rule removes the header, but only from
 * this extension's own background requests (no tab, initiated by this extension) to the chosen
 * server, so web pages keep Ollaya's protection.
 *
 * If a browser does not apply the rule, Ollaya still works when started with
 * OLLAYA_ORIGINS="chrome-extension://*,moz-extension://*".
 *
 * One rule per origin: the saved server and any address tried with Test connection.
 */
export async function syncOriginRules(urls: string[]): Promise<void> {
  const dnr = ext.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  const origins = [...new Set(urls.map(originOf).filter((o): o is string => o !== null))];
  const addRules: chrome.declarativeNetRequest.Rule[] = origins.map((origin, i) => ({
    id: FIRST_RULE_ID + i,
    priority: 1,
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [{ header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation }],
    },
    condition: {
      urlFilter: `|${origin}/`,
      initiatorDomains: [location.hostname],
      tabIds: [-1],
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'other' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  }));
  try {
    const existing = await dnr.getSessionRules();
    await dnr.updateSessionRules({ removeRuleIds: existing.map((r) => r.id), addRules });
  } catch (err) {
    console.warn('[clever-filter] could not set the Origin rule', err);
  }
}
