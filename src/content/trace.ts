import type { DecideMeta } from '../shared/messages';

/** One request for one post. Times are Date.now() values. */
export interface Attempt {
  checks: string[];
  /** The page sent the post to the background worker. */
  askedAt: number;
  /** The page got the result back. */
  doneAt?: number;
  /** The result was drawn on the post. */
  shownAt?: number;
  ok?: boolean;
  error?: string;
  model?: string;
  truncated?: boolean;
  meta?: DecideMeta;
}

/** Everything known about one post, for test mode. */
export interface Trace {
  id: string;
  text: string;
  media: string[];
  hasQuote: boolean;
  /** First time the post's text was in the page. */
  foundAt: number;
  /** First time at least half the post was on screen. */
  onScreenAt?: number;
  /** Total time on screen, while the tab was visible. */
  visibleMs: number;
  visibleSince?: number;
  skip: string | null;
  attempts: Attempt[];
  /** Failed requests since the last success or settings change. */
  failures: number;
  outcome?: string;
  /** passed, hidden or action: picks the panel color. */
  outcomeKind?: 'pass' | 'hidden' | 'action';
  actions: { kind: string; rule: string; at: number }[];
}

const MAX = 3000;
const traces = new Map<string, Trace>();

export function traceFor(id: string, init: () => Omit<Trace, 'id'>): Trace {
  let t = traces.get(id);
  if (!t) {
    t = { id, ...init() };
    traces.set(id, t);
    if (traces.size > MAX) traces.delete(traces.keys().next().value!);
  }
  return t;
}

export function getTrace(id: string): Trace | undefined {
  return traces.get(id);
}

export function allTraces(): Trace[] {
  return Array.from(traces.values());
}

export function clearFailures(): void {
  for (const t of traces.values()) t.failures = 0;
}

/** Updates on-screen time from the share of the post inside the viewport. */
export function markVisibility(t: Trace, ratio: number, now = Date.now()): void {
  const visible = ratio >= 0.5 && !document.hidden;
  if (visible) {
    t.onScreenAt ??= now;
    t.visibleSince ??= now;
  } else if (t.visibleSince !== undefined) {
    t.visibleMs += now - t.visibleSince;
    t.visibleSince = undefined;
  }
}

export function visibleMsNow(t: Trace, now = Date.now()): number {
  return t.visibleMs + (t.visibleSince !== undefined ? now - t.visibleSince : 0);
}
