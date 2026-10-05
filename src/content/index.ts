import { ext } from '../shared/ext';
import type { DecideResult, ReserveResult, Request } from '../shared/messages';
import { activeChecks, checkIdsOf, checkKey, decide, toQuestion, type Answers } from '../shared/rules';
import { loadSettings, onSettingsChanged } from '../shared/settings';
import type { Check, NoulQuestion, PostState, Rule, Settings } from '../shared/types';
import { ActionRunner, visibleRatio, type AutoAction } from './actions';
import { pageKind, readPost, SEL } from './dom';
import { startPanels, stopPanels } from './panel';
import { allTraces, clearFailures, getTrace, markVisibility, traceFor, type Attempt, type Trace } from './trace';
import { flash, hide, reset, setChecking } from './view';

const CACHE_MAX = 3000;
/** Pause after an error before asking the server again. */
const ERROR_PAUSE_MS = 10_000;
/** A post stops being retried after this many failed requests in a row. */
const MAX_FAILURES = 3;
/**
 * The page gives up on an answer after this long. The background worker already times out each
 * HTTP attempt; this also covers a background worker the browser shut down mid-request.
 */
const CLIENT_TIMEOUT_MS = 60_000;

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
  done: (cell, kind, ruleName) => {
    const postId = cell.dataset.cfId;
    const t = postId ? getTrace(postId) : undefined;
    if (t) {
      t.actions.push({ kind: kind === 'like' ? 'liked' : 'bookmarked', rule: ruleName, at: Date.now() });
      t.outcome = `${kind === 'like' ? 'Liked' : 'Bookmarked'}: ${ruleName}`;
      t.outcomeKind = 'action';
    }
    flash(cell, `${kind === 'like' ? 'Liked' : 'Bookmarked'}: ${ruleName}`, settings.display.animation);
  },
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

let wantedActions = new Set<string>();

function apply(cell: HTMLElement, postId: string, trace: Trace): void {
  setChecking(cell, false);
  cell.dataset.cfState = 'done';
  const a = answersFor(postId);
  const outcome = decide(settings, a);
  const last = trace.attempts.at(-1);
  if (last?.ok && last.shownAt === undefined) {
    last.shownAt = Date.now();
    if (settings.test.panels) console.debug('[clever-filter]', postId, a, trace);
  }
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
    trace.outcome = `Hidden: ${rule.name}`;
    trace.outcomeKind = 'hidden';
    if (!countedHidden.has(postId)) {
      countedHidden.add(postId);
      void send({ type: 'count', field: 'hidden' });
    }
  } else {
    if (cell.dataset.cfView) {
      reset(cell);
      cell.dataset.cfState = 'done';
    }
    if (trace.outcomeKind !== 'action') {
      trace.outcome = 'Checked: passed';
      trace.outcomeKind = 'pass';
    }
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

interface Job {
  cell: HTMLElement;
  postId: string;
  state: PostState;
  missing: Check[];
  distance: number;
  trace: Trace;
}

/** Resolves with `fallback()` when `p` takes longer than `ms`. `p` must not reject. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    void p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

async function request(job: Job): Promise<void> {
  const keys = job.missing.map(checkKey);
  const flying = inFlight.get(job.postId) ?? new Set<string>();
  for (const k of keys) flying.add(k);
  inFlight.set(job.postId, flying);
  setChecking(job.cell, true);

  const attempt: Attempt = { checks: job.missing.map((c) => c.name), askedAt: Date.now() };
  job.trace.attempts.push(attempt);
  if (job.trace.attempts.length > 20) job.trace.attempts.shift();

  const questions: Record<string, NoulQuestion> = {};
  for (const c of job.missing) questions[c.id] = toQuestion(c);
  const result = await withTimeout<DecideResult>(
    send<DecideResult>({ type: 'decide', state: job.state, questions, priority: job.distance }).catch(
      (err): DecideResult => ({ ok: false, error: { kind: 'server', message: `The background worker did not answer: ${String(err)}` } }),
    ),
    CLIENT_TIMEOUT_MS,
    (): DecideResult => ({ ok: false, error: { kind: 'timeout', message: `No answer after ${CLIENT_TIMEOUT_MS / 1000} seconds.` } }),
  );
  for (const k of keys) flying.delete(k);
  if (flying.size === 0) inFlight.delete(job.postId);

  attempt.doneAt = Date.now();
  attempt.ok = result.ok;
  attempt.meta = result.meta;
  if (result.ok) {
    attempt.model = result.model;
    attempt.truncated = result.truncated;
    job.trace.failures = 0;
    job.missing.forEach((c, i) => {
      const p = result.answers[c.id];
      if (p !== undefined) remember(job.postId, keys[i]!, p);
    });
  } else {
    attempt.error = result.error.message;
    job.trace.failures++;
    pausedUntil = Date.now() + (result.error.kind === 'busy' ? 3000 : ERROR_PAUSE_MS);
    console.warn(`[clever-filter] post ${job.postId}: ${result.error.message}`);
    if (job.cell.dataset.cfId === job.postId) setChecking(job.cell, false);
    setTimeout(scheduleScan, pausedUntil - Date.now() + 50);
  }
  scheduleScan(0);
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
  // Replies under a post are left alone for now.
  const active =
    settings.enabled && kind !== 'other' && kind !== 'replies' && settings.pages[kind] && checks.length > 0;
  if (!active) {
    clearAll();
    return;
  }
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
    const trace = traceFor(info.id, () => ({
      text: info.state.post,
      media: info.media,
      hasQuote: info.hasQuote,
      foundAt: now,
      visibleMs: 0,
      skip: info.skip,
      attempts: [],
      failures: 0,
      actions: [],
    }));
    // X fills in a post in steps; keep the latest reading until the post is asked about.
    if (trace.attempts.length === 0) {
      trace.text = info.state.post;
      trace.media = info.media;
      trace.hasQuote = info.hasQuote;
      trace.skip = info.skip;
    }
    if (settings.test.panels) markVisibility(trace, visibleRatio(cell.getBoundingClientRect(), innerHeight), now);
    if (info.skip) {
      setChecking(cell, false);
      if (cell.dataset.cfView) reset(cell);
      cell.dataset.cfState = 'skipped';
      continue;
    }

    const known = answers.get(info.id);
    const flying = inFlight.get(info.id);
    const missing = checks.filter((c) => {
      const k = checkKey(c);
      return !known?.has(k) && !flying?.has(k);
    });
    const waiting = checks.some((c) => !known?.has(checkKey(c)));
    if (!waiting) {
      apply(cell, info.id, trace);
      continue;
    }
    if (trace.failures >= MAX_FAILURES) {
      // Gave up on this post until the settings change; leave it as X shows it.
      setChecking(cell, false);
      cell.dataset.cfState = 'failed';
      continue;
    }
    setChecking(cell, Boolean(flying?.size));
    if (missing.length && now >= pausedUntil) {
      const r = cell.getBoundingClientRect();
      jobs.push({
        cell,
        postId: info.id,
        state: info.state,
        missing,
        distance: Math.round(Math.abs((r.top + r.bottom) / 2 - mid)),
        trace,
      });
    }
  }
  runner.keepOnly(wantedActions);
  jobs.sort((a, b) => a.distance - b.distance);
  for (const job of jobs) void request(job);
}

let scanTimer: ReturnType<typeof setTimeout> | null = null;

/** Runs a scan soon. Page changes wait 80 ms so a burst of them costs one scan; answers go at once. */
function scheduleScan(delay = 80): void {
  if (scanTimer !== null) {
    if (delay > 0) return;
    clearTimeout(scanTimer);
  }
  scanTimer = setTimeout(scan, delay);
}

/** Test mode measures time on screen, which needs a look on every scroll. */
let scrollQueued = false;
function onScroll(): void {
  if (!settings?.test.panels || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    const now = Date.now();
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>(`${SEL.cell}[data-cf-id]`))) {
      const t = getTrace(cell.dataset.cfId!);
      if (t) markVisibility(t, visibleRatio(cell.getBoundingClientRect(), innerHeight), now);
    }
  });
}

const panelHost = {
  settings: () => settings,
  checks: () => settings.checks,
  activeChecks: () => checks,
  answers: answersFor,
  trace: getTrace,
  revealed: (id: string) => revealed.has(id),
  maxFailures: MAX_FAILURES,
};

function useSettings(s: Settings): void {
  const before = settings ? JSON.stringify(settings.backend) : null;
  settings = s;
  checks = activeChecks(s);
  clearFailures();
  if (before !== null && before !== JSON.stringify(s.backend)) {
    // Another model answers now; earlier numbers do not carry over.
    answers.clear();
    countedHidden.clear();
    pausedUntil = 0;
  }
  if (s.test.panels) startPanels(panelHost);
  else stopPanels();
  scheduleScan();
}

async function main(): Promise<void> {
  useSettings(await loadSettings());
  onSettingsChanged(useSettings);
  new MutationObserver(() => scheduleScan()).observe(document.body, { childList: true, subtree: true });
  addEventListener('popstate', () => scheduleScan());
  addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onScroll);
  // Debugging: run cleverFilterTraces() in the console, with the extension's context selected.
  (window as unknown as { cleverFilterTraces?: () => Trace[] }).cleverFilterTraces = allTraces;
}

void main();
