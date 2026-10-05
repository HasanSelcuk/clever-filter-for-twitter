import { ext } from '../shared/ext';
import type { StatusResponse } from '../shared/messages';
import { ACTION_LABELS, isRunnable } from '../shared/rules';
import { activeProvider, loadSettings, onSettingsChanged, PROVIDER_NAMES, saveSettings } from '../shared/settings';
import type { Settings } from '../shared/types';
import { h } from '../ui/h';

let settings: Settings;
const app = document.getElementById('app')!;

function statusLine(status: StatusResponse | null): HTMLElement {
  const { id, config } = activeProvider(settings);
  const model = status?.queue.lastModel ?? config.model;
  const err = status?.queue.lastError;
  if (!settings.enabled) return h('p', { class: 'status' }, 'Paused. Posts are left as they are.');
  if (err) return h('p', { class: 'status error' }, err.message);
  const parts = [PROVIDER_NAMES[id], model];
  if (status?.queue.avgMs != null) parts.push(`${status.queue.avgMs} ms per post`);
  return h('p', { class: 'status' }, parts.join(' · '));
}

function stat(label: string, value: number): HTMLElement {
  return h('div', { class: 'stat' }, h('strong', null, String(value)), h('span', null, label));
}

function render(status: StatusResponse | null): void {
  const s = status?.stats;
  const runnable = settings.rules.filter((r) => isRunnable(r, settings));
  app.replaceChildren(
    h(
      'header',
      null,
      h('h1', null, 'Clever Filter'),
      h(
        'label',
        { class: 'switch', title: settings.enabled ? 'Pause' : 'Resume' },
        h('input', {
          type: 'checkbox',
          checked: settings.enabled,
          'aria-label': 'On or off',
          onchange: async (e: Event) => {
            settings.enabled = (e.target as HTMLInputElement).checked;
            await saveSettings(settings);
            render(status);
          },
        }),
        h('span', null, settings.enabled ? 'On' : 'Off'),
      ),
    ),
    statusLine(status),
    h(
      'div',
      { class: 'stats' },
      stat('checked', s?.checked ?? 0),
      stat('hidden', s?.hidden ?? 0),
      stat('liked', s?.liked ?? 0),
      stat('bookmarked', s?.bookmarked ?? 0),
    ),
    h('p', { class: 'caption' }, 'Today'),
    h('h2', null, 'Rules'),
    settings.rules.length === 0
      ? h('p', { class: 'empty' }, 'No rules yet. Pick a quick start in Settings.')
      : h(
          'ul',
          { class: 'rules' },
          settings.rules.map((rule) =>
            h(
              'li',
              { class: runnable.includes(rule) ? '' : 'muted' },
              h(
                'label',
                null,
                h('input', {
                  type: 'checkbox',
                  checked: rule.enabled,
                  onchange: async (e: Event) => {
                    rule.enabled = (e.target as HTMLInputElement).checked;
                    await saveSettings(settings);
                  },
                }),
                h('span', { class: 'rule-name' }, rule.name),
              ),
              h('span', { class: `tag tag-${rule.action}` }, ACTION_LABELS[rule.action]),
            ),
          ),
        ),
    h('button', { type: 'button', onclick: () => ext.runtime.openOptionsPage() }, 'Settings'),
  );
}

async function refresh(): Promise<void> {
  let status: StatusResponse | null = null;
  try {
    status = (await ext.runtime.sendMessage({ type: 'status' })) as StatusResponse;
  } catch {
    status = null;
  }
  // Keep focus and clicks stable: only redraw when nothing is being pressed.
  if (!app.matches(':active')) render(status);
}

async function main(): Promise<void> {
  settings = await loadSettings();
  onSettingsChanged((next) => (settings = next));
  render(null);
  await refresh();
  setInterval(refresh, 1500);
}

void main();
