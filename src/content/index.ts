import { ext } from '../shared/ext';
import type { DecideResult, ReserveResult, Request } from '../shared/messages';
import { activeChecks, checkIdsOf, checkKey, decide, toQuestion, type Answers } from '../shared/rules';
import { loadSettings, onSettingsChanged } from '../shared/settings';
import type { Check, NoulQuestion, PostState, Rule, Settings } from '../shared/types';
import { ActionRunner, type AutoAction } from './actions';
import { focalPostId, pageKind, readPost, SEL } from './dom';
import { flash, hide, reset, setChecking } from './view';

const CACHE_MAX = 3000;
/** Pause after an error before asking the server again. */
const ERROR_PAUSE_MS = 10_000;

let settings: Settings;
let checks: Check[] = [];
/** Answers per post, keyed by checkKey so edited questions get asked again. */
const answers = new Map<string, Map<string, number>>();
const inFlight = new Map<string, Set<string>>();
const revealed = new Set<string>();
const countedHidden = new Set<string>();
let pausedUntil = 0;

const send = <T>(msg: Request): Promise<T> => ext.runtime.sendMessage(msg) as Promise<T>;

const runner = new ActionRunner({
  settings: () => settings,
  findCell: (postId) => document.querySelector<HTMLElement>(`${SEL.cell}[data-cf-id="${postId}"]`),
  reserve: (kind) => send<ReserveResult>({ type: 'reserve', action: kind }),
  release: (kind) => void send({ type: 'release', action: kind }),
  done: (cell, kind, ruleName) =>
    flash(cell, `${kind === 'like' ? 'Liked' : 'Bookmarked'}: ${ruleName}`, settings.display.animation),
  log: (message) => console.info(`[clever-filter] ${message}`),
});

function remember(postId: string, key: string, p: number): void {
  let m = answers.get(postId);
  if (!m) {
    m = new Map();
    answers.set(postId, m);
    if (answers.size > CACHE_MAX) answers.delete(answers.keys().next().value!);
  }
  m.set(key, p);
}

/** Answers for the current checks, keyed by check id, as the rule engine reads them. */
function answersFor(postId: string): Answers {
  const known = answers.get(postId);
  const out: Answers = {};
  if (!known) return out;
  for (const c of checks) {
    const p = known.get(checkKey(c));
    if (p !== undefined) out[c.id] = p;
  }
  return out;
}

function detailFor(rule: Rule, a: Answers): string {
  const ids = checkIdsOf(rule.root);
  const parts = checks
    .filter((c) => ids.has(c.id) && a[c.id] !== undefined)
    .map((c) => `${c.name}: ${Math.round(a[c.id]! * 100)}%`);
  return `Rule "${rule.name}". ${parts.join(' · ')}`;
}

function toggleReveal(postId: string): void {
  if (revealed.has(postId)) revealed.delete(postId);
  else revealed.add(postId);
  scheduleScan();
}

function apply(cell: HTMLElement, postId: string): void {
  setChecking(cell, false);
  cell.dataset.cfState = 'done';
  const a = answersFor(postId);
  const outcome = decide(settings, a);
  if (outcome.hide) {
    const rule = outcome.hide;
    hide(
      cell,
      {
        ruleName: rule.name,
        detail: detailFor(rule, a),
        style: settings.display.hiddenStyle,
        animate: settings.display.animation,
      },
      revealed.has(postId),
      () => toggleReveal(postId),
    );
    if (!countedHidden.has(postId)) {
      countedHidden.add(postId);
      void send({ type: 'count', field: 'hidden' });
    }
  } else if (cell.dataset.cfView) {
    reset(cell);
    cell.dataset.cfState = 'done';
  }
  const visible = !outcome.hide || revealed.has(postId);
  const wanted: [AutoAction, Rule | undefined][] = [
    ['like', outcome.like],
    ['bookmark', outcome.bookmark],
  ];
  for (const [kind, rule] of wanted) {
    if (rule && visible) {
      runner.want(postId, kind, rule.name);
      wantedActions.add(`${kind}:${postId}`);
    }
  }
}

let wantedActions = new Set<string>();

interface Job {
  cell: HTMLElement;
  postId: string;
  state: PostState;
  missing: Check[];
  distance: number;
}

async function request(job: Job): Promise<void> {
  const keys = job.missing.map(checkKey);
  const flying = inFlight.get(job.postId) ?? new Set<string>();
  for (const k of keys) flying.add(k);
  inFlight.set(job.postId, flying);
  setChecking(job.cell, true);

  const questions: Record<string, NoulQuestion> = {};
  for (const c of job.missing) questions[c.id] = toQuestion(c);
  let result: DecideResult;
  try {
    result = await send<DecideResult>({ type: 'decide', state: job.state, questions, priority: job.distance });
  } catch (err) {
    result = { ok: false, error: { kind: 'server', message: String(err) } };
  }
  for (const k of keys) flying.delete(k);
  if (flying.size === 0) inFlight.delete(job.postId);

  if (result.ok) {
    job.missing.forEach((c, i) => {
      const p = result.ok ? result.answers[c.id] : undefined;
      if (p !== undefined) remember(job.postId, keys[i]!, p);
    });
  } else {
    pausedUntil = Date.now() + (result.error.kind === 'busy' ? 3000 : ERROR_PAUSE_MS);
    console.warn(`[clever-filter] ${result.error.message}`);
    if (job.cell.dataset.cfId === job.postId) setChecking(job.cell, false);
    setTimeout(scheduleScan, pausedUntil - Date.now() + 50);
  }
  scheduleScan();
}

function clearAll(): void {
  for (const cell of Array.from(document.querySelectorAll<HTMLElement>(`${SEL.cell}[data-cf-id]`))) {
    reset(cell);
    delete cell.dataset.cfId;
  }
  runner.clear();
}

function scan(): void {
  scanTimer = null;
  if (!settings) return;
  const root = document.documentElement;
  if (settings.display.animation) root.dataset.cfAnimate = '';
  else delete root.dataset.cfAnimate;

  const kind = pageKind(location.pathname);
  const active = settings.enabled && kind !== 'other' && settings.pages[kind] && checks.length > 0;
  if (!active) {
    clearAll();
    return;
  }
  const focal = focalPostId(location.pathname);
  const jobs: Job[] = [];
  const now = Date.now();
  const mid = innerHeight / 2;
  wantedActions = new Set();

  for (const cell of Array.from(document.querySelectorAll<HTMLElement>(SEL.cell))) {
    const article = cell.querySelector(SEL.tweet);
    const info = article ? readPost(article) : null;
    if (!info) {
      if (cell.dataset.cfId) {
        reset(cell);
        delete cell.dataset.cfId;
      }
      continue;
    }
    if (cell.dataset.cfId !== info.id) {
      reset(cell);
      cell.dataset.cfId = info.id;
    }
    if (info.promoted || info.id === focal || !info.state.post.trim()) continue;

    const known = answers.get(info.id);
    const flying = inFlight.get(info.id);
    const missing = checks.filter((c) => {
      const k = checkKey(c);
      return !known?.has(k) && !flying?.has(k);
    });
    const waiting = checks.some((c) => !known?.has(checkKey(c)));
    if (!waiting) {
      apply(cell, info.id);
      continue;
    }
    if (flying?.size) setChecking(cell, true);
    if (missing.length && now >= pausedUntil) {
      const r = cell.getBoundingClientRect();
      jobs.push({
        cell,
        postId: info.id,
        state: info.state,
        missing,
        distance: Math.round(Math.abs((r.top + r.bottom) / 2 - mid)),
      });
    }
  }
  runner.keepOnly(wantedActions);
  jobs.sort((a, b) => a.distance - b.distance);
  for (const job of jobs) void request(job);
}

let scanTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScan(): void {
  if (scanTimer === null) scanTimer = setTimeout(scan, 80);
}

function useSettings(s: Settings): void {
  const before = settings ? JSON.stringify(settings.backend) : null;
  settings = s;
  checks = activeChecks(s);
  if (before !== null && before !== JSON.stringify(s.backend)) {
    // Another model answers now; earlier numbers do not carry over.
    answers.clear();
    countedHidden.clear();
    pausedUntil = 0;
  }
  scheduleScan();
}

async function main(): Promise<void> {
  useSettings(await loadSettings());
  onSettingsChanged(useSettings);
  new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });
  addEventListener('popstate', scheduleScan);
}

void main();
