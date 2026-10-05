import { describe, expect, it } from 'vitest';
import { Scheduler } from '../src/background/scheduler';
import type { DecideResult } from '../src/shared/messages';

const ok: DecideResult = { ok: true, answers: {}, model: 'm', ms: 1, truncated: false };
const busy: DecideResult = { ok: false, error: { kind: 'busy', message: 'busy' } };

function deferred() {
  let resolve!: (r: DecideResult) => void;
  const promise = new Promise<DecideResult>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Scheduler', () => {
  it('runs at most `concurrency` jobs at once', async () => {
    const s = new Scheduler({ start: 2 });
    const jobs = [deferred(), deferred(), deferred()];
    let started = 0;
    const results = jobs.map((d) => s.submit(() => (started++, d.promise)));
    expect(started).toBe(2);
    jobs[0]!.resolve(ok);
    await results[0];
    await Promise.resolve();
    expect(started).toBe(3);
    jobs[1]!.resolve(ok);
    jobs[2]!.resolve(ok);
    await Promise.all(results);
  });

  it('serves the closest posts first', async () => {
    const s = new Scheduler({ start: 1 });
    const gate = deferred();
    const order: number[] = [];
    const first = s.submit(() => gate.promise, 0);
    const rest = [500, 20, 90].map((p) => s.submit(async () => (order.push(p), ok), p));
    gate.resolve(ok);
    await Promise.all([first, ...rest]);
    expect(order).toEqual([20, 90, 500]);
  });

  it('grows while answers are fast and halves when the server is busy', async () => {
    let t = 0;
    const s = new Scheduler({ start: 2, max: 4, now: () => t });
    for (let i = 0; i < 2; i++) await s.submit(async () => ok);
    expect(s.concurrency).toBe(3);
    await s.submit(async () => busy);
    expect(s.concurrency).toBe(1);
    expect(s.status().lastError?.kind).toBe('busy');
    t = 10_000;
  });
});
