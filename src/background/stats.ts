import { ext } from '../shared/ext';
import type { DayStats } from '../shared/types';

export function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function empty(): DayStats {
  return { date: today(), checked: 0, hidden: 0, liked: 0, bookmarked: 0 };
}

let chain: Promise<unknown> = Promise.resolve();

/** Runs updates one after another so two tabs never overwrite each other's counts. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function read(): Promise<DayStats> {
  const { stats } = await ext.storage.local.get('stats');
  const s = stats as DayStats | undefined;
  return s && s.date === today() ? s : empty();
}

export function getStats(): Promise<DayStats> {
  return serial(read);
}

export function bump(field: keyof Omit<DayStats, 'date'>, by = 1): Promise<DayStats> {
  return serial(async () => {
    const s = await read();
    s[field] = Math.max(0, s[field] + by);
    await ext.storage.local.set({ stats: s });
    return s;
  });
}

/** Counts an action against today's limit. Returns false when the limit is reached. */
export function reserve(field: 'liked' | 'bookmarked', limit: number): Promise<boolean> {
  return serial(async () => {
    const s = await read();
    if (s[field] >= limit) return false;
    s[field] += 1;
    await ext.storage.local.set({ stats: s });
    return true;
  });
}
