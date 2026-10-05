import { COMMUNITY_SERVER, TYPESAFE_KEYS_URL } from '../shared/config';
import { ext } from '../shared/ext';
import { newId } from '../shared/ids';
import type { TestResult } from '../shared/messages';
import { applyPreset, DEFAULT_THRESHOLD, PRESETS } from '../shared/presets';
import { ACTION_LABELS, checkIdsOf, describe, isRunnable } from '../shared/rules';
import { loadSettings, onSettingsChanged, PROVIDER_NAMES, saveSettings } from '../shared/settings';
import type {
  ActionKind,
  Check,
  ConditionNode,
  GroupNode,
  ProviderConfig,
  ProviderId,
  Rule,
  Settings,
} from '../shared/types';
import { h } from '../ui/h';

let settings: Settings;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let lastTest: { provider: ProviderId; result: TestResult } | null = null;
let modelOptions: string[] = [];
let testing = false;

const app = document.getElementById('app')!;
const savedNote = document.getElementById('saved')!;

function save(): void {
  savedNote.textContent = 'Saving…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveSettings(settings);
    savedNote.textContent = 'Saved';
  }, 250);
}

/** For changes that alter the page's structure. */
function commit(): void {
  save();
  render();
}

// ---------- Server ----------

const PROVIDER_NOTES: Record<ProviderId, string> = {
  typesafe: 'Hosted by TypeSafe. Uses your own API key and your TypeSafe plan.',
  ollaya: 'Free. Runs an open model such as Laya on your own computer.',
  custom: 'An Ollaya or TypeSafe-compatible server at an address you choose, such as your own VPS.',
  community: COMMUNITY_SERVER.note,
};

function providerIds(): ProviderId[] {
  const ids: ProviderId[] = ['ollaya', 'typesafe', 'custom'];
  if (COMMUNITY_SERVER.baseUrl) ids.unshift('community');
  return ids;
}

function originOf(url: string): string | null {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Asks for access to a server address. Firefox accepts permissions.request() only while it is
 * handling a click, so callers must call this first in the handler, before any await. When access
 * is already granted it resolves to true without a prompt.
 */
function requestAccess(url: string): Promise<boolean> {
  const origin = originOf(url);
  if (!origin) return Promise.resolve(false);
  try {
    return ext.permissions.request({ origins: [`${origin}/*`] }).catch((err: unknown) => {
      console.warn('[clever-filter] permission request failed', err);
      return false;
    });
  } catch (err) {
    console.warn('[clever-filter] permission request failed', err);
    return Promise.resolve(false);
  }
}

function textField(
  label: string,
  value: string,
  onInput: (v: string) => void,
  opts: { type?: string; placeholder?: string; list?: string; hint?: Node | string } = {},
): HTMLElement {
  const id = `f-${newId()}`;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id }, label),
    h('input', {
      id,
      type: opts.type ?? 'text',
      value,
      placeholder: opts.placeholder,
      list: opts.list,
      autocomplete: 'off',
      spellcheck: 'false',
      oninput: (e: Event) => {
        onInput((e.target as HTMLInputElement).value);
        save();
      },
    }),
    opts.hint ? h('p', { class: 'hint' }, opts.hint) : null,
  );
}

function keyField(config: ProviderConfig, label: string, hint?: Node | string): HTMLElement {
  const field = textField(label, config.apiKey, (v) => (config.apiKey = v.trim()), {
    type: 'password',
    hint,
  });
  const input = field.querySelector('input')!;
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'link',
      onclick: () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        toggle.textContent = input.type === 'password' ? 'Show' : 'Hide';
      },
    },
    'Show',
  );
  field.querySelector('label')!.after(toggle);
  return field;
}

function modelField(config: ProviderConfig): HTMLElement {
  return textField('Model', config.model, (v) => (config.model = v.trim()), {
    list: 'model-options',
    hint: config.api === 'ollaya' ? 'laya picks the English or the multilingual model for each post.' : undefined,
  });
}

function providerFields(id: ProviderId): HTMLElement {
  const config = settings.backend[id];
  const box = h('div', { class: 'provider-fields' });
  if (id === 'typesafe') {
    box.append(
      keyField(
        config,
        'API key',
        h('span', null, 'Create one at ', h('a', { href: TYPESAFE_KEYS_URL, target: '_blank', rel: 'noreferrer' }, 'console.typesafe.ai'), '. It stays in this browser and goes only to api.typesafe.ai.'),
      ),
      modelField(config),
    );
  } else if (id === 'ollaya') {
    box.append(
      textField('Address', config.baseUrl, (v) => (config.baseUrl = v.trim())),
      modelField(config),
      h(
        'details',
        { class: 'help' },
        h('summary', null, 'How to set up Ollaya'),
        h('p', null, 'Install it, download the model, and start the server:'),
        h('pre', null, 'curl -fsSL https://ollaya.dev/install.sh | sh\nollaya pull laya\nollaya serve'),
        h('p', null, 'The extension removes its browser origin from requests, which Ollaya accepts. If Ollaya still answers with "refused", start it with this setting:'),
        h('pre', null, 'OLLAYA_ORIGINS="chrome-extension://*,moz-extension://*" ollaya serve'),
      ),
    );
  } else if (id === 'custom') {
    box.append(
      textField('Address', config.baseUrl, (v) => (config.baseUrl = v.trim()), {
        placeholder: 'https://decide.example.com',
      }),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'api-style' }, 'Server type'),
        h(
          'select',
          {
            id: 'api-style',
            onchange: (e: Event) => {
              config.api = (e.target as HTMLSelectElement).value as ProviderConfig['api'];
              commit();
            },
          },
          h('option', { value: 'ollaya', selected: config.api === 'ollaya' }, 'Ollaya (uses /api/decide)'),
          h('option', { value: 'typesafe', selected: config.api === 'typesafe' }, 'TypeSafe-compatible (uses /v1/systemone)'),
        ),
      ),
      keyField(config, 'API key (optional)', 'Sent as a bearer token. Ollaya checks it when OLLAYA_API_KEY is set on the server.'),
      modelField(config),
      h(
        'button',
        {
          type: 'button',
          class: 'secondary',
          onclick: async () => {
            const ok = await requestAccess(config.baseUrl);
            accessNote.textContent = ok ? 'Access granted.' : 'Access was not granted. Check the address.';
          },
        },
        'Allow access to this address',
      ),
    );
    const accessNote = h('p', { class: 'hint' });
    box.append(accessNote);
  } else {
    box.append(keyField(config, 'Access token (optional)'));
  }
  return box;
}

function testLine(): HTMLElement | null {
  if (testing) return h('p', { class: 'status' }, 'Testing…');
  if (!lastTest || lastTest.provider !== settings.backend.provider) return null;
  const r = lastTest.result;
  if (r.ok) {
    return h('p', { class: 'status ok' }, `Connected. ${r.answeredBy} answered in ${r.ms} ms.`);
  }
  return h('p', { class: 'status error' }, r.error.message);
}

function onTestClick(): void {
  const id = settings.backend.provider;
  const config = { ...settings.backend[id] };
  // Called before any await, so Firefox still sees the click.
  const access = requestAccess(config.baseUrl);
  void runTest(id, config, access);
}

async function runTest(id: ProviderId, config: ProviderConfig, access: Promise<boolean>): Promise<void> {
  testing = true;
  render();
  let result: TestResult;
  if (!originOf(config.baseUrl)) {
    result = { ok: false, error: { kind: 'no-server', message: 'Enter a server address that starts with https:// or http://.' } };
  } else if (!(await access)) {
    result = { ok: false, error: { kind: 'permission', message: 'The browser did not give the extension access to this address. Press Test connection again and allow it.' } };
  } else {
    try {
      result = (await ext.runtime.sendMessage({ type: 'test', config })) as TestResult;
    } catch (err) {
      result = { ok: false, error: { kind: 'server', message: `The extension's background page did not answer: ${String(err)}` } };
    }
  }
  testing = false;
  lastTest = { provider: id, result };
  if (result.ok && result.models) modelOptions = result.models;
  render();
}

function serverSection(): HTMLElement {
  const current = settings.backend.provider;
  return h(
    'section',
    null,
    h('h2', null, 'Model server'),
    h('p', { class: 'lead' }, 'Every post you scroll past is sent to this server with your checks. The server answers each check with a probability.'),
    h(
      'div',
      { class: 'choices' },
      providerIds().map((id) =>
        h(
          'label',
          { class: `choice${id === current ? ' selected' : ''}` },
          h('input', {
            type: 'radio',
            name: 'provider',
            checked: id === current,
            onchange: () => {
              settings.backend.provider = id;
              commit();
            },
          }),
          h('span', { class: 'choice-text' }, h('strong', null, PROVIDER_NAMES[id]), h('span', null, PROVIDER_NOTES[id])),
        ),
      ),
    ),
    providerFields(current),
    h('datalist', { id: 'model-options' }, modelOptions.map((m) => h('option', { value: m }))),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: onTestClick, disabled: testing }, 'Test connection'), testLine()),
    h('p', { class: 'hint' }, 'Only the text of each post goes to the server. Your account, your feed list and your API key stay in this browser, except that the key is sent to the server it belongs to.'),
  );
}

// ---------- Quick starts ----------

function quickStartSection(): HTMLElement {
  return h(
    'section',
    null,
    h('h2', null, 'Quick starts'),
    h('p', { class: 'lead' }, 'Each one adds a ready rule and the checks it uses. You can change them below.'),
    h(
      'div',
      { class: 'cards' },
      PRESETS.map((p) => {
        const added = settings.rules.some((r) => r.presetId === p.id);
        return h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('strong', null, p.name), h('span', { class: `tag tag-${p.action}` }, ACTION_LABELS[p.action])),
          h('p', null, p.description),
          h(
            'button',
            {
              type: 'button',
              class: 'secondary',
              disabled: added,
              onclick: () => {
                const { checks, rule } = applyPreset(p, settings.checks);
                settings.checks = checks;
                settings.rules.push(rule);
                commit();
              },
            },
            added ? 'Added' : 'Add',
          ),
        );
      }),
    ),
  );
}

// ---------- Rules ----------

function newCheckNode(): ConditionNode {
  return { kind: 'check', checkId: settings.checks[0]?.id ?? '', negate: false, threshold: DEFAULT_THRESHOLD };
}

function conditionRow(node: ConditionNode, parent: GroupNode, depth: number): HTMLElement {
  const remove = h(
    'button',
    {
      type: 'button',
      class: 'icon',
      title: 'Remove',
      'aria-label': 'Remove',
      onclick: () => {
        parent.children.splice(parent.children.indexOf(node), 1);
        commit();
      },
    },
    '×',
  );
  if (node.kind === 'group') {
    return h('div', { class: 'cond cond-group' }, groupEditor(node, depth + 1), remove);
  }
  const value = h('output', null, `${Math.round(node.threshold * 100)}%`);
  return h(
    'div',
    { class: 'cond' },
    h(
      'select',
      {
        'aria-label': 'Check',
        onchange: (e: Event) => {
          node.checkId = (e.target as HTMLSelectElement).value;
          commit();
        },
      },
      settings.checks.some((c) => c.id === node.checkId) ? null : h('option', { value: '', selected: true }, 'Pick a check'),
      settings.checks.map((c) => h('option', { value: c.id, selected: c.id === node.checkId }, c.name || 'Unnamed check')),
    ),
    h(
      'select',
      {
        'aria-label': 'Is or is not',
        onchange: (e: Event) => {
          node.negate = (e.target as HTMLSelectElement).value === 'not';
          commit();
        },
      },
      h('option', { value: 'is', selected: !node.negate }, 'is'),
      h('option', { value: 'not', selected: node.negate }, 'is not'),
    ),
    h(
      'label',
      { class: 'strict', title: 'How sure the model must be before this counts as a yes' },
      h('span', null, 'Sure at'),
      h('input', {
        type: 'range',
        min: 50,
        max: 99,
        step: 1,
        value: Math.round(node.threshold * 100),
        oninput: (e: Event) => {
          node.threshold = Number((e.target as HTMLInputElement).value) / 100;
          value.textContent = `${Math.round(node.threshold * 100)}%`;
          save();
        },
      }),
      value,
    ),
    remove,
  );
}

function groupEditor(group: GroupNode, depth: number): HTMLElement {
  return h(
    'div',
    { class: 'group' },
    h(
      'div',
      { class: 'group-head' },
      h('span', null, depth === 0 ? 'Match' : 'Group: match'),
      h(
        'select',
        {
          'aria-label': 'All or any',
          onchange: (e: Event) => {
            group.op = (e.target as HTMLSelectElement).value as GroupNode['op'];
            commit();
          },
        },
        h('option', { value: 'and', selected: group.op === 'and' }, 'all (AND)'),
        h('option', { value: 'or', selected: group.op === 'or' }, 'any (OR)'),
      ),
      h('span', null, 'of these'),
      h(
        'label',
        { class: 'inline' },
        h('input', {
          type: 'checkbox',
          checked: group.negate,
          onchange: (e: Event) => {
            group.negate = (e.target as HTMLInputElement).checked;
            commit();
          },
        }),
        'reverse (NOT)',
      ),
    ),
    h('div', { class: 'conds' }, group.children.map((child) => conditionRow(child, group, depth))),
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          disabled: settings.checks.length === 0,
          onclick: () => {
            group.children.push(newCheckNode());
            commit();
          },
        },
        '+ Condition',
      ),
      depth < 2
        ? h(
            'button',
            {
              type: 'button',
              class: 'link',
              disabled: settings.checks.length === 0,
              onclick: () => {
                group.children.push({ kind: 'group', op: group.op === 'and' ? 'or' : 'and', negate: false, children: [newCheckNode()] });
                commit();
              },
            },
            '+ Group',
          )
        : null,
    ),
  );
}

function ruleProblem(rule: Rule): string | null {
  if (checkIdsOf(rule.root).size === 0) return 'Add a condition to turn this rule on.';
  if (rule.action === 'like' && !settings.actions.likeRiskAccepted) {
    return 'Like rules stay off until you accept the note under Likes and bookmarks.';
  }
  if (!isRunnable(rule, settings)) return 'A condition points to a check that is missing or empty.';
  return null;
}

const ACTION_VERBS: Record<ActionKind, string> = { hide: 'Hides', bookmark: 'Bookmarks', like: 'Likes' };

function ruleCard(rule: Rule): HTMLElement {
  const problem = ruleProblem(rule);
  return h(
    'div',
    { class: `rule${rule.enabled ? '' : ' off'}` },
    h(
      'div',
      { class: 'rule-head' },
      h('input', {
        type: 'checkbox',
        checked: rule.enabled,
        title: 'Rule on or off',
        'aria-label': 'Rule on or off',
        onchange: (e: Event) => {
          rule.enabled = (e.target as HTMLInputElement).checked;
          commit();
        },
      }),
      h('input', {
        class: 'rule-name',
        value: rule.name,
        'aria-label': 'Rule name',
        oninput: (e: Event) => {
          rule.name = (e.target as HTMLInputElement).value;
          save();
        },
      }),
      h(
        'select',
        {
          'aria-label': 'Action',
          onchange: (e: Event) => {
            rule.action = (e.target as HTMLSelectElement).value as ActionKind;
            commit();
          },
        },
        (Object.keys(ACTION_LABELS) as ActionKind[]).map((a) => h('option', { value: a, selected: a === rule.action }, ACTION_LABELS[a])),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'link danger',
          onclick: () => {
            settings.rules = settings.rules.filter((r) => r !== rule);
            commit();
          },
        },
        'Delete',
      ),
    ),
    h(
      'p',
      { class: 'summary' },
      `${ACTION_VERBS[rule.action]} posts that match: ${describe(rule.root, settings.checks) || 'nothing yet'}`,
    ),
    groupEditor(rule.root, 0),
    problem ? h('p', { class: 'warn' }, problem) : null,
  );
}

function rulesSection(): HTMLElement {
  return h(
    'section',
    null,
    h('h2', null, 'Rules'),
    h('p', { class: 'lead' }, 'A rule joins checks with AND, OR and NOT, then hides, bookmarks or likes the posts that match. A higher "sure at" value means fewer, safer matches.'),
    settings.rules.length === 0 ? h('p', { class: 'empty' }, 'No rules yet. Add a quick start above, or make your own.') : null,
    settings.rules.map(ruleCard),
    h(
      'button',
      {
        type: 'button',
        disabled: settings.checks.length === 0,
        onclick: () => {
          settings.rules.push({
            id: newId(),
            name: 'New rule',
            enabled: true,
            action: 'hide',
            root: { kind: 'group', op: 'and', negate: false, children: [newCheckNode()] },
          });
          commit();
        },
      },
      'New rule',
    ),
    settings.checks.length === 0 ? h('p', { class: 'hint' }, 'Make a check first, or add a quick start.') : null,
  );
}

// ---------- Checks ----------

function usedBy(check: Check): Rule[] {
  return settings.rules.filter((r) => checkIdsOf(r.root).has(check.id));
}

function checkCard(check: Check): HTMLElement {
  const users = usedBy(check);
  return h(
    'div',
    { class: 'check' },
    h(
      'div',
      { class: 'rule-head' },
      h('input', {
        class: 'rule-name',
        value: check.name,
        placeholder: 'Name',
        'aria-label': 'Check name',
        oninput: (e: Event) => {
          check.name = (e.target as HTMLInputElement).value;
          save();
        },
        onchange: () => render(),
      }),
      h(
        'button',
        {
          type: 'button',
          class: 'link danger',
          disabled: users.length > 0,
          title: users.length ? `Used by: ${users.map((r) => r.name).join(', ')}` : undefined,
          onclick: () => {
            settings.checks = settings.checks.filter((c) => c !== check);
            commit();
          },
        },
        'Delete',
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', null, 'Question'),
      h('textarea', {
        rows: 2,
        value: check.question,
        placeholder: 'Is `post` about cryptocurrency?',
        oninput: (e: Event) => {
          check.question = (e.target as HTMLTextAreaElement).value;
          save();
        },
      }),
    ),
    h(
      'div',
      { class: 'pair' },
      textField('A yes looks like (optional)', check.yes, (v) => (check.yes = v)),
      textField('A no looks like (optional)', check.no, (v) => (check.no = v)),
    ),
    users.length ? h('p', { class: 'hint' }, `Used by: ${users.map((r) => r.name).join(', ')}`) : null,
  );
}

function checksSection(): HTMLElement {
  return h(
    'section',
    null,
    h('h2', null, 'Checks'),
    h(
      'p',
      { class: 'lead' },
      'A check is one yes-or-no question about a post. Ask one thing per check, keep it short and literal, and write `post` where you mean the post text. Short examples of a yes and a no help the model.',
    ),
    settings.checks.map(checkCard),
    h(
      'button',
      {
        type: 'button',
        onclick: () => {
          settings.checks.push({ id: newId(), name: 'New check', question: '', yes: '', no: '' });
          commit();
        },
      },
      'New check',
    ),
  );
}

// ---------- Pages, display, actions ----------

/** Replies under a post are left out for now. */
const PAGE_LABELS: Partial<Record<keyof Settings['pages'], string>> = {
  home: 'Home timeline (For you and Following)',
  search: 'Search results',
  lists: 'Lists',
  profile: 'Profiles',
};

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  return h(
    'label',
    { class: 'inline' },
    h('input', {
      type: 'checkbox',
      checked,
      onchange: (e: Event) => {
        onChange((e.target as HTMLInputElement).checked);
        commit();
      },
    }),
    label,
  );
}

function numberField(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void): HTMLElement {
  return h(
    'label',
    { class: 'num' },
    h('span', null, label),
    h('input', {
      type: 'number',
      min,
      max,
      step,
      value,
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v)) {
          onInput(Math.min(max, Math.max(min, v)));
          save();
        }
      },
    }),
  );
}

function pagesSection(): HTMLElement {
  return h(
    'section',
    null,
    h('h2', null, 'Where it runs'),
    h(
      'div',
      { class: 'stack' },
      (Object.keys(PAGE_LABELS) as (keyof Settings['pages'])[]).map((k) =>
        checkbox(PAGE_LABELS[k]!, settings.pages[k], (v) => (settings.pages[k] = v)),
      ),
    ),
  );
}

function displaySection(): HTMLElement {
  const d = settings.display;
  return h(
    'section',
    null,
    h('h2', null, 'Display'),
    h(
      'div',
      { class: 'stack' },
      h(
        'label',
        { class: 'inline' },
        h('input', { type: 'radio', name: 'hidden-style', checked: d.hiddenStyle === 'label', onchange: () => { d.hiddenStyle = 'label'; commit(); } }),
        'Leave a one-line note where a hidden post was, with a Show button',
      ),
      h(
        'label',
        { class: 'inline' },
        h('input', { type: 'radio', name: 'hidden-style', checked: d.hiddenStyle === 'remove', onchange: () => { d.hiddenStyle = 'remove'; commit(); } }),
        'Remove hidden posts with no note',
      ),
      checkbox('Show the filter at work: a bar on posts being checked, a scan line on posts being hidden, and a note on posts it liked or bookmarked', d.animation, (v) => (d.animation = v)),
      checkbox('Test mode: show a panel next to each post with its status, probabilities and timings', settings.test.panels, (v) => (settings.test.panels = v)),
    ),
  );
}

function actionsSection(): HTMLElement {
  const a = settings.actions;
  return h(
    'section',
    null,
    h('h2', null, 'Likes and bookmarks'),
    h(
      'div',
      { class: 'note' },
      h('strong', null, 'Use automatic likes at your own risk.'),
      h(
        'p',
        null,
        'Likes are public and come from your account. X does not allow automated liking, and it can limit or lock accounts that like in a pattern that looks automated. This extension likes one post at a time, only a post that has stayed on your screen, with a pause between likes and a daily limit. Bookmarks are private, and the same limits apply to them.',
      ),
      checkbox('I understand. Turn on rules that like posts.', a.likeRiskAccepted, (v) => (a.likeRiskAccepted = v)),
    ),
    h(
      'div',
      { class: 'grid' },
      numberField('Likes per day, at most', a.dailyLikeLimit, 0, 500, 1, (v) => (a.dailyLikeLimit = v)),
      numberField('Bookmarks per day, at most', a.dailyBookmarkLimit, 0, 1000, 1, (v) => (a.dailyBookmarkLimit = v)),
      numberField('Seconds between two actions', a.gapSeconds, 2, 120, 1, (v) => (a.gapSeconds = v)),
      numberField('Seconds a post stays on screen first', a.dwellSeconds, 0.5, 10, 0.5, (v) => (a.dwellSeconds = v)),
    ),
  );
}

async function accessBanner(): Promise<HTMLElement | null> {
  const origins = ['https://x.com/*', 'https://twitter.com/*'];
  if (await ext.permissions.contains({ origins })) return null;
  return h(
    'div',
    { class: 'note' },
    h('p', null, 'The extension does not have access to x.com yet, so it cannot see your timeline.'),
    h(
      'button',
      {
        type: 'button',
        onclick: async () => {
          const manifest = ext.runtime.getManifest();
          await ext.permissions.request({ origins: manifest.host_permissions ?? origins });
          render();
        },
      },
      'Allow access',
    ),
  );
}

async function render(): Promise<void> {
  const scrollY = window.scrollY;
  const banner = await accessBanner();
  app.replaceChildren(
    ...[banner, serverSection(), quickStartSection(), rulesSection(), checksSection(), pagesSection(), displaySection(), actionsSection()].filter(
      (x): x is HTMLElement => x !== null,
    ),
  );
  window.scrollTo(0, scrollY);
}

async function main(): Promise<void> {
  settings = await loadSettings();
  const toggle = document.getElementById('enabled') as HTMLInputElement;
  toggle.checked = settings.enabled;
  toggle.addEventListener('change', () => {
    settings.enabled = toggle.checked;
    save();
  });
  onSettingsChanged((next) => {
    // Changes made in the popup or another settings tab.
    if (saveTimer || JSON.stringify(next) === JSON.stringify(settings)) return;
    settings = next;
    toggle.checked = settings.enabled;
    void render();
  });
  await render();
}

void main();
