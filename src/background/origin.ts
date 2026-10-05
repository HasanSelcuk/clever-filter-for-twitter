import { ext } from '../shared/ext';

const RULE_ID = 1;

/**
 * Ollaya, like Ollama, answers 403 to any request whose `Origin` header is outside its allowlist,
 * and an extension's requests carry `chrome-extension://…` or `moz-extension://…`. Requests
 * without an `Origin` header are allowed. This session rule removes the header, but only from
 * this extension's own background requests (no tab, initiated by this extension) to the chosen
 * server, so web pages keep Ollaya's protection.
 *
 * If a browser does not apply the rule, Ollaya still works when started with
 * OLLAYA_ORIGINS="chrome-extension://*,moz-extension://*".
 */
export async function syncOriginRule(baseUrl: string): Promise<void> {
  const dnr = ext.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  let origin: string | null = null;
  try {
    const u = new URL(baseUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
  } catch {
    origin = null;
  }
  const addRules: chrome.declarativeNetRequest.Rule[] = origin
    ? [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
            requestHeaders: [
              { header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
            ],
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
        },
      ]
    : [];
  try {
    await dnr.updateSessionRules({ removeRuleIds: [RULE_ID], addRules });
  } catch (err) {
    console.warn('[clever-filter] could not set the Origin rule', err);
  }
}
